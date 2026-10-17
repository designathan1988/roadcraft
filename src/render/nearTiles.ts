import { Box3, type Frustum } from 'three';
import { Digest } from '@core/digest';
import { worldKey } from '@world/cityGen/wholeMap';
import type { TileRecords } from '@world/doc';
import { TILE, tileKey, tileOfKey } from '@world/tiles';
import { m } from '@world/units';
import { canQueueJobs, focusDistance, jobWorkers, submitJob } from '../jobs/jobPool';
import { EDIT_TIER, NEAR_TIER, TIER_SPAN } from './buildings/cellPool';
import { emptyRecords } from './buildings/farGrid';
import { HYSTERESIS, type Seen, measureSeen } from './buildings/massCells';
import { forgetOtherDerived } from './derivedCache';
import type { FarTileSource, FarTiles } from './farTree';
import type { GroundRecord } from './groundChanges';
import { type NearGround, type NearKind, type NearLanded, type NearPart, type NearProduct, type NearTileCache, type NearTileJob, type NearTileReply, NEAR_GROUND_REACH, partsDigest } from './nearTileBake';
import { nearParts, nearReadParts, nearReadsAround, runNearJob } from './nearBakers';
import { nearSig } from './nearRoadTiles';

/** THE NEAR PRODUCTS PER TILE, CHOSEN BY THE VIEW (plan step 5): each kind (poles, furniture, signs...) of each stored tile baked in a worker from the tile store (`nearTileBake.ts`), drawn where what it draws spans a pixel, the bake drawn standing until the next one lands; every tile one way, the page's region too (an edited tile from the page's records, `FarTileSource.pageEdit`) */
/** DO NOT make them from the region's document again: three tiles left the region and three came in at every tile's edge the camera crossed, their poles, furniture and signs let go and made again on the page, in the move's frames (plan 2.4.1). */

declare const __NEAR_TILES_HASH__: string | undefined;
/** The fingerprint of the code the near products are baked by (`cook-plugin.ts`): bakes are kept under it; none (tests): nothing kept. */
const NEAR_HASH = typeof __NEAR_TILES_HASH__ !== 'undefined' && __NEAR_TILES_HASH__ ? __NEAR_TILES_HASH__ : null;
const NEAR_PREFIX = NEAR_HASH ? `nearTiles:${NEAR_HASH}:` : null;

export type { NearLanded, NearProduct };

/** Runs a near job and answers once; gives back its cancel (an answer cancelled is never given). */
export type NearRun = (job: NearTileJob, done: (reply: NearTileReply) => void) => () => void;

/** A kind of a tile as drawn: the bake drawn and the ask it answered, the one on its way (to the GPU), the ask waiting for its answer (and the version of what it reads), a failed one. */
interface Slot {
  landed: NearLanded | null;
  /** The bake drawn (null: none yet); its ask. */
  bake: string | null;
  sig: string | null;
  coming: NearLanded | null;
  asked: string | null;
  want: string;
  /** The ask is of an edit of what the kind reads (its parts changed, not a building grown): baked before anything. */
  urgent: boolean;
  failed: string | null;
}

/** An edited tile cut to what a kind reads: its records (every part the kind may read) and the digest of the parts it always reads; whether that digest moved with the last edit. */
interface PageCut {
  readonly records: Partial<TileRecords>;
  readonly digest: string;
  readonly changed: boolean;
}

/** A stored tile: its place and version, each kind's slot, and its job under way (every kind asked of it, `NearTileJob`). */
interface Leaf {
  readonly key: number;
  readonly i: number;
  readonly j: number;
  version: number;
  readonly slots: Map<NearKind, Slot>;
  job: { readonly job: NearTileJob; readonly cancel: () => void } | null;
}

/** The tiles a kind of a tile reads (the tile first), each at its version or, held edited by the page, at what the kind reads of it (`PageCut`), and the version of them all. */
interface TilesRead {
  readonly tiles: readonly { readonly key: number; readonly version: number; readonly cut: PageCut | null }[];
  readonly sig: string;
}

/** The eye the tiles were last chosen for. */
interface Eye { x: number; y: number; z: number; pxAtMetre: number; orthoPx: number | null; reach: number }

/** A tile's records cut to the parts a kind reads (what the page posts of a tile it holds edited: never its buildings to a kind that reads none). */
export function recordsFor(records: TileRecords, parts: readonly NearPart[]): Partial<TileRecords> {
  const out: Record<string, unknown> = { key: records.key, version: records.version };
  for (const part of parts) {
    if (part === 'roads') Object.assign(out, { nodes: records.nodes, borrowedNodes: records.borrowedNodes, segments: records.segments, ...(records.gates ? { gates: records.gates } : {}) });
    else if (part === 'buildings') Object.assign(out, { buildings: records.buildings, lots: records.lots, ...(records.grown ? { grown: records.grown } : {}) });
    else {
      Object.assign(out, {
        poles: records.poles, borrowedPoles: records.borrowedPoles, poleSpans: records.poleSpans, lotKeys: records.lotKeys, landscape: records.landscape,
        barriers: records.barriers, paint: records.paint, trees: records.trees, elements: records.elements, next: records.next,
      });
    }
  }
  return out as Partial<TileRecords>;
}

/** THE NEAR PRODUCTS' BAND IN THE QUEUE: after the buildings' cells and masses and the roads' near level (`cellPool.ts` NEAR_TIER), nearest first within it: furniture, poles and the rest refine a street whose roads and buildings come first. DO NOT share the roads' band: eight kinds a tile, out to kilometres, held the street's near roads behind them and the street stood on its far level (conf22 09-street, 2026-10-17). */
const PRODUCT_TIER = NEAR_TIER + 0.05;

/** A near job's place in the queue (`jobPool.ts`: lower first, the distance to the view's focus added within a band): an edit of what its kinds read before anything (`cellPool.ts` EDIT_TIER), else after the cells, the masses and the roads' near level (`PRODUCT_TIER`). */
export const nearPriority = (job: Pick<NearTileJob, 'edited'>): number => (job.edited ? EDIT_TIER : PRODUCT_TIER) * TIER_SPAN;

/** The page's own cache of bakes where no worker runs (tests): nothing kept. */
const NO_CACHE: NearTileCache = { ready: async () => false, get: async () => undefined, put: async () => {} };

/** A job handed to the queue: its cancel (an answer cancelled is never given). */
type Ticket = { cancel(): void };

/** THE NEAR JOBS ON A FEW WORKERS AT ONCE: a third of the pool at most (`share`), the rest always free for the cells and the roads' near level; the waiting jobs here, an edit of what they read first, then the nearest to where the view looks
 *  - DO NOT hand them all to the queue: a job a worker has begun runs to its end, and tiles of near products each seconds long held every worker while the street's cells and roads asked after them waited (conf26 09-street, 2026-10-17; the queue's bands order what waits, not what runs). */
export class NearGate {
  private readonly waiting: { readonly job: NearTileJob; readonly send: () => Ticket; ticket: Ticket | null }[] = [];
  private running = 0;

  /** `most`: the jobs on workers at once; `away`: a job's distance to the view's focus. */
  constructor(private readonly most: () => number, private readonly away: (job: NearTileJob) => number) {}

  /** A job to send once a place is free (`send` hands it to the queue, and its answer must come back through `settle`); its cancel. */
  ask(job: NearTileJob, send: () => Ticket): () => void {
    const entry = { job, send, ticket: null as Ticket | null };
    this.waiting.push(entry);
    this.pump();
    return () => {
      const at = this.waiting.indexOf(entry);
      if (at >= 0) { this.waiting.splice(at, 1); return; }
      if (entry.ticket) { entry.ticket.cancel(); entry.ticket = null; this.settle(); }
    };
  }

  /** A job sent came back (answered or failed): its place free for the next. */
  settle(): void {
    this.running = Math.max(0, this.running - 1);
    this.pump();
  }

  /** Jobs waiting here (not yet on a worker). */
  get queued(): number {
    return this.waiting.length;
  }

  private pump(): void {
    while (this.running < this.most() && this.waiting.length) {
      let best = 0;
      for (let k = 1; k < this.waiting.length; k++) {
        const a = this.waiting[k]!.job, b = this.waiting[best]!.job;
        if (Number(!!a.edited) > Number(!!b.edited) || (!!a.edited === !!b.edited && this.away(a) < this.away(b))) best = k;
      }
      const [entry] = this.waiting.splice(best, 1);
      this.running++;
      entry!.ticket = entry!.send();
    }
  }
}

/** DO NOT bake on the page: the jobs go to the job system's queue (`nearTiles` service) through the gate (`NearGate`), the page only when no worker can run (tests). */
function nearRunner(): NearRun {
  const centre = (job: NearTileJob): readonly [number, number] => {
    const { i, j } = tileOfKey(job.tiles[0]!.key);
    return [(i + 0.5) * TILE, (j + 0.5) * TILE];
  };
  const gate = new NearGate(() => Math.max(1, Math.floor(jobWorkers() / 3)), (job) => { const [x, y] = centre(job); return focusDistance(x, y); });
  return (job, done) => {
    if (!canQueueJobs()) {
      let live = true;
      void runNearJob(job, NO_CACHE).then(
        (reply) => { if (live) done(reply); },
        (error: unknown) => { if (live) done({ kind: 'nearError', node: job.node, message: String(error) }); },
      );
      return () => { live = false; };
    }
    return gate.ask(job, () => submitJob({
      service: 'nearTiles',
      key: `nearTiles:${job.node}`,
      // An edit of what its kinds read first (`cellPool.ts` EDIT_TIER): what the player just did; the others after the cells and the roads' near level, nearest first (`PRODUCT_TIER`).
      priority: nearPriority(job),
      at: centre(job),
      write: () => ({ data: job, transfer: [] }),
      done: (answer) => { gate.settle(); done(answer as NearTileReply); },
      failed: (message) => { gate.settle(); done({ kind: 'nearError', node: job.node, message }); },
    }));
  };
}

/** THE NEAR PRODUCTS' CHOICE OF TILES: told the stored tiles as the far levels are (`FarTiles`), chosen each frame by the view (`choose`) */
export class NearTiles implements FarTiles {
  private source: FarTileSource | null = null;
  private world = '';
  private readonly leaves = new Map<number, Leaf>();
  private readonly products: NearProduct[] = [];
  /** Each kind's tiles drawn or on their way. */
  private readonly held = new Map<NearKind, Set<Leaf>>();
  private ground: () => NearGround = () => ({ ground: null, naturalIsGround: true });
  /** Where the drawn ground changed (`setGround`): the tiles it reached asked again (their bakes read it, `groundDigest`). */
  private groundRecord: GroundRecord | null = null;
  private groundSeen = 0;
  private groundEverywhere = 0;
  private readonly groundOf = new Map<number, number>();
  private groundSerial = 0;
  private scale = 1;
  private readonly seen: Seen = { perMetre: 0, allowed: 0, across: 0 };
  private readonly eyeNow: Eye = { x: 0, y: 0, z: 0, pxAtMetre: 0, orthoPx: null, reach: Infinity };
  private eye: Eye | null = null;
  private view: Frustum | null = null;
  private readonly viewBox = new Box3();
  private scheduled = false;
  private warned = false;
  /** Each tile's tiles read and their version, by what a kind reads (alone or with its neighbours, and its parts), worked out once a choice for every kind (`tilesOf`). */
  private readonly reads = new Map<string, TilesRead>();
  /** Each edited tile's records as the page holds them, by the edit they are of, and cut to each set of parts: DO NOT read the page's document again for every kind, every neighbour or every frame (`tileMembers` walks the region's document; a road drawn held frames of 500 ms, conf23, 2026-10-17). */
  private readonly pageCuts = new Map<number, { readonly edit: number; readonly records: TileRecords | null; readonly cuts: Map<string, PageCut> }>();
  /** Each tile's last digest by set of parts: whether an edit moved what a kind reads. */
  private readonly lastDigests = new Map<string, string>();
  /** Each record's digest, once a record (`partsDigest`). */
  private readonly recordDigests = new WeakMap<object, number>();
  /** The tiles with a kind asked this choice: one job each once every kind is chosen (`submit`). */
  private readonly asking = new Set<Leaf>();

  /** `run`, `prefix`: where the jobs go and the bakes are kept (tests give their own). */
  constructor(private readonly run: NearRun = nearRunner(), private readonly prefix: string | null = NEAR_PREFIX) {
    // The bakes of an older build of this code: let go.
    if (prefix !== null && prefix === NEAR_PREFIX && NEAR_HASH) forgetOtherDerived('nearTiles', NEAR_HASH);
  }

  /** A kind drawn per tile from now on. */
  add(product: NearProduct): void {
    this.products.push(product);
    this.held.set(product.kind, new Set());
  }

  /** The ground the bakes read (`renderer.ts`: the terrain's shared plates) and where it changed. */
  setGround(ground: () => NearGround, record: GroundRecord | null): void {
    this.ground = ground;
    this.groundRecord = record;
    this.groundSeen = record?.version ?? 0;
  }

  /** The tiles whose `kind` is drawn now, by key. */
  heldKeys(kind: NearKind): number[] {
    return [...(this.held.get(kind) ?? [])].filter((l) => l.slots.get(kind)?.landed).map((l) => l.key);
  }

  setSource(source: FarTileSource | null, _isLoaded: (tileKey: number) => boolean): void {
    const plan = source?.plan ?? null;
    // The plan's version and the map's size in it (`worldKey`): bakes of an older plan never read for this one.
    const world = plan ? `${new Digest().addPlain(plan).value().toString(36)}.${worldKey(plan.seed)}` : '';
    if (world !== this.world || source === null) {
      for (const leaf of this.leaves.values()) for (const product of this.products) this.drop(leaf, product.kind);
      if (source === null) this.leaves.clear();
      this.world = world;
    }
    this.source = source;
  }

  stored(tile: number, version: number | null): void {
    const leaf = this.leaves.get(tile);
    if (version === null) {
      if (!leaf) return;
      for (const product of this.products) this.drop(leaf, product.kind);
      this.leaves.delete(tile);
      return;
    }
    if (leaf) { leaf.version = version; return; }
    const { i, j } = tileOfKey(tile);
    this.leaves.set(tile, { key: tile, i, j, version, slots: new Map(), job: null });
  }

  /** Every tile is drawn here, the page's region's too: nothing changes with its standing. */
  loadedChanged(_tile: number): void {}

  setErrorScale(scale: number): void {
    this.scale = scale;
  }

  get bakePrefix(): string | null {
    return this.prefix === null ? null : this.world ? `${this.prefix}${this.world}:` : this.prefix;
  }

  /** THE TILES DRAWN, kind by kind: those where its largest piece spans a pixel (with hysteresis, as a cell near stays near) and that are in the view or drawn already (DO NOT bake the tiles behind the camera) */
  choose(eyeX: number, eyeY: number, eyeZ: number, pxAtMetre: number, orthoPx: number | null, reach = Infinity, view: Frustum | null = null): void {
    const e = this.eyeNow;
    e.x = eyeX; e.y = eyeY; e.z = eyeZ; e.pxAtMetre = pxAtMetre; e.orthoPx = orthoPx; e.reach = reach;
    this.eye = e;
    this.view = view;
    if (!this.source) return;
    this.groundMoved();
    this.reads.clear();
    for (const product of this.products) this.chooseKind(product);
    // DO NOT send a job a kind: each would read the tiles and solve their roads again; every kind of a tile asked goes in one.
    for (const leaf of this.asking) this.submit(leaf);
    this.asking.clear();
  }

  /** A WebGL context restored: every bake landed again (their arrays were let go once on the GPU). */
  refill(): void {
    for (const leaf of this.leaves.values()) for (const product of this.products) this.drop(leaf, product.kind);
    this.again();
  }

  dispose(): void {
    for (const leaf of this.leaves.values()) for (const product of this.products) this.drop(leaf, product.kind);
    this.leaves.clear();
    this.eye = null;
  }

  /** The tiles the drawn ground changed under since the last look: their serial moved (every tile's when the record cannot say where). */
  private groundMoved(): void {
    const record = this.groundRecord;
    if (!record || record.version === this.groundSeen) return;
    const rects = record.rectsSince ? record.rectsSince(this.groundSeen) : null;
    this.groundSeen = record.version;
    const serial = ++this.groundSerial;
    if (rects === null) { this.groundEverywhere = serial; return; }
    const pad = NEAR_GROUND_REACH;
    for (const r of rects) {
      for (let i = Math.floor((r[0] - pad) / TILE); i <= Math.floor((r[2] + pad) / TILE); i++) {
        for (let j = Math.floor((r[1] - pad) / TILE); j <= Math.floor((r[3] + pad) / TILE); j++) this.groundOf.set(tileKey(i, j), serial);
      }
    }
  }

  private slotOf(leaf: Leaf, kind: NearKind): Slot {
    let slot = leaf.slots.get(kind);
    if (!slot) leaf.slots.set(kind, slot = { landed: null, bake: null, sig: null, coming: null, asked: null, want: '', urgent: false, failed: null });
    return slot;
  }

  /** One kind's tiles: within the distance its largest piece spans a pixel at, those the view wants asked, those it no longer wants let go. */
  private chooseKind(product: NearProduct): void {
    const e = this.eyeNow;
    const kind = product.kind;
    const held = this.held.get(kind)!;
    if (product.enabled && !product.enabled()) {
      for (const leaf of [...held]) this.drop(leaf, kind);
      return;
    }
    // As far as a piece of `cover` spans a pixel, from the eye (with the error scale and the hysteresis), and no farther than the view reaches.
    const far = e.orthoPx !== null ? e.reach : Math.min(e.reach, (Math.sqrt(product.cover) * e.pxAtMetre) / (this.scale * HYSTERESIS));
    const wanted = new Set<Leaf>();
    if (Number.isFinite(far) && far > 0) {
      const i0 = Math.floor((e.x - far) / TILE), i1 = Math.floor((e.x + far) / TILE);
      const j0 = Math.floor((e.y - far) / TILE), j1 = Math.floor((e.y + far) / TILE);
      if ((i1 - i0 + 1) * (j1 - j0 + 1) <= this.leaves.size) {
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
          const leaf = this.leaves.get(tileKey(i, j));
          if (leaf && this.wants(leaf, product, held.has(leaf))) wanted.add(leaf);
        }
      } else for (const leaf of this.leaves.values()) if (this.wants(leaf, product, held.has(leaf))) wanted.add(leaf);
    }
    for (const leaf of [...held]) if (!wanted.has(leaf)) this.drop(leaf, kind);
    for (const leaf of wanted) { held.add(leaf); this.ask(leaf, product); }
  }

  /** Whether the view wants a tile's kind: its largest piece spans a pixel at the tile's nearest point (down to the hysteresis's share once drawn), and it is in the view or drawn already. */
  private wants(leaf: Leaf, product: NearProduct, held: boolean): boolean {
    const e = this.eyeNow;
    const x0 = leaf.i * TILE, y0 = leaf.j * TILE;
    measureSeen(this.seen, e.x, e.y, e.z, e.pxAtMetre, e.orthoPx, x0, y0, x0 + TILE, y0 + TILE, product.top);
    const side = Math.sqrt(product.cover) * this.seen.perMetre / this.scale;
    if (side < (held ? HYSTERESIS : 1)) return false;
    return held || this.inView(leaf, product.top);
  }

  /** Whether a tile's box (from under the ground to the kind's top) meets the camera's frustum; true with none. */
  private inView(leaf: Leaf, top: number): boolean {
    if (!this.view) return true;
    this.viewBox.min.set(leaf.i * TILE, -m(50), -(leaf.j + 1) * TILE);
    this.viewBox.max.set((leaf.i + 1) * TILE, Math.max(top, m(60)), -leaf.j * TILE);
    return this.view.intersectsBox(this.viewBox);
  }

  /** The tile and (where read) its neighbours stored, the tile first, each at its version or, held edited, at the digest of the parts read of it (`pageCut`); and the version of them: an edit of what the parts do not hold (a building grown, for the poles) asks nothing. */
  private tilesOf(leaf: Leaf, around: boolean, read: readonly NearPart[], posted: readonly NearPart[]): TilesRead {
    const memo = `${leaf.key}|${around ? 1 : 0}|${read.join(',')}|${posted.join(',')}`;
    const had = this.reads.get(memo);
    if (had) return had;
    const tiles = [{ key: leaf.key, version: leaf.version, cut: this.pageCut(leaf.key, read, posted) }];
    for (let dj = -1; around && dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        const near = this.leaves.get(tileKey(leaf.i + di, leaf.j + dj));
        if (near) tiles.push({ key: near.key, version: near.version, cut: this.pageCut(near.key, read, posted) });
      }
    }
    const out: TilesRead = { tiles, sig: nearSig(tiles.map((t) => ({ key: t.key, version: t.cut ? `p${t.cut.digest}` : t.version }))) };
    this.reads.set(memo, out);
    return out;
  }

  /** A tile the page holds edited (`FarTileSource.pageEdit`), cut to the parts posted (`posted`) and named by the digest of the parts read (`read`), once an edit; null for one the store holds as the page has it. */
  private pageCut(key: number, read: readonly NearPart[], posted: readonly NearPart[]): PageCut | null {
    const edit = this.source?.pageEdit?.(key) ?? 0;
    if (!edit || !this.source?.pageRecords) { this.pageCuts.delete(key); return null; }
    let known = this.pageCuts.get(key);
    if (!known || known.edit !== edit) this.pageCuts.set(key, known = { edit, records: this.source.pageRecords(key), cuts: new Map() });
    if (!known.records) return null;
    const name = `${read.join(',')}|${posted.join(',')}`;
    let cut = known.cuts.get(name);
    if (!cut) {
      const digest = partsDigest(known.records, read, this.recordDigests);
      const was = this.lastDigests.get(`${key}|${name}`);
      this.lastDigests.set(`${key}|${name}`, digest);
      cut = { records: recordsFor(known.records, posted), digest, changed: was !== undefined && was !== digest };
      known.cuts.set(name, cut);
    }
    return cut;
  }

  /** A tile's kind asked at the version of what it reads, once: its tile's job sent once every kind is chosen. */
  private ask(leaf: Leaf, product: NearProduct): void {
    const slot = this.slotOf(leaf, product.kind);
    const read = nearReadParts(product.kind);
    const { tiles, sig: version } = this.tilesOf(leaf, nearReadsAround(product.kind), read, nearParts(product.kind));
    const want = `${version}:${product.version?.(leaf.key) ?? ''}`;
    const sig = `${want}|${Math.max(this.groundEverywhere, this.groundOf.get(leaf.key) ?? 0)}`;
    if (slot.sig === sig || slot.asked === sig || slot.failed === sig) return;
    slot.asked = sig;
    slot.want = want;
    // DO NOT put every edited tile first: the growth edits the region all the time, and its jobs went before the streets' roads and cells (conf22). An edit of what the kind reads goes first; one of the buildings (the growth's, a garden's) does not.
    slot.urgent = (tiles[0]!.cut?.changed ?? false) && !read.includes('buildings');
    this.asking.add(leaf);
  }

  /** A TILE'S JOB: every kind of it waiting for an answer, the one under way replaced (its kinds asked again in this one); the tiles any of them reads, the page's records of those it holds edited (`records`: of all, where no worker reads the store) */
  private submit(leaf: Leaf, records?: readonly (Partial<TileRecords> | null)[]): void {
    leaf.job?.cancel();
    leaf.job = null;
    const kinds = this.products.filter((p) => leaf.slots.get(p.kind)?.asked);
    if (!kinds.length) return;
    const parts = [...new Set(kinds.flatMap((p) => nearParts(p.kind)))].sort();
    const { tiles } = this.tilesOf(leaf, kinds.some((p) => nearReadsAround(p.kind)), parts, parts);
    // The edited tiles as the page holds them (cut once an edit, `pageCut`): drawn from the edit, not from its write.
    const posted = records ?? (tiles.some((t) => t.cut) ? tiles.map((t) => t.cut?.records ?? null) : undefined);
    const job: NearTileJob = {
      node: `${leaf.i},${leaf.j}`, prefix: this.bakePrefix, tiles: tiles.map((t) => ({ key: t.key, version: t.version })), ground: this.ground(),
      asks: kinds.map((p) => {
        const slot = leaf.slots.get(p.kind)!;
        return { kind: p.kind, sig: slot.asked!, want: slot.want, shown: slot.bake, ...(p.extra ? { extra: p.extra(leaf.key) } : {}) };
      }),
      ...(posted ? { records: posted } : {}),
      ...(kinds.some((p) => leaf.slots.get(p.kind)!.urgent) ? { edited: true } : {}),
      ...(this.source?.workersRead ? { store: this.source.workersRead } : {}),
    };
    const cancel = this.run(job, (reply) => this.answer(leaf, job, reply, parts));
    // A run that answered at once (the tests' page) left nothing under way.
    if (!leaf.job && this.leaves.get(leaf.key) === leaf && job.asks.some((a) => leaf.slots.get(a.kind)?.asked === a.sig)) leaf.job = { job, cancel };
  }

  private answer(leaf: Leaf, job: NearTileJob, reply: NearTileReply, parts: readonly NearPart[]): void {
    if (this.leaves.get(leaf.key) !== leaf || (leaf.job !== null && leaf.job.job !== job)) return;
    leaf.job = null;
    switch (reply.kind) {
      case 'near':
        for (const answer of reply.answers) {
          const slot = leaf.slots.get(answer.kind);
          if (!slot || answer.sig !== slot.asked) continue;
          if ('error' in answer) {
            this.warn(`a tile's ${answer.kind} could not be baked`, answer.error);
            slot.asked = null;
            slot.failed = answer.sig;
          } else if (answer.same) {
            slot.sig = answer.sig;
            slot.asked = null;
          } else this.land(leaf, this.products.find((p) => p.kind === answer.kind)!, slot, answer.payload, answer.bake, answer.sig);
        }
        break;
      case 'nearRecords': {
        // No worker reads the store (the tests, a store the workers cannot open): the page reads the tiles, one empty where the store has none.
        const source = this.source;
        if (!source) break;
        void Promise.all(job.tiles.map((t) => source.records(t.key).then((r) => recordsFor(r ?? emptyRecords(t.key, t.version), parts)))).then((records) => {
          if (this.leaves.get(leaf.key) === leaf && leaf.job === null) this.submit(leaf, records);
        }, (error: unknown) => {
          for (const ask of job.asks) { const slot = leaf.slots.get(ask.kind); if (slot?.asked === ask.sig) { slot.asked = null; slot.failed = ask.sig; } }
          this.warn('a tile could not be read from the store', error);
        });
        return;
      }
      case 'nearError':
        this.warn('a tile\'s near products could not be baked', reply.message);
        for (const ask of job.asks) { const slot = leaf.slots.get(ask.kind); if (slot?.asked === ask.sig) { slot.asked = null; slot.failed = ask.sig; } }
        break;
    }
    this.again();
  }

  /** A bake come (null: nothing of the kind in the tile): put in place of the one drawn once it can be drawn, the one drawn standing until then (never a hole). */
  private land(leaf: Leaf, product: NearProduct, slot: Slot, payload: unknown, bake: string, sig: string): void {
    if (slot.coming) { slot.coming.remove(); slot.coming = null; }
    const landed = payload === null ? null : product.land(payload, leaf.key);
    slot.coming = landed;
    const put = (): void => {
      // A newer bake came meanwhile, or the tile was let go.
      if (slot.coming !== landed || leaf.slots.get(product.kind) !== slot) return;
      slot.coming = null;
      slot.landed?.remove();
      landed?.put();
      slot.landed = landed;
      slot.bake = bake;
      slot.sig = sig;
      if (slot.asked === sig) slot.asked = null;
    };
    if (landed?.ready) void landed.ready.then(put);
    else put();
  }

  /** A tile's kind let go, drawn or coming; its tile's job cancelled once no kind of it waits: asked again when wanted. */
  private drop(leaf: Leaf, kind: NearKind): void {
    this.held.get(kind)?.delete(leaf);
    const slot = leaf.slots.get(kind);
    if (!slot) return;
    slot.coming?.remove();
    slot.landed?.remove();
    leaf.slots.delete(kind);
    if (leaf.job && ![...leaf.slots.values()].some((s) => s.asked)) { leaf.job.cancel(); leaf.job = null; }
  }

  private warn(what: string, detail: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[near] ${what}; asked again when it changes`, detail);
  }

  /** Chosen again with the last eye once the answers of this turn are in. */
  private again(): void {
    if (this.scheduled || !this.eye) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const e = this.eye;
      if (e) this.choose(e.x, e.y, e.z, e.pxAtMetre, e.orthoPx, e.reach, this.view);
    });
  }
}

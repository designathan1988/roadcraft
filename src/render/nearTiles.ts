import { Box3, type Frustum } from 'three';
import { Digest } from '@core/digest';
import { worldKey } from '@world/cityGen/wholeMap';
import type { TileRecords } from '@world/doc';
import { TILE, tileKey, tileOfKey } from '@world/tiles';
import { m } from '@world/units';
import { canQueueJobs, submitJob } from '../jobs/jobPool';
import { EDIT_TIER, NEAR_TIER, TIER_SPAN } from './buildings/cellPool';
import { emptyRecords } from './buildings/farGrid';
import { HYSTERESIS, type Seen, measureSeen } from './buildings/massCells';
import { forgetOtherDerived } from './derivedCache';
import type { FarTileSource, FarTiles } from './farTree';
import type { GroundRecord } from './groundChanges';
import { type NearGround, type NearKind, type NearLanded, type NearPart, type NearProduct, type NearTileCache, type NearTileJob, type NearTileReply, NEAR_GROUND_REACH } from './nearTileBake';
import { nearParts, nearReadsAround, runNearJob } from './nearBakers';
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

/** A kind of a tile as drawn: the bake drawn and the ask it answered, the one on its way (to the GPU), the ask in flight, a failed one. */
interface Slot {
  landed: NearLanded | null;
  /** The bake drawn (null: none yet); its ask. */
  bake: string | null;
  sig: string | null;
  coming: NearLanded | null;
  asked: string | null;
  cancel: (() => void) | null;
  failed: string | null;
}

/** A stored tile: its place and version, and each kind's slot. */
interface Leaf {
  readonly key: number;
  readonly i: number;
  readonly j: number;
  version: number;
  readonly slots: Map<NearKind, Slot>;
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

/** The page's own cache of bakes where no worker runs (tests): nothing kept. */
const NO_CACHE: NearTileCache = { ready: async () => false, get: async () => undefined, put: async () => {} };

/** DO NOT bake on the page: the jobs go to the job system's queue (`nearTiles` service), the page only when no worker can run (tests). */
function nearRunner(): NearRun {
  return (job, done) => {
    if (!canQueueJobs()) {
      let live = true;
      void runNearJob(job, NO_CACHE).then(
        (reply) => { if (live) done(reply); },
        (error: unknown) => { if (live) done({ kind: 'nearError', node: job.node, sig: job.sig, message: String(error) }); },
      );
      return () => { live = false; };
    }
    const { i, j } = tileOfKey(job.tiles[0]!.key);
    const ticket = submitJob({
      service: 'nearTiles',
      key: `nearTiles:${job.node}`,
      // A tile the page holds edited first (`cellPool.ts` EDIT_TIER): what the player just did; the others with the roads' near level, nearest first.
      priority: (job.edited ? EDIT_TIER : NEAR_TIER) * TIER_SPAN,
      at: [(i + 0.5) * TILE, (j + 0.5) * TILE],
      write: () => ({ data: job, transfer: [] }),
      done: (answer) => done(answer as NearTileReply),
      failed: (message) => done({ kind: 'nearError', node: job.node, sig: job.sig, message }),
    });
    return () => ticket.cancel();
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
    this.leaves.set(tile, { key: tile, i, j, version, slots: new Map() });
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
    for (const product of this.products) this.chooseKind(product);
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
    if (!slot) leaf.slots.set(kind, slot = { landed: null, bake: null, sig: null, coming: null, asked: null, cancel: null, failed: null });
    return slot;
  }

  /** One kind's tiles: within the distance its largest piece spans a pixel at, those the view wants asked, those it no longer wants let go. */
  private chooseKind(product: NearProduct): void {
    const e = this.eyeNow;
    const kind = product.kind;
    const held = this.held.get(kind)!;
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

  /** The tile and (for a kind that reads them) its neighbours stored, at their versions, the tile first; a tile the page holds edited at its edit. */
  private tilesOf(leaf: Leaf, kind: NearKind): { key: number; version: number; edit: number }[] {
    const edit = (key: number): number => this.source?.pageEdit?.(key) ?? 0;
    const out = [{ key: leaf.key, version: leaf.version, edit: edit(leaf.key) }];
    if (!nearReadsAround(kind)) return out;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        const near = this.leaves.get(tileKey(leaf.i + di, leaf.j + dj));
        if (near) out.push({ key: near.key, version: near.version, edit: edit(near.key) });
      }
    }
    return out;
  }

  /** A tile's kind asked of the workers at the version of what it reads, once. */
  private ask(leaf: Leaf, product: NearProduct): void {
    const kind = product.kind;
    const slot = this.slotOf(leaf, kind);
    const tiles = this.tilesOf(leaf, kind);
    const want = `${nearSig(tiles.map((t) => ({ key: t.key, version: t.edit ? `${t.version}+${t.edit}` : t.version })))}:${product.version?.(leaf.key) ?? ''}`;
    const sig = `${want}|${Math.max(this.groundEverywhere, this.groundOf.get(leaf.key) ?? 0)}`;
    if (slot.sig === sig || slot.asked === sig || slot.failed === sig) return;
    slot.cancel?.();
    slot.asked = sig;
    const parts = nearParts(kind);
    // The edited tiles as the page holds them: drawn from the edit, not from its write.
    const records = tiles.some((t) => t.edit) && this.source?.pageRecords
      ? tiles.map((t) => { const r = t.edit ? this.source!.pageRecords!(t.key) : null; return r ? recordsFor(r, parts) : null; })
      : undefined;
    this.submit(leaf, product, sig, want, tiles, records, tiles[0]!.edit > 0);
  }

  private submit(leaf: Leaf, product: NearProduct, sig: string, want: string, tiles: readonly { key: number; version: number }[],
    records?: readonly (Partial<TileRecords> | null)[], edited = false): void {
    const kind = product.kind;
    const slot = this.slotOf(leaf, kind);
    const job: NearTileJob = {
      kind, node: `${kind}:${leaf.i},${leaf.j}`, sig, want, shown: slot.bake, prefix: this.bakePrefix,
      tiles: tiles.map((t) => ({ key: t.key, version: t.version })), ground: this.ground(),
      ...(records ? { records } : {}),
      ...(edited ? { edited } : {}),
      ...(this.source?.workersRead ? { store: this.source.workersRead } : {}),
      ...(product.extra ? { extra: product.extra() } : {}),
    };
    slot.cancel = this.run(job, (reply) => this.answer(leaf, product, reply, { want, tiles, edited }));
  }

  private answer(leaf: Leaf, product: NearProduct, reply: NearTileReply, asked: { readonly want: string; readonly tiles: readonly { key: number; version: number }[]; readonly edited: boolean }): void {
    const kind = product.kind;
    const slot = leaf.slots.get(kind);
    if (!slot || this.leaves.get(leaf.key) !== leaf || reply.sig !== slot.asked) return;
    slot.cancel = null;
    switch (reply.kind) {
      case 'near':
        if (reply.same) { slot.sig = reply.sig; slot.asked = null; break; }
        this.land(leaf, product, slot, reply.payload, reply.bake, reply.sig);
        break;
      case 'nearRecords': {
        // No worker reads the store (the tests, a store the workers cannot open): the page reads the tiles, one empty where the store has none.
        const source = this.source;
        if (!source) { slot.asked = null; break; }
        const sig = reply.sig;
        const parts = nearParts(kind);
        void Promise.all(asked.tiles.map((t) => source.records(t.key).then((r) => recordsFor(r ?? emptyRecords(t.key, t.version), parts)))).then((records) => {
          if (this.leaves.get(leaf.key) === leaf && slot.asked === sig) this.submit(leaf, product, sig, asked.want, asked.tiles, records, asked.edited);
        }, (error: unknown) => {
          if (this.leaves.get(leaf.key) === leaf && slot.asked === sig) { slot.asked = null; slot.failed = sig; }
          this.warn('a tile could not be read from the store', error);
        });
        break;
      }
      case 'nearError':
        this.warn(`a tile's ${kind} could not be baked`, reply.message);
        slot.asked = null;
        slot.failed = reply.sig;
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

  /** A tile's kind let go, drawn or coming, its ask cancelled: asked again when wanted. */
  private drop(leaf: Leaf, kind: NearKind): void {
    this.held.get(kind)?.delete(leaf);
    const slot = leaf.slots.get(kind);
    if (!slot) return;
    slot.cancel?.();
    slot.coming?.remove();
    slot.landed?.remove();
    leaf.slots.delete(kind);
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

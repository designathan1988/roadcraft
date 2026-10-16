import { Group, type Mesh } from 'three';
import { Digest } from '@core/digest';
import type { WholeMapOptions } from '@world/cityGen/wholeMap';
import { tileKey, tileOfKey } from '@world/tiles';
import type { TileRecords } from '@world/doc';
import { m } from '@world/units';
import { forgetDerivedKeys } from './derivedCache';
import { PLAN_SIG, TOP_LEVEL, emptyRecords, farKey, nodeSide } from './buildings/farTiles';
import { HYSTERESIS, type Seen, measureSeen } from './buildings/massCells';
import { cancelWarm, warmLooseAhead } from './uploads';

/** A QUADTREE OF LEVELS BAKED PER TILE IN WORKERS FROM THE TILE STORE (CLAUDE.md "Streaming world"), for any kind of thing drawn from afar: the buildings (`buildings/farLevels.ts`), the roads (`farRoads.ts`) */
/** Chosen top down by their error on the screen (Cesium's replacement refinement, `selectTiles`); the tiles the page's document holds are drawn near, never here */
/** NOT GENERATED YET: only the tiles round the camera are ever made (`worldStreamer.ts` `AHEAD_RADIUS`); a kind that can bake from the world's plan (`FarKind.planFrom`) is drawn there from it - a node no tile is stored under baked as `PLAN_SIG`, a node with some its stored tiles' and the plan's for the rest (its quarters with no tile sent as `PLAN_SIG` children) */

/** Where the far levels read the tile store (the coordinator wires it) */
export interface FarTileSource {
  /** A tile as the store keeps it; null when it has none. */
  records(key: number): Promise<TileRecords | null>;
  /** The world's generator options: what stands where no tile was made yet (drawn from the plan, `farPlan.ts`); null: nothing past the stored tiles. */
  readonly plan: WholeMapOptions | null;
}

/** What the coordinator tells the buildings' far levels (`BuildingLayer.far`). */
export interface FarTiles {
  /** The store to read (and the world's plan) and which tiles the page's document holds now (the streamer's region): those are drawn by the cells, never here. */
  setSource(source: FarTileSource | null, isLoaded: (tileKey: number) => boolean): void;
  /** A tile written by the store at a version (made, changed), or gone (null): it and its ancestors baked again when wanted, nothing else. */
  stored(tileKey: number, version: number | null): void;
  /** A tile loaded into the page's document or unloaded from it: `isLoaded` read again for it. */
  loadedChanged(tileKey: number): void;
}

/** A job of the tree: a node at the version of the tiles under it, from the cache, its tile's records (level 0) or its children's bakes (above). */
interface FarTreeJob {
  readonly node: string;
  readonly k: number;
  readonly i: number;
  readonly j: number;
  readonly sig: string;
  /** Its mesh wanted back (to be drawn), or only baked and kept (for a parent). */
  readonly want: boolean;
  /** The cache's prefix; null: nothing kept, the levels past the tiles not made. */
  readonly prefix: string | null;
  /** Its quarters; `PLAN_SIG` where no tile is stored under one (the plan's), null where none and no plan. */
  readonly children?: readonly ({ readonly key: string; readonly sig: string } | null)[];
  readonly records?: TileRecords;
  /** The world's generator options, for a kind that bakes from the plan. */
  readonly plan?: WholeMapOptions;
}

/** A job's answer, as `buildings/farTiles.ts` `FarReply`, its mesh's data a `payload`. */
type FarTreeReply<P> =
  | { readonly kind: 'far'; readonly node: string; readonly sig: string; readonly payload: P | null }
  | { readonly kind: 'farRecords'; readonly node: string; readonly sig: string }
  | { readonly kind: 'farChildren'; readonly node: string; readonly sig: string; readonly missing: readonly string[] }
  | { readonly kind: 'farNoCache'; readonly node: string; readonly sig: string }
  | { readonly kind: 'farError'; readonly node: string; readonly sig: string; readonly message: string };

/** Runs a job and answers once; gives back its cancel (an answer cancelled is never given). */
export type FarTreeRun<P> = (job: FarTreeJob, done: (reply: FarTreeReply<P>) => void) => () => void;

/** A node's mesh made of its data: the mesh, its plan box and highest point (what the eye measures), what it leaves out, m. */
export interface FarLanded {
  readonly mesh: Mesh;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly top: number;
  readonly error: number;
}

/** What a kind of far thing tells the tree: its meshes, and what each level may leave out before its mesh comes. */
export interface FarKind<P> {
  /** Its name in warnings. */
  readonly name: string;
  land(payload: P): FarLanded;
  levelError(k: number): number;
  /** The finest level its worker bakes from the world's plan where no tile was made (`PLAN_SIG`); the levels under it only from tiles. None: nothing drawn where no tile is. */
  readonly planFrom?: number;
}

/** HOW FAR THE PLAN IS DRAWN ROUND THE EYE: in perspective as far as the camera's far plane reaches for an eye this high (`isoViewport.ts`: four times its distance and 2.4 km), never under 16 km; an orthographic view's own reach; never past a top-level node's side (3 x 3 roots at most) */
const PLAN_PER_HEIGHT = 4;
const PLAN_MARGIN = m(2_400);
const PLAN_MIN_REACH = m(16_000);
const PLAN_MAX_REACH = nodeSide(TOP_LEVEL);

/** Tiles under a node of level `k` when every one is there. */
const tilesUnder = (k: number): number => 4 ** k;

/** A node of the quadtree: a tile (level 0) or 2^k tiles a side; where the store has tiles, and where the plan is drawn. */
interface FarNode {
  readonly key: string;
  readonly k: number;
  readonly i: number;
  readonly j: number;
  readonly parent: FarNode | null;
  /** Its quarters (level 1 and up), by `di + 2 dj`; null where no tile is (and no plan node was made). */
  readonly children: (FarNode | null)[];
  /** Its box in the plan (grown to its mesh's) and its highest point. */
  x0: number; y0: number; x1: number; y1: number; top: number;
  /** Tiles stored under it (none: the plan's alone), and how many of them the page's document holds. */
  tiles: number;
  loaded: number;
  /** A tile's version, and whether the document holds it. */
  version: number;
  inDoc: boolean;
  /** The version of the tiles under it (null: one changed, worked out again when read, `sigOf`). */
  sig: string | null;
  /** The version a worker baked and kept it at. */
  baked: string | null;
  /** The version its mesh is of (null: nothing known to draw); a landed node with no mesh has nothing to draw. */
  landed: string | null;
  mesh: Mesh | null;
  error: number;
  asked: string | null;
  askedWant: boolean;
  cancel: (() => void) | null;
  /** Waiting for its children's bakes at this version: which, and whether its mesh is wanted then. */
  blocked: string | null;
  waitingFor: Set<string> | null;
  blockedWant: boolean;
  /** The version a worker failed to bake: not asked again. */
  failed: string | null;
  queued: boolean;
}

/** The eye the nodes were last chosen for (map x/y, height; a metre's pixels at a metre, or the orthographic view's; how far the view reaches, Infinity in perspective). */
interface Eye { x: number; y: number; z: number; pxAtMetre: number; orthoPx: number | null; reach: number }

export class FarTree<P> implements FarTiles {
  readonly group = new Group();
  private source: FarTileSource | null = null;
  private isLoaded: (tileKey: number) => boolean = () => false;
  /** The world's plan (null: only the stored tiles drawn), its fingerprint in the bakes' keys (one world's bakes never read for another's), how far round the eye it is drawn now. */
  private plan: WholeMapOptions | null = null;
  private world = '';
  private planReach = 0;
  private readonly nodes = new Map<string, FarNode>();
  private readonly roots = new Map<string, FarNode>();
  private readonly leaves = new Map<number, FarNode>();
  /** No store to keep bakes in: no level past the tiles. */
  private cacheless = false;
  private shown = new Set<FarNode>();
  private readonly drawing: FarNode[] = [];
  private readonly desired: FarNode[] = [];
  private highest = -Infinity;
  private wanting = 0;
  /** DO NOT read every tile's records ahead of the workers: the page would hold them all while they wait; `lanes` in flight */
  private readonly fetchQueue: FarNode[] = [];
  private fetching = 0;
  private readonly resident = new Set<FarNode>();
  private readonly seen: Seen = { perMetre: 0, allowed: 0, across: 0 };
  private readonly eyeNow: Eye = { x: 0, y: 0, z: 0, pxAtMetre: 0, orthoPx: null, reach: Infinity };
  private eye: Eye | null = null;
  private scheduled = false;
  private warned = false;

  /** `run`: where its jobs go; `prefix`: the bakes' key in the store (null: nothing kept); `lanes`: the records read at once. */
  constructor(private readonly kind: FarKind<P>, private readonly run: FarTreeRun<P>, private readonly prefix: string | null, private readonly lanes: number) {
    this.group.name = `${kind.name}-far-tiles`;
    this.group.matrixAutoUpdate = false;
  }

  /** Nodes the view would draw whose meshes have not come. */
  get waiting(): number {
    return this.wanting;
  }

  /** The highest point drawn (-Infinity with none). */
  top(): number {
    return this.highest;
  }

  /** The nodes drawn now, by key. */
  shownKeys(): string[] {
    return [...this.shown].map((n) => n.key);
  }

  setSource(source: FarTileSource | null, isLoaded: (tileKey: number) => boolean): void {
    const plan = source?.plan ?? null;
    const world = plan ? new Digest().addPlain(plan).value().toString(36) : '';
    if (world !== this.world) {
      // Another world: its plan's nodes gone, every bake asked again under its own keys.
      this.refill();
      for (const n of [...this.nodes.values()]) if (n.tiles === 0 && this.nodes.get(n.key) === n) this.forget(n);
      for (const n of this.nodes.values()) { n.baked = null; n.landed = null; n.failed = null; }
      this.plan = plan;
      this.world = world;
    }
    this.source = source;
    this.isLoaded = isLoaded;
    for (const key of this.leaves.keys()) this.loadedChanged(key);
    this.pump();
  }

  stored(tile: number, version: number | null): void {
    let leaf = this.leaves.get(tile);
    if (version === null) {
      if (leaf) this.unstore(tile, leaf);
      return;
    }
    if (!leaf) {
      const { i, j } = tileOfKey(tile);
      leaf = this.ensure(0, i, j);
      this.leaves.set(tile, leaf);
      leaf.inDoc = this.isLoaded(tile);
      for (let n: FarNode | null = leaf; n; n = n.parent) { n.tiles++; if (leaf.inDoc) n.loaded++; }
    } else if (leaf.version === version) return;
    leaf.version = version;
    // DO NOT bake anything but it and its ancestors again: the others' versions stand (a plan's node it falls under takes its tiles' and the plan's).
    for (let n: FarNode | null = leaf; n; n = n.parent) n.sig = null;
  }

  loadedChanged(tile: number): void {
    const leaf = this.leaves.get(tile);
    if (!leaf) return;
    const now = this.isLoaded(tile);
    if (now === leaf.inDoc) return;
    leaf.inDoc = now;
    for (let n: FarNode | null = leaf; n; n = n.parent) n.loaded += now ? 1 : -1;
  }

  /** THE NODES DRAWN, from the roots down: a node is drawn in place of its children while what it leaves out spans under the pixels allowed; `reach`, an orthographic view's (Infinity in perspective) */
  choose(eyeX: number, eyeY: number, eyeZ: number, pxAtMetre: number, orthoPx: number | null, reach = Infinity): void {
    const eye = this.eyeNow;
    eye.x = eyeX; eye.y = eyeY; eye.z = eyeZ; eye.pxAtMetre = pxAtMetre; eye.orthoPx = orthoPx; eye.reach = reach;
    this.eye = eye;
    this.drawing.length = 0;
    this.desired.length = 0;
    this.wanting = 0;
    if (this.planning && !this.cacheless) this.plantRoots();
    for (const root of this.roots.values()) this.visit(root);
    const now = new Set(this.drawing), wanted = new Set(this.desired);
    // DO NOT keep on the GPU what is neither drawn nor wanted (the area visited would pile up): read back from the store when wanted again.
    for (const n of [...this.resident]) {
      if (now.has(n)) continue;
      if (wanted.has(n)) n.mesh!.visible = false;
      else this.dropMesh(n);
    }
    this.highest = -Infinity;
    for (const n of now) {
      if (!n.mesh) continue;
      n.mesh.visible = true;
      this.highest = Math.max(this.highest, n.top);
    }
    this.shown = now;
  }

  /** A WebGL context restored: every mesh made again from the store, its arrays having been let go (`gpuOnly.ts`). */
  refill(): void {
    for (const n of this.nodes.values()) {
      n.cancel?.();
      n.cancel = null;
      n.asked = null;
      n.blocked = null;
      n.waitingFor = null;
      n.queued = false;
    }
    for (const n of [...this.resident]) this.dropMesh(n);
    this.fetchQueue.length = 0;
    this.shown.clear();
    this.highest = -Infinity;
  }

  dispose(): void {
    this.refill();
    this.nodes.clear();
    this.roots.clear();
    this.leaves.clear();
    this.group.clear();
    this.eye = null;
  }

  /** The finest level drawn from the plan (Infinity: none, no plan or a kind that bakes none). */
  private get planFrom(): number {
    return this.plan !== null && this.kind.planFrom !== undefined ? this.kind.planFrom : Infinity;
  }

  private get planning(): boolean {
    return Number.isFinite(this.planFrom);
  }

  /** The bakes' keys: the prefix, and the world's fingerprint when it has a plan. */
  private get keyPrefix(): string | null {
    return this.prefix === null ? null : this.world ? `${this.prefix}${this.world}:` : this.prefix;
  }

  /** The top-level nodes over the plan's reach round the eye made (those of the plan alone past it let go, their bakes kept: they never change). */
  private plantRoots(): void {
    const e = this.eyeNow;
    const r = this.planReach = Math.min(PLAN_MAX_REACH, Number.isFinite(e.reach) ? e.reach : Math.max(PLAN_MIN_REACH, PLAN_PER_HEIGHT * e.z + PLAN_MARGIN));
    const side = nodeSide(TOP_LEVEL);
    const i0 = Math.floor((e.x - r) / side), i1 = Math.floor((e.x + r) / side), j0 = Math.floor((e.y - r) / side), j1 = Math.floor((e.y + r) / side);
    for (const root of [...this.roots.values()]) if (root.tiles === 0 && (root.i < i0 || root.i > i1 || root.j < j0 || root.j > j1)) this.forget(root);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) this.ensure(TOP_LEVEL, i, j);
  }

  private ensure(k: number, i: number, j: number): FarNode {
    const key = farKey(k, i, j);
    const known = this.nodes.get(key);
    if (known) return known;
    const parent = k < TOP_LEVEL ? this.ensure(k + 1, Math.floor(i / 2), Math.floor(j / 2)) : null;
    const side = nodeSide(k);
    const n: FarNode = {
      key, k, i, j, parent, children: k > 0 ? [null, null, null, null] : [],
      x0: i * side, y0: j * side, x1: (i + 1) * side, y1: (j + 1) * side, top: 0,
      tiles: 0, loaded: 0, version: 0, inDoc: false, sig: null, baked: null, landed: null, mesh: null, error: this.kind.levelError(k),
      asked: null, askedWant: false, cancel: null, blocked: null, waitingFor: null, blockedWant: false, failed: null, queued: false,
    };
    this.nodes.set(key, n);
    if (parent) parent.children[(i - 2 * parent.i) + 2 * (j - 2 * parent.j)] = n;
    else this.roots.set(key, n);
    return n;
  }

  private unstore(tile: number, leaf: FarNode): void {
    this.leaves.delete(tile);
    for (let n: FarNode | null = leaf; n;) {
      const up: FarNode | null = n.parent;
      n.tiles--;
      if (leaf.inDoc) n.loaded--;
      n.sig = null;
      if (n.tiles === 0) this.forget(n);
      n = up;
    }
  }

  /** A node let go with the plan's nodes under it (a node with no tile has only those); a stored version's bake let go too, the plan's kept. */
  private forget(n: FarNode): void {
    for (const c of n.children) if (c) this.forget(c);
    n.cancel?.();
    n.cancel = null;
    this.dropMesh(n);
    this.shown.delete(n);
    this.nodes.delete(n.key);
    if (n.parent) n.parent.children[(n.i - 2 * n.parent.i) + 2 * (n.j - 2 * n.parent.j)] = null;
    else this.roots.delete(n.key);
    const prefix = this.keyPrefix;
    if (prefix !== null && n.baked !== null && n.baked !== PLAN_SIG) forgetDerivedKeys(prefix, [n.key]);
  }

  /** The version of the tiles under a node: a tile's own, or its quarters' digested; `PLAN_SIG` with none (the plan's alone). */
  private sigOf(n: FarNode): string {
    if (n.sig !== null) return n.sig;
    if (n.tiles === 0) return (n.sig = PLAN_SIG);
    if (n.k === 0) return (n.sig = String(n.version));
    const d = new Digest();
    for (const c of n.children) d.addText(c && c.tiles > 0 ? this.sigOf(c) : '-');
    return (n.sig = d.value().toString(36));
  }

  /** Every tile under a node in the page's document (with a plan, every tile there is; without, every one stored): the near products draw it. */
  private covered(n: FarNode): boolean {
    return n.loaded === (this.planning ? tilesUnder(n.k) : n.tiles);
  }

  /** Whether a node can be drawn whole: from the plan at its level and up, under it only with all its tiles made. */
  private drawable(n: FarNode): boolean {
    return n.k >= this.planFrom || !this.planning || n.tiles === tilesUnder(n.k);
  }

  /** Whether a node can give way to its quarters: each drawable (a quarter under the plan's levels with a tile not made keeps it whole: that tile is past the region made ahead). */
  private refinable(n: FarNode): boolean {
    if (!this.planning || n.k - 1 >= this.planFrom) return true;
    return n.children.every((c) => c !== null && c.tiles === tilesUnder(c.k));
  }

  /** Whether a node's missing quarters are made as the plan's nodes. */
  private grows(n: FarNode): boolean {
    return this.planning && !this.cacheless && n.k - 1 >= this.planFrom;
  }

  /** A node of the plan alone wholly past its reach: nothing of it drawn. */
  private outOfReach(n: FarNode): boolean {
    const e = this.eyeNow, r = this.planReach;
    return n.x1 < e.x - r || n.x0 > e.x + r || n.y1 < e.y - r || n.y0 > e.y + r;
  }

  /** Whether the view wants a node drawn in place of its children, with hysteresis (as a cell near stays near). */
  private fine(n: FarNode): boolean {
    const e = this.eyeNow;
    measureSeen(this.seen, e.x, e.y, e.z, e.pxAtMetre, e.orthoPx, n.x0, n.y0, n.x1, n.y1, n.top);
    return n.error * this.seen.perMetre < this.seen.allowed * (this.shown.has(n) ? 1 : HYSTERESIS);
  }

  /** A node chosen: drawn whole, or its children; whether all it stands for is drawn (or none of it is the tree's). */
  private visit(n: FarNode): boolean {
    if (n.tiles === 0 && this.planning && this.outOfReach(n)) return true;
    if (this.covered(n)) return true;
    const whole = n.loaded === 0 && this.drawable(n) && (n.k === 0 || (!this.cacheless && (this.fine(n) || !this.refinable(n))));
    if (whole) {
      this.desired.push(n);
      this.ask(n, true);
      if (n.landed !== null) { this.drawing.push(n); return true; }
      this.wanting++;
      // Not come yet: what stands under it from before (coarsening, Cesium keeps the children drawn until the parent comes).
      return n.k > 0 && this.fallback(n);
    }
    const mark = this.drawing.length;
    let all = true;
    for (let q = 0; q < n.children.length; q++) {
      let c = n.children[q] ?? null;
      if (!c && this.grows(n)) c = this.ensure(n.k - 1, 2 * n.i + (q & 1), 2 * n.j + (q >> 1));
      if (c && !this.visit(c)) all = false;
    }
    if (all) return true;
    // A child not come: this node, if it came and no tile under it is in the document, stands for them (refining).
    if (n.loaded === 0 && n.landed !== null && this.drawable(n)) {
      this.drawing.length = mark;
      this.drawing.push(n);
      return true;
    }
    return false;
  }

  /** The nodes under one drawn already, without asking anything: whether they cover it. */
  private fallback(n: FarNode): boolean {
    let all = true;
    for (const c of n.children) {
      // With a plan, a quarter not made is not covered.
      if (!c) { if (this.planning) all = false; continue; }
      if (this.covered(c)) continue;
      if (c.loaded === 0 && c.landed !== null && this.drawable(c)) { this.drawing.push(c); continue; }
      if (c.k === 0 || !this.fallback(c)) all = false;
    }
    return all;
  }

  /** A node asked of the workers at its version: its mesh (`want`), or its bake only (for a parent); once. */
  private ask(n: FarNode, want: boolean): void {
    const sig = this.sigOf(n);
    if (want ? n.landed === sig : n.baked === sig) return;
    if (n.failed === sig) return;
    if (n.asked === sig && (n.askedWant || !want)) return;
    if (n.blocked === sig) { if (want) n.blockedWant = true; return; }
    n.cancel?.();
    n.asked = sig;
    n.askedWant = want;
    this.submit(n);
  }

  /** A node's quarters as its job reads them: a stored one by its version, one with no tile the plan's, none without a plan. */
  private childrenOf(n: FarNode): ({ key: string; sig: string } | null)[] {
    return [0, 1, 2, 3].map((q) => {
      const c = n.children[q];
      if (c && c.tiles > 0) return { key: c.key, sig: this.sigOf(c) };
      return this.planning ? { key: farKey(n.k - 1, 2 * n.i + (q & 1), 2 * n.j + (q >> 1)), sig: PLAN_SIG } : null;
    });
  }

  private submit(n: FarNode, records?: TileRecords): void {
    const sig = n.asked!;
    const job: FarTreeJob = {
      node: n.key, k: n.k, i: n.i, j: n.j, sig, want: n.askedWant, prefix: this.keyPrefix,
      ...(n.k > 0 && sig !== PLAN_SIG ? { children: this.childrenOf(n) } : {}),
      ...(records ? { records } : {}),
      ...(this.planning && this.plan ? { plan: this.plan } : {}),
    };
    let settled = false;
    // A job that carried records frees its place for the next tile's once answered or cancelled.
    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (records) { this.fetching--; this.pump(); }
    };
    const cancel = this.run(job, (reply) => { settle(); this.answer(n, reply); });
    n.cancel = () => { cancel(); settle(); };
  }

  private answer(n: FarNode, reply: FarTreeReply<P>): void {
    if (this.nodes.get(n.key) !== n || reply.sig !== n.asked) return;
    n.cancel = null;
    const sig = reply.sig;
    switch (reply.kind) {
      case 'far':
        n.asked = null;
        n.baked = sig;
        if (n.askedWant) this.land(n, reply.payload, sig);
        this.childBaked(n);
        break;
      case 'farRecords':
        if (!n.queued) { n.queued = true; this.fetchQueue.push(n); }
        this.pump();
        break;
      case 'farChildren': {
        n.asked = null;
        n.blocked = sig;
        n.blockedWant = n.askedWant;
        n.waitingFor = new Set(reply.missing);
        for (const key of reply.missing) {
          const c = this.nodes.get(key);
          if (!c) { n.waitingFor.delete(key); continue; }
          if (c.failed === this.sigOf(c)) { this.fail(n, sig); break; }
          // A child the page thought kept and the store no longer has (cleared, or another tab's version): baked again.
          c.baked = null;
          this.ask(c, false);
        }
        if (n.blocked === sig && n.waitingFor.size === 0) { n.blocked = null; n.waitingFor = null; this.ask(n, n.blockedWant); }
        break;
      }
      case 'farNoCache':
        n.asked = null;
        this.cacheless = true;
        break;
      case 'farError':
        if (!this.warned) { this.warned = true; console.warn(`[${this.kind.name}] a far level could not be baked; drawn empty`, reply.message); }
        this.fail(n, sig);
        break;
    }
    this.again();
  }

  /** A node that cannot be baked at this version: drawn empty, and so are its ancestors waiting for it. */
  private fail(n: FarNode, sig: string): void {
    this.dropMesh(n);
    n.asked = null;
    n.failed = sig;
    n.landed = sig;
    n.blocked = null;
    n.waitingFor = null;
    for (let p = n.parent; p && p.blocked !== null; p = p.parent) {
      p.failed = p.blocked;
      p.landed = p.blocked;
      p.blocked = null;
      p.waitingFor = null;
    }
  }

  private childBaked(n: FarNode): void {
    const p = n.parent;
    if (!p || p.blocked === null || !p.waitingFor) return;
    if (p.blocked !== this.sigOf(p)) { p.blocked = null; p.waitingFor = null; return; }
    p.waitingFor.delete(n.key);
    if (p.waitingFor.size > 0) return;
    p.blocked = null;
    p.waitingFor = null;
    this.ask(p, p.blockedWant);
  }

  /** The tiles whose records the workers asked for: read from the store, `lanes` at once. */
  private pump(): void {
    while (this.fetching < this.lanes && this.fetchQueue.length > 0) {
      const n = this.fetchQueue.shift()!;
      n.queued = false;
      const sig = n.asked;
      if (this.nodes.get(n.key) !== n || sig === null || sig !== this.sigOf(n)) continue;
      const source = this.source;
      if (!source) { n.queued = true; this.fetchQueue.unshift(n); return; }
      this.fetching++;
      const tile = tileKey(n.i, n.j);
      void source.records(tile).then((records) => {
        if (this.nodes.get(n.key) !== n || n.asked !== sig) { this.fetching--; this.pump(); return; }
        // DO NOT hold the parents waiting for a tile the store no longer has: baked empty.
        this.submit(n, records ?? emptyRecords(tile, n.version));
      }, (error: unknown) => {
        this.fetching--;
        if (this.nodes.get(n.key) === n && n.asked === sig) {
          if (!this.warned) { this.warned = true; console.warn(`[${this.kind.name}] a tile could not be read from the store`, error); }
          this.fail(n, sig);
        }
        this.pump();
      });
    }
  }

  /** A node's mesh come (null: nothing to draw under it), at a version. */
  private land(n: FarNode, payload: P | null, sig: string): void {
    this.dropMesh(n);
    n.landed = sig;
    const side = nodeSide(n.k);
    n.x0 = n.i * side; n.y0 = n.j * side; n.x1 = (n.i + 1) * side; n.y1 = (n.j + 1) * side; n.top = 0;
    n.error = this.kind.levelError(n.k);
    if (payload === null) return;
    const landed = this.kind.land(payload);
    n.mesh = landed.mesh;
    n.top = landed.top;
    n.error = landed.error;
    // What stands over the node's edge: its box is its mesh's.
    n.x0 = Math.min(n.x0, landed.x0); n.x1 = Math.max(n.x1, landed.x1); n.y0 = Math.min(n.y0, landed.y0); n.y1 = Math.max(n.y1, landed.y1);
    landed.mesh.visible = false;
    this.group.add(landed.mesh);
    this.resident.add(n);
    // Sent ahead: never uploaded mid-frame.
    void warmLooseAhead([landed.mesh]);
  }

  private dropMesh(n: FarNode): void {
    if (!n.mesh) return;
    this.resident.delete(n);
    cancelWarm([n.mesh]);
    this.group.remove(n.mesh);
    n.mesh.geometry.dispose();
    n.mesh = null;
    n.landed = null;
  }

  /** Chosen again with the last eye once the answers of this turn are in (one walk for many answers). */
  private again(): void {
    if (this.scheduled || !this.eye) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const e = this.eye;
      if (e) this.choose(e.x, e.y, e.z, e.pxAtMetre, e.orthoPx, e.reach);
    });
  }
}

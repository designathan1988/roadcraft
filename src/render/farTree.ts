import { Group, type Mesh } from 'three';
import { Digest } from '@core/digest';
import { tileKey, tileOfKey } from '@world/tiles';
import type { TileRecords } from '@world/doc';
import { forgetDerivedKeys } from './derivedCache';
import type { FarTileSource, FarTiles } from './buildings/farLevels';
import { TOP_LEVEL, emptyRecords, farKey, nodeSide } from './buildings/farTiles';
import { HYSTERESIS, type Seen, measureSeen } from './buildings/massCells';
import { cancelWarm, warmLooseAhead } from './uploads';

/** A QUADTREE OF LEVELS BAKED PER TILE IN WORKERS FROM THE TILE STORE (CLAUDE.md "Streaming world"), for any kind of thing drawn from afar: the far roads (`farRoads.ts`) */
/** Chosen top down by their error on the screen (Cesium's replacement refinement, `selectTiles`), as the buildings' far levels are (`buildings/farLevels.ts`, the same walk over masses); the tiles the page's document holds are drawn near, never here */

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
  readonly children?: readonly ({ readonly key: string; readonly sig: string } | null)[];
  readonly records?: TileRecords;
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
}

/** A node of the quadtree: a tile (level 0) or 2^k tiles a side; only where the store has tiles. */
interface FarNode {
  readonly key: string;
  readonly k: number;
  readonly i: number;
  readonly j: number;
  readonly parent: FarNode | null;
  /** Its quarters (level 1 and up), by `di + 2 dj`; null where no tile is. */
  readonly children: (FarNode | null)[];
  /** Its box in the plan (grown to its mesh's) and its highest point. */
  x0: number; y0: number; x1: number; y1: number; top: number;
  /** Tiles stored under it, and how many of them the page's document holds. */
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

/** The eye the nodes were last chosen for (map x/y, height; a metre's pixels at a metre, or the orthographic view's). */
interface Eye { x: number; y: number; z: number; pxAtMetre: number; orthoPx: number | null }

export class FarTree<P> implements FarTiles {
  readonly group = new Group();
  private source: FarTileSource | null = null;
  private isLoaded: (tileKey: number) => boolean = () => false;
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
  private readonly eyeNow: Eye = { x: 0, y: 0, z: 0, pxAtMetre: 0, orthoPx: null };
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
    // DO NOT bake anything but it and its ancestors again: the others' versions stand.
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

  /** THE NODES DRAWN, from the roots down: a node is drawn in place of its children while what it leaves out spans under the pixels allowed */
  choose(eyeX: number, eyeY: number, eyeZ: number, pxAtMetre: number, orthoPx: number | null): void {
    const eye = this.eyeNow;
    eye.x = eyeX; eye.y = eyeY; eye.z = eyeZ; eye.pxAtMetre = pxAtMetre; eye.orthoPx = orthoPx;
    this.eye = eye;
    this.drawing.length = 0;
    this.desired.length = 0;
    this.wanting = 0;
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

  private forget(n: FarNode): void {
    n.cancel?.();
    n.cancel = null;
    this.dropMesh(n);
    this.shown.delete(n);
    this.nodes.delete(n.key);
    if (n.parent) n.parent.children[(n.i - 2 * n.parent.i) + 2 * (n.j - 2 * n.parent.j)] = null;
    else this.roots.delete(n.key);
    if (this.prefix !== null && n.baked !== null) forgetDerivedKeys(this.prefix, [n.key]);
  }

  /** The version of the tiles under a node: a tile's own, or its quarters' digested. */
  private sigOf(n: FarNode): string {
    if (n.sig !== null) return n.sig;
    if (n.k === 0) return (n.sig = String(n.version));
    const d = new Digest();
    for (const c of n.children) d.addText(c ? this.sigOf(c) : '-');
    return (n.sig = d.value().toString(36));
  }

  /** Whether the view wants a node drawn in place of its children, with hysteresis (as a cell near stays near). */
  private fine(n: FarNode): boolean {
    const e = this.eyeNow;
    measureSeen(this.seen, e.x, e.y, e.z, e.pxAtMetre, e.orthoPx, n.x0, n.y0, n.x1, n.y1, n.top);
    return n.error * this.seen.perMetre < this.seen.allowed * (this.shown.has(n) ? 1 : HYSTERESIS);
  }

  /** A node chosen: drawn whole, or its children; whether all it stands for is drawn (or none of it is the tree's). */
  private visit(n: FarNode): boolean {
    if (n.loaded === n.tiles) return true;
    const whole = n.loaded === 0 && (n.k === 0 || (!this.cacheless && this.fine(n)));
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
    for (const c of n.children) if (c && !this.visit(c)) all = false;
    if (all) return true;
    // A child not come: this node, if it came and no tile under it is in the document, stands for them (refining).
    if (n.loaded === 0 && n.landed !== null) {
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
      if (!c || c.loaded === c.tiles) continue;
      if (c.loaded === 0 && c.landed !== null) { this.drawing.push(c); continue; }
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

  private submit(n: FarNode, records?: TileRecords): void {
    const job: FarTreeJob = {
      node: n.key, k: n.k, i: n.i, j: n.j, sig: n.asked!, want: n.askedWant, prefix: this.prefix,
      ...(n.k > 0 ? { children: n.children.map((c) => (c ? { key: c.key, sig: this.sigOf(c) } : null)) } : {}),
      ...(records ? { records } : {}),
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
      if (e) this.choose(e.x, e.y, e.z, e.pxAtMetre, e.orthoPx);
    });
  }
}

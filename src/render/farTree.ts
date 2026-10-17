import { Box3, Frustum, Group, type Mesh, type Object3D } from 'three';
import { Digest } from '@core/digest';
import { type WholeMapOptions, worldKey } from '@world/cityGen/wholeMap';
import { tileKey, tileOfKey } from '@world/tiles';
import type { TileRecords } from '@world/doc';
import { m } from '@world/units';
import { forgetDerivedKeys } from './derivedCache';
import { TOP_LEVEL, emptyRecords, farKey, nodeSide } from './buildings/farTiles';
import { bakeKeysOf } from './buildings/farGrid';
import { HYSTERESIS, type Seen, measureSeen } from './buildings/massCells';
import { cancelWarm, warmLooseAhead } from './uploads';
import { nearSig } from './nearRoadTiles';
import { geometryCost, gpuLedger } from './gpuLedger';

/** A QUADTREE OF LEVELS BAKED PER TILE IN WORKERS FROM THE TILE STORE (CLAUDE.md "Streaming world"), for any kind of thing drawn from afar: the buildings (`buildings/farLevels.ts`), the roads (`farRoads.ts`) */
/** Chosen top down by their error on the screen (Cesium's replacement refinement, `selectTiles`); the tiles the page's document holds are drawn near, never here */
/** EVERY TILE OF THE MAP IS MADE BEFORE THE CITY IS SHOWN (`worldStreamer.ts` rush, the city-game's opening): every node is baked from stored tiles, never from a stand-in */

/** Where the far levels read the tile store (the coordinator wires it) */
export interface FarTileSource {
  /** A tile as the page's document files it (`editor/tileStore.ts` `preparedRecords`: its buildings migrated, each a row of its tile's shared table); null when the store has none. */
  records(key: number): Promise<TileRecords | null>;
  /** The world's generator options: its fingerprint keys the bakes (one world's never read for another's); null: no such world. */
  readonly plan: WholeMapOptions | null;
  /** The store's map when the workers can read it themselves (`core/storedTiles.ts`, the browser's IndexedDB): a tile's records then never cross the page. */
  readonly workersRead?: string;
  /** The page's edit of a tile the store does not hold yet (`worldStreamer.ts` pageEdit: a serial; 0 when the store holds the tile as the page has it), and the tile as the page holds it: what a near level reads of a tile edited (`FarKind.near`), drawn from the edit on, not from the write seconds later. */
  pageEdit?(key: number): number;
  pageRecords?(key: number): TileRecords | null;
}

/** What the coordinator tells the buildings' far levels (`BuildingLayer.far`). */
export interface FarTiles {
  /** The store to read (and the world's plan) and which tiles the page's document holds now (the streamer's region): those are drawn by the cells, never here. */
  setSource(source: FarTileSource | null, isLoaded: (tileKey: number) => boolean): void;
  /** A tile written by the store at a version (made, changed), or gone (null): it and its ancestors baked again when wanted, nothing else. */
  stored(tileKey: number, version: number | null): void;
  /** A tile loaded into the page's document or unloaded from it: `isLoaded` read again for it. */
  loadedChanged(tileKey: number): void;
  /** The frame's error scale for the next `choose` (`buildings/frameBudget.ts`), as the cells' (`massCells.ts` `setErrorScale`). */
  setErrorScale(scale: number): void;
  /** The key prefix its bakes are kept under for the world set (`setSource`): what a tile's maker keeps its level 0 under (`cityTile.worker.ts`); null when nothing is kept. */
  readonly bakePrefix: string | null;
}

/** A job of the tree: a node at the version of the tiles under it, from the cache, its tile's records (level 0) or its children's bakes (above). */
export interface FarTreeJob {
  readonly node: string;
  readonly k: number;
  readonly i: number;
  readonly j: number;
  readonly sig: string;
  /** Its mesh wanted back (to be drawn), or only baked and kept (for a parent). */
  readonly want: boolean;
  /** The cache's prefix; null: nothing kept, the levels past the tiles not made. */
  readonly prefix: string | null;
  /** Its quarters, null where no tile is stored under one. */
  readonly children?: readonly ({ readonly key: string; readonly sig: string } | null)[];
  /** The tile the page read (no worker reads the store): DO NOT post it whole, each kind's runner posts what its bake reads of it (the buildings' rows in their shared tables, `buildings/farLevels.ts` `farJobOf`; the roads alone, `farRoads.ts` `farRoadJob`). */
  readonly records?: TileRecords;
  /** The store's map the worker reads the tile from itself (`core/storedTiles.ts`), when it can (`FarTileSource.workersRead`): DO NOT drop it on the way to the worker. */
  readonly store?: string;
  /** A tile's near level (`FarKind.near`): the tiles it reads, each at its version (the tile first, then its neighbours stored), the version of what it reads (`bake`), the level wanted and the version of it drawn now (`shown`: only what changed since comes back); the page's records of the tiles it holds edited (or of all, where no worker reads the store), in that order, null for one read from the store. */
  readonly near?: {
    readonly tiles: readonly { readonly key: number; readonly version: number }[];
    readonly bake: string;
    readonly variant: string;
    readonly shown: string | null;
    readonly records?: readonly (TileRecords | null)[];
    /** The tile itself held edited by the page: what the player just did, baked before anything (`cellPool.ts` EDIT_TIER). */
    readonly edited?: boolean;
  };
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
  /** The least pixels a level's error may span before it gives way to its quarters (none: the near levels' own, `massCells.ts` `measureSeen`): what a level draws never smaller on the screen than this asks. */
  levelPixels?(k: number): number;
  /** A level under the tiles (the roads' near level, `nearRoadTiles.ts`); none: a tile is the finest the tree draws (the buildings', whose cells draw the near). */
  readonly near?: FarNear<P>;
}

/** A kind's level under its tiles, at two levels of its own: what a tile's own level leaves out that it draws (`error`, m: wanted where that spans the pixels allowed, as a cell comes near, `massCells.ts`), what its simplified level leaves out (`fineError`: its full detail wanted where that spans them), and its meshes. */
export interface FarNear<P> {
  readonly error: number;
  readonly fineError: number;
  /** A level's meshes from a job's answer; `base`, the one drawn now at that level, whose blocks the answer leaves out it keeps (`FarNearLanded.adopt`). */
  land(payload: P, base: FarNearLanded | null): FarNearLanded;
  /** Whether an answer builds on a version drawn (its blocks changed since alone): that version, else null. */
  baseOf(payload: P): string | null;
  /** What an answer is of: the content it was baked from and its level (a landed level's `bake` and `variant`); none: every answer is new. */
  contentOf?(payload: P): { readonly bake: string; readonly variant: string };
  /** What else it is baked from that the page may change (the roads' paint style): in its version. */
  version?(): string;
  /** A tile the page holds edited, cut to what the near level reads, and the digest of that: the version an edited tile is asked at, so an edit of what it does not read (a building grown, a tree) asks nothing. */
  pageCut?(records: TileRecords): { readonly records: TileRecords; readonly digest: string };
  /** Whether it draws the tiles the page's document holds too (the roads: one way for every tile; the buildings' cells draw theirs). */
  readonly drawsLoaded?: boolean;
}

/** A tile's near level made of its data: what is drawn, the meshes made for it (sent to the GPU before it is drawn), what it holds, its highest point, the version of what it read and its level. */
export interface FarNearLanded {
  readonly group: Object3D;
  readonly meshes: readonly Mesh[];
  readonly bytes: number;
  readonly triangles: number;
  readonly top: number;
  readonly bake: string;
  readonly variant: string;
  /** At the swap: takes from the one drawn before the blocks it kept, which then lets go only the rest. */
  adopt(base: FarNearLanded): void;
  dispose(): void;
}

/** HOW FAR THE TREE IS DRAWN ROUND THE EYE (its stored tiles and the plan): the view's reach as the renderer gives it (the far plane in perspective, the frame from above); asked with none, as the far plane stands for an eye this high (`isoViewport.ts`: four times its distance and 2.4 km); never past a top-level node's side (3 x 3 roots at most)
 *  - DO NOT draw to a fixed 16 km whatever the camera: an eye at 340 m clips at 4.3 km, and 60 nodes past it were baked and uploaded for nothing (2026-10-16). */
const PLAN_PER_HEIGHT = 4;
const PLAN_MARGIN = m(2_400);
const PLAN_MAX_REACH = nodeSide(TOP_LEVEL);

/** How far round the eye the view reaches (`PLAN_PER_HEIGHT`). */
const viewReach = (e: { readonly z: number; readonly reach: number }): number =>
  Math.min(PLAN_MAX_REACH, Number.isFinite(e.reach) ? e.reach : PLAN_PER_HEIGHT * e.z + PLAN_MARGIN);


/** A tile's near level's key in the store of bakes (`farKey`'s level 0 under it: `n0:i,j`). */
const nearKeyOf = (n: { readonly i: number; readonly j: number }): string => `n0:${n.i},${n.j}`;

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
  /** A tile's near level (`FarKind.near`): drawn, and on its way to the GPU; the version of the tiles it reads it is of, asked, failed. */
  near: FarNearLanded | null;
  nearComing: FarNearLanded | null;
  nearLanded: string | null;
  nearAsked: string | null;
  nearCancel: (() => void) | null;
  /** The version the level on its way to the GPU stands for now: a newer answer of the same content moves it here, never the upload (`landNear`). */
  nearComingSig: string | null;
  nearFailed: string | null;
}

/** The eye the nodes were last chosen for (map x/y, height; a metre's pixels at a metre, or the orthographic view's; how far the view reaches, Infinity in perspective). */
interface Eye { x: number; y: number; z: number; pxAtMetre: number; orthoPx: number | null; reach: number }

export class FarTree<P> implements FarTiles {
  readonly group = new Group();
  private source: FarTileSource | null = null;
  private isLoaded: (tileKey: number) => boolean = () => false;
  /** The world's fingerprint in the bakes' keys (one world's bakes never read for another's). */
  private world = '';
  /** How far round the eye anything of the tree is drawn now (`viewReach`). */
  private reach = 0;
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
  /** The tiles whose near level is drawn, wanted this choice, and held on the GPU (`FarKind.near`). */
  private nearShown = new Set<FarNode>();
  private readonly nearDrawing: FarNode[] = [];
  private readonly nearWanted: FarNode[] = [];
  private readonly nearResident = new Set<FarNode>();
  private readonly seen: Seen = { perMetre: 0, allowed: 0, across: 0 };
  private readonly ranked: Seen = { perMetre: 0, allowed: 0, across: 0 };
  private readonly eyeNow: Eye = { x: 0, y: 0, z: 0, pxAtMetre: 0, orthoPx: null, reach: Infinity };
  private eye: Eye | null = null;
  /** The camera's frustum at the last `choose` (null: every node counts as seen). */
  private view: Frustum | null = null;
  private readonly viewBox = new Box3();
  /** Whether anything the choice reads changed since the last whole one (a tile stored or loaded, an answer, the scale): with the same eye and frustum, `choose` is skipped. */
  private changed = true;
  /** The eye, frustum and outside versions (`outsideKey`) the last whole choice was made for. */
  private readonly chosenEye: Eye = { x: Number.NaN, y: 0, z: 0, pxAtMetre: 0, orthoPx: null, reach: Infinity };
  private readonly chosenView = new Frustum();
  private chosenHadView = false;
  private chosenOutside = '';
  private scheduled = false;
  private warned = false;

  /** `run`: where its jobs go; `prefix`: the bakes' key in the store (null: nothing kept); `lanes`: the records read at once. */
  constructor(private readonly kind: FarKind<P>, private readonly run: FarTreeRun<P>, private readonly prefix: string | null, private readonly lanes: number) {
    this.group.name = `${kind.name}-far-tiles`;
    this.group.matrixAutoUpdate = false;
  }

  /** Nodes the view would draw IN THE FRUSTUM whose meshes have not come: the opening waits for these (`renderer.ts` reveal); those beside or behind the camera are asked and drawn all the same, never waited for. */
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

  /** The tiles whose near level is drawn now, by key (`FarKind.near`). */
  nearKeys(): string[] {
    return [...this.nearShown].map((n) => n.key);
  }

  setSource(source: FarTileSource | null, isLoaded: (tileKey: number) => boolean): void {
    const plan = source?.plan ?? null;
    // The plan's version and the map's size in it (`worldKey`): bakes of an older plan never read for this one.
    const world = plan ? `${new Digest().addPlain(plan).value().toString(36)}.${worldKey(plan.seed)}` : '';
    if (world !== this.world) {
      // Another world: every bake asked again under its own keys.
      this.refill();
      for (const n of [...this.nodes.values()]) if (n.tiles === 0 && this.nodes.get(n.key) === n) this.forget(n);
      for (const n of this.nodes.values()) { n.baked = null; n.landed = null; n.failed = null; }
      this.world = world;
    }
    this.source = source;
    this.isLoaded = isLoaded;
    this.changed = true;
    for (const key of this.leaves.keys()) this.loadedChanged(key);
    this.pump();
  }

  stored(tile: number, version: number | null): void {
    let leaf = this.leaves.get(tile);
    if (version === null) {
      if (leaf) { this.unstore(tile, leaf); this.changed = true; }
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
    this.changed = true;
    // DO NOT bake anything but it and its ancestors again: the others' versions stand (a plan's node it falls under takes its tiles' and the plan's).
    for (let n: FarNode | null = leaf; n; n = n.parent) n.sig = null;
  }

  loadedChanged(tile: number): void {
    const leaf = this.leaves.get(tile);
    if (!leaf) return;
    const now = this.isLoaded(tile);
    if (now === leaf.inDoc) return;
    leaf.inDoc = now;
    this.changed = true;
    for (let n: FarNode | null = leaf; n; n = n.parent) n.loaded += now ? 1 : -1;
  }

  setErrorScale(scale: number): void {
    if (this.seen.scale !== scale) this.changed = true;
    this.seen.scale = scale;
  }

  /** THE NODES DRAWN, from the roots down: a node is drawn in place of its children while what it leaves out spans under the pixels allowed; `reach`, an orthographic view's (Infinity in perspective) */
  choose(eyeX: number, eyeY: number, eyeZ: number, pxAtMetre: number, orthoPx: number | null, reach = Infinity, view: Frustum | null = null): void {
    // DO NOT walk the tree again, and make its sets, for the frame that changed nothing it reads: the same eye, frustum and versions, nothing come or stored.
    const outside = this.outsideKey();
    const c = this.chosenEye;
    if (!this.changed && c.x === eyeX && c.y === eyeY && c.z === eyeZ && c.pxAtMetre === pxAtMetre && c.orthoPx === orthoPx && c.reach === reach
      && outside === this.chosenOutside && sameView(this.chosenHadView ? this.chosenView : null, view)) {
      this.view = view;
      return;
    }
    this.changed = false;
    c.x = eyeX; c.y = eyeY; c.z = eyeZ; c.pxAtMetre = pxAtMetre; c.orthoPx = orthoPx; c.reach = reach;
    this.chosenOutside = outside;
    this.chosenHadView = view !== null;
    if (view) this.chosenView.copy(view);
    this.view = view;
    const eye = this.eyeNow;
    eye.x = eyeX; eye.y = eyeY; eye.z = eyeZ; eye.pxAtMetre = pxAtMetre; eye.orthoPx = orthoPx; eye.reach = reach;
    this.eye = eye;
    this.drawing.length = 0;
    this.desired.length = 0;
    this.nearDrawing.length = 0;
    this.nearWanted.length = 0;
    this.wanting = 0;
    this.reach = viewReach(eye);
    for (const root of this.roots.values()) this.visit(root);
    const now = new Set(this.drawing), wanted = new Set(this.desired);
    // DO NOT keep on the GPU what is neither drawn nor wanted (the area visited would pile up): read back from the store when wanted again.
    for (const n of [...this.resident]) {
      if (now.has(n)) continue;
      if (wanted.has(n)) n.mesh!.visible = false;
      else this.dropMesh(n);
    }
    const nearNow = new Set(this.nearDrawing), nearWanted = new Set(this.nearWanted);
    for (const n of [...this.nearResident]) {
      if (nearNow.has(n)) continue;
      if (nearWanted.has(n)) n.near!.group.visible = false;
      else this.dropNear(n);
    }
    this.highest = -Infinity;
    for (const n of now) {
      if (!n.mesh) continue;
      n.mesh.visible = true;
      this.highest = Math.max(this.highest, n.top);
    }
    for (const n of nearNow) {
      n.near!.group.visible = true;
      this.highest = Math.max(this.highest, n.near!.top);
    }
    this.shown = now;
    this.nearShown = nearNow;
  }

  /** A WebGL context restored: every mesh made again from the store, its arrays having been let go (`gpuOnly.ts`). */
  refill(): void {
    this.changed = true;
    for (const n of this.nodes.values()) {
      n.cancel?.();
      n.cancel = null;
      n.asked = null;
      n.blocked = null;
      n.waitingFor = null;
      n.queued = false;
    }
    for (const n of [...this.resident]) this.dropMesh(n);
    for (const n of this.nodes.values()) {
      n.nearCancel?.();
      n.nearCancel = null;
      n.nearAsked = null;
      this.dropNear(n);
    }
    this.fetchQueue.length = 0;
    this.shown.clear();
    this.nearShown.clear();
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

  /** What the choice reads from outside the tree that tells it nothing when it moves: the near level's version and the page's edits of the stored tiles (`nearTiles`). */
  private outsideKey(): string {
    const near = this.kind.near;
    if (!near) return '';
    const version = near.version?.() ?? '';
    const edit = this.source?.pageEdit;
    if (!edit) return version;
    const d = new Digest();
    for (const key of this.leaves.keys()) d.add(edit(key));
    return `${version}|${d.value()}`;
  }

  /** The bakes' keys: the prefix, and the world's fingerprint when it has a plan. */
  private get keyPrefix(): string | null {
    return this.prefix === null ? null : this.world ? `${this.prefix}${this.world}:` : this.prefix;
  }

  get bakePrefix(): string | null {
    return this.cacheless ? null : this.keyPrefix;
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
      near: null, nearComing: null, nearComingSig: null, nearLanded: null, nearAsked: null, nearCancel: null, nearFailed: null,
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

  /** A node let go with the nodes under it, its bake too. */
  private forget(n: FarNode): void {
    for (const c of n.children) if (c) this.forget(c);
    n.cancel?.();
    n.cancel = null;
    n.nearCancel?.();
    n.nearCancel = null;
    this.dropMesh(n);
    const hadNear = n.nearLanded !== null || n.near !== null;
    this.dropNear(n);
    this.shown.delete(n);
    this.nodes.delete(n.key);
    if (n.parent) n.parent.children[(n.i - 2 * n.parent.i) + 2 * (n.j - 2 * n.parent.j)] = null;
    else this.roots.delete(n.key);
    const prefix = this.keyPrefix;
    if (prefix !== null && n.baked !== null) forgetDerivedKeys(prefix, bakeKeysOf(n.key, n.k));
    if (prefix !== null && hadNear) forgetDerivedKeys(prefix, [nearKeyOf(n)]);
  }

  /** The version of the tiles under a node: a tile's own, or its quarters' digested (a node with none is never asked: it is let go, `forget`). */
  private sigOf(n: FarNode): string {
    if (n.sig !== null) return n.sig;
    if (n.k === 0) return (n.sig = String(n.version));
    const d = new Digest();
    for (const c of n.children) d.addText(c && c.tiles > 0 ? this.sigOf(c) : '-');
    return (n.sig = d.value().toString(36));
  }

  /** Every tile under a node in the page's document (with a plan, every tile there is; without, every one stored): the near products draw it; never, for a kind that draws them too (`FarNear.drawsLoaded`). */
  private covered(n: FarNode): boolean {
    return this.loadedOf(n) === n.tiles;
  }

  /** The tiles under a node the page's document draws (none, for a kind that draws them too). */
  private loadedOf(n: FarNode): number {
    return this.kind.near?.drawsLoaded ? 0 : n.loaded;
  }


  /** A node wholly past what the view reaches: nothing of it drawn nor asked. */
  private outOfReach(n: FarNode): boolean {
    const e = this.eyeNow, r = this.reach;
    return n.x1 < e.x - r || n.x0 > e.x + r || n.y1 < e.y - r || n.y0 > e.y + r;
  }

  /** Whether a node's box (its tiles, from under the ground to its top or a tall tower's height before it lands) meets the camera's frustum; true with none. */
  private inView(n: FarNode): boolean {
    if (!this.view) return true;
    const top = n.landed !== null && Number.isFinite(n.top) ? Math.max(n.top, m(60)) : m(500);
    this.viewBox.min.set(n.x0, -m(50), -n.y1);
    this.viewBox.max.set(n.x1, top, -n.y0);
    return this.view.intersectsBox(this.viewBox);
  }

  /** Whether the view wants a node drawn in place of its children, with hysteresis (as a cell near stays near). */
  private fine(n: FarNode): boolean {
    const e = this.eyeNow;
    measureSeen(this.seen, e.x, e.y, e.z, e.pxAtMetre, e.orthoPx, n.x0, n.y0, n.x1, n.y1, n.top);
    const allowed = Math.max(this.seen.allowed, this.kind.levelPixels?.(n.k) ?? 0);
    return n.error * this.seen.perMetre < allowed * (this.shown.has(n) ? 1 : HYSTERESIS);
  }

  /** A node chosen: drawn whole, or its children; whether all it stands for is drawn (or none of it is the tree's). */
  private visit(n: FarNode): boolean {
    // DO NOT draw a stored tile the view does not reach: the street view drew every tile made ahead (11 km) at its finest, 4.9 M vertices (2026-10-16); culled as Cesium culls a tile out of the frustum.
    if (this.outOfReach(n)) return true;
    if (this.covered(n)) return true;
    const whole = this.loadedOf(n) === 0 && (n.k === 0 || (!this.cacheless && this.fine(n)));
    if (whole) {
      this.desired.push(n);
      this.ask(n, true);
      // A tile's near level where the view wants its detail (`FarKind.near`): drawn once it came (the last one made stands while the next is baked), the tile's own level until then.
      if (n.k === 0 && this.kind.near && this.wantsNear(n)) {
        this.nearWanted.push(n);
        this.askNear(n);
        if (n.near !== null) { this.nearDrawing.push(n); return true; }
      }
      if (n.landed !== null) { this.drawing.push(n); return true; }
      if (this.inView(n)) this.wanting++;
      // Not come yet: what stands under it from before (coarsening, Cesium keeps the children drawn until the parent comes).
      return n.k > 0 && this.fallback(n);
    }
    const mark = this.drawing.length;
    let all = true;
    for (let q = 0; q < n.children.length; q++) {
      const c = n.children[q] ?? null;
      if (c && !this.visit(c)) all = false;
    }
    if (all) return true;
    // A child not come: this node, if it came and no tile under it is in the document, stands for them (refining).
    if (this.loadedOf(n) === 0 && n.landed !== null) {
      this.drawing.length = mark;
      this.drawing.push(n);
      return true;
    }
    return false;
  }

  /** Whether the view wants a tile's near level: what its own level leaves out spans the pixels allowed (with hysteresis, as a cell near stays near), and it is in the view or its near level is held already (DO NOT bake the tiles behind the camera: a second each). */
  private wantsNear(n: FarNode): boolean {
    const e = this.eyeNow;
    measureSeen(this.seen, e.x, e.y, e.z, e.pxAtMetre, e.orthoPx, n.x0, n.y0, n.x1, n.y1, n.top);
    if (this.kind.near!.error * this.seen.perMetre < this.seen.allowed * (this.nearShown.has(n) ? HYSTERESIS : 1)) return false;
    return n.near !== null || this.inView(n);
  }

  /** Which level of its near level a tile wants: full where what the simplified one leaves out spans the pixels allowed (`seen` as `wantsNear` measured it), with hysteresis. */
  private nearVariant(n: FarNode): string {
    const full = n.near?.variant === 'full';
    return this.kind.near!.fineError * this.seen.perMetre < this.seen.allowed * (full ? HYSTERESIS : 1) ? 'coarse' : 'full';
  }

  /** The tile and its neighbours stored, at their versions (the tile first): what its near level reads; a tile the page holds edited, at the digest of what the near level reads of it (`pageCutOf`). */
  private nearTiles(n: FarNode): { key: number; version: number; cut: { readonly records: TileRecords; readonly digest: string } | null }[] {
    const out = [{ key: tileKey(n.i, n.j), version: n.version, cut: this.pageCutOf(tileKey(n.i, n.j)) }];
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        const key = tileKey(n.i + di, n.j + dj);
        const leaf = this.leaves.get(key);
        if (leaf) out.push({ key, version: leaf.version, cut: this.pageCutOf(key) });
      }
    }
    return out;
  }

  /** Each edited tile's records as the near level reads them, by the edit they are of: DO NOT read the page's document again for every neighbour that reads the tile, nor for every frame (`tileMembers` walks the region's document). */
  private readonly pageCuts = new Map<number, { readonly edit: number; readonly cut: { readonly records: TileRecords; readonly digest: string } | null }>();

  /** A tile the page holds edited (`FarTileSource.pageEdit`), cut to what the near level reads and digested, once an edit; null for one the store holds as the page has it. */
  private pageCutOf(key: number): { readonly records: TileRecords; readonly digest: string } | null {
    const edit = this.source?.pageEdit?.(key) ?? 0;
    if (!edit || !this.source?.pageRecords) { this.pageCuts.delete(key); return null; }
    const known = this.pageCuts.get(key);
    if (known && known.edit === edit) return known.cut;
    const records = this.source.pageRecords(key);
    const cut = records ? (this.kind.near!.pageCut ? this.kind.near!.pageCut(records) : { records, digest: `e${edit}` }) : null;
    this.pageCuts.set(key, { edit, cut });
    return cut;
  }

  /** A tile's near level asked of the workers at the versions of the tiles it reads and at the level the view wants; once. */
  private askNear(n: FarNode): void {
    const tiles = this.nearTiles(n);
    // An edited tile at what the near level reads of it: a building grown or a tree planted asks nothing (each was every tile round it baked again, 2026-10-17).
    const bake = `${nearSig(tiles.map((t) => ({ key: t.key, version: t.cut ? `p${t.cut.digest}` : t.version })))}:${this.kind.near!.version?.() ?? ''}`;
    const variant = this.nearVariant(n);
    const sig = `${bake}:${variant}`;
    if (n.nearLanded === sig || n.nearAsked === sig || n.nearFailed === sig) return;
    n.nearCancel?.();
    n.nearAsked = sig;
    // The edited tiles as the page holds them: drawn from the edit, not from its write.
    const edited = tiles.some((t) => t.cut) ? tiles.map((t) => t.cut?.records ?? null) : undefined;
    this.submitNear(n, sig, bake, variant, tiles, edited, tiles[0]!.cut !== null);
  }

  private submitNear(n: FarNode, sig: string, bake: string, variant: string, tiles: readonly { key: number; version: number }[], records?: readonly (TileRecords | null)[], edited = false): void {
    const shown = n.near && n.near.variant === variant ? n.near.bake : null;
    const job: FarTreeJob = {
      node: nearKeyOf(n), k: -1, i: n.i, j: n.j, sig, want: true, prefix: this.keyPrefix,
      near: { tiles: tiles.map((t) => ({ key: t.key, version: t.version })), bake, variant, shown, ...(records ? { records } : {}), ...(edited ? { edited } : {}) },
      ...(this.source?.workersRead ? { store: this.source.workersRead } : {}),
    };
    n.nearCancel = this.run(job, (reply) => this.answerNear(n, reply, { bake, variant, tiles, shown, records, edited }));
  }

  private answerNear(n: FarNode, reply: FarTreeReply<P>, asked: { readonly bake: string; readonly variant: string; readonly tiles: readonly { key: number; version: number }[]; readonly shown: string | null;
    readonly records: readonly (TileRecords | null)[] | undefined; readonly edited: boolean }): void {
    if (this.nodes.get(n.key) !== n || reply.sig !== n.nearAsked) return;
    n.nearCancel = null;
    switch (reply.kind) {
      case 'far': {
        // Built on the version drawn when asked: that version must still be the one drawn, else asked again whole.
        const base = reply.payload !== null ? this.kind.near!.baseOf(reply.payload) : null;
        if (base !== null && (!n.near || n.near.bake !== base || n.near.variant !== asked.variant)) {
          // DO NOT drop the page's records asking again: the store's older tile would be baked under the edit's version, the edit never drawn.
          this.submitNear(n, reply.sig, asked.bake, asked.variant, asked.tiles, asked.records, asked.edited);
          return;
        }
        // Still asked while it goes to the GPU (`landNear`): DO NOT ask it again every frame meanwhile.
        this.landNear(n, reply.payload, reply.sig, base !== null ? n.near : null);
        break;
      }
      case 'farRecords': {
        // No worker reads the store (the tests): the page reads the tiles, one empty where the store has none.
        const source = this.source;
        if (!source) { n.nearAsked = null; break; }
        const sig = reply.sig;
        void Promise.all(asked.tiles.map((t) => source.records(t.key).then((r) => r ?? emptyRecords(t.key, t.version)))).then((records) => {
          if (this.nodes.get(n.key) === n && n.nearAsked === sig) this.submitNear(n, sig, asked.bake, asked.variant, asked.tiles, records, asked.edited);
        }, (error: unknown) => {
          if (this.nodes.get(n.key) === n && n.nearAsked === sig) { n.nearAsked = null; n.nearFailed = sig; this.changed = true; }
          if (!this.warned) { this.warned = true; console.warn(`[${this.kind.name}] a tile could not be read from the store`, error); }
        });
        break;
      }
      case 'farError':
        if (!this.warned) { this.warned = true; console.warn(`[${this.kind.name}] a near level could not be baked; its far level stands`, reply.message); }
        n.nearAsked = null;
        n.nearFailed = reply.sig;
        break;
      default:
        n.nearAsked = null;
        n.nearFailed = reply.sig;
    }
    this.again();
  }

  /** A tile's near level come (null: no road near): its new blocks sent to the GPU, and drawn in place of the one before only once they are there (DO NOT upload a tile's roads in a frame: tens of megabytes); an answer built on the one drawn (`base`) keeps that one's other blocks. */
  private landNear(n: FarNode, payload: P | null, sig: string, base: FarNearLanded | null): void {
    // DO NOT throw away what is drawn or on its way to the GPU for an answer of the same content (a neighbour written, the same roads at another version): the upload restarted at every write, and the street view kept the far level (conferencia 09-street, 2026-10-17; found by the near-tiles session).
    const same = payload !== null ? this.kind.near!.contentOf?.(payload) : undefined;
    if (same) {
      const coming = n.nearComing;
      if (coming && coming.bake === same.bake && coming.variant === same.variant) {
        n.nearComingSig = sig;
        return;
      }
      if (!coming && n.near && n.near.bake === same.bake && n.near.variant === same.variant) {
        n.nearLanded = sig;
        if (n.nearAsked === sig) n.nearAsked = null;
        this.again();
        return;
      }
    }
    this.nearDropComing(n);
    if (payload === null) {
      this.dropNear(n);
      n.nearLanded = sig;
      if (n.nearAsked === sig) n.nearAsked = null;
      return;
    }
    const landed = this.kind.near!.land(payload, base);
    landed.group.visible = false;
    this.group.add(landed.group);
    n.nearComing = landed;
    n.nearComingSig = sig;
    gpuLedger.set(landed.group, `far ${this.kind.name} near`, landed.bytes, landed.triangles);
    const put = (): void => {
      if (n.nearComing !== landed) return;
      n.nearComing = null;
      const done = n.nearComingSig ?? sig;
      n.nearComingSig = null;
      // The one before goes now (the blocks the new one kept passed to it): the new one is on the GPU.
      if (n.near) {
        if (base === n.near) landed.adopt(n.near);
        this.letGoNear(n.near);
      }
      n.near = landed;
      n.nearLanded = done;
      if (n.nearAsked === done) n.nearAsked = null;
      this.nearResident.add(n);
      this.again();
    };
    const sent = warmLooseAhead(landed.meshes, () => this.nearPixelsOf(n));
    if (sent) void sent.then(put); else put();
  }

  /** What a tile's near level holds let go: off the GPU's book, out of the upload queue, its meshes freed. */
  private letGoNear(landed: FarNearLanded): void {
    gpuLedger.remove(landed.group);
    cancelWarm(landed.meshes);
    this.group.remove(landed.group);
    landed.dispose();
  }

  /** A near level on its way to the GPU given up (a newer one came, or the tile went). */
  private nearDropComing(n: FarNode): void {
    const coming = n.nearComing;
    if (!coming) return;
    n.nearComing = null;
    n.nearComingSig = null;
    this.letGoNear(coming);
  }

  /** A tile's near level let go, drawn or coming: baked again when wanted. */
  private dropNear(n: FarNode): void {
    // One let go on its way to the GPU closes its ask (none is under way): asked again when wanted.
    if (n.nearComing && !n.nearCancel) n.nearAsked = null;
    this.nearDropComing(n);
    if (n.near) this.letGoNear(n.near);
    n.near = null;
    n.nearLanded = null;
    this.nearResident.delete(n);
  }

  /** The nodes under one drawn already, without asking anything: whether they cover it. */
  private fallback(n: FarNode): boolean {
    let all = true;
    for (const c of n.children) {
      // With a plan, a quarter not made is not covered.
      if (!c) continue;
      if (this.covered(c)) continue;
      if (this.loadedOf(c) === 0 && c.landed !== null) { this.drawing.push(c); continue; }
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
      return null;
    });
  }

  private submit(n: FarNode, records?: TileRecords): void {
    const sig = n.asked!;
    const job: FarTreeJob = {
      node: n.key, k: n.k, i: n.i, j: n.j, sig, want: n.askedWant, prefix: this.keyPrefix,
      ...(n.k > 0 ? { children: this.childrenOf(n) } : {}),
      ...(records ? { records } : {}),
      // DO NOT carry a tile's records through the page when the worker can read the store: the page held every tile read while it waited for a worker.
      ...(!records && n.k === 0 && this.source?.workersRead ? { store: this.source.workersRead } : {}),
    };
    let settled = false;
    // DO NOT close over the records: the page would hold the tile read until its worker answered.
    const carried = records !== undefined;
    // A job that carried records frees its place for the next tile's once answered or cancelled.
    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (carried) { this.fetching--; this.pump(); }
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
    this.changed = true;
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
    const cost = geometryCost(landed.mesh.geometry);
    gpuLedger.set(landed.mesh, `far ${this.kind.name}`, cost.bytes, cost.triangles);
    // Sent ahead, the node covering most of the screen first: never uploaded mid-frame.
    void warmLooseAhead([landed.mesh], () => this.pixelsOf(n));
  }

  /** The pixels a node's height spans from the last eye: its upload's rank (`uploads.ts`). */
  /** The pixels a tile's near level leaves out while its far level stands, from the last eye: its upload's rank, by the measure the choice wants it by (`wantsNear`) and the cells' detail is ranked by (`layer.ts`). DO NOT rank it by the road's height: flat on the ground, it went behind every building in reach, and with the uploads a few MiB a frame (`uploads.ts` drainWarm) the street view showed the far level for seconds (conferencia 09-street, 2026-10-17). */
  private nearPixelsOf(n: FarNode): number {
    const e = this.eyeNow;
    measureSeen(this.ranked, e.x, e.y, e.z, e.pxAtMetre, e.orthoPx, n.x0, n.y0, n.x1, n.y1, n.top);
    return this.kind.near!.error * this.ranked.perMetre;
  }

  private pixelsOf(n: FarNode): number {
    const e = this.eyeNow;
    measureSeen(this.ranked, e.x, e.y, e.z, e.pxAtMetre, e.orthoPx, n.x0, n.y0, n.x1, n.y1, n.top);
    return n.top * this.ranked.perMetre;
  }

  private dropMesh(n: FarNode): void {
    if (!n.mesh) return;
    gpuLedger.remove(n.mesh);
    this.resident.delete(n);
    cancelWarm([n.mesh]);
    this.group.remove(n.mesh);
    n.mesh.geometry.dispose();
    n.mesh = null;
    n.landed = null;
  }

  /** Chosen again with the last eye once the answers of this turn are in (one walk for many answers). */
  private again(): void {
    // An answer came: the next choice is made whole.
    this.changed = true;
    if (this.scheduled || !this.eye) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const e = this.eye;
      // With the frustum it was chosen in: without it every node waited for counted as seen, behind the camera too.
      if (e) this.choose(e.x, e.y, e.z, e.pxAtMetre, e.orthoPx, e.reach, this.view);
    });
  }
}

/** Whether two frusta (or none) are the same: every plane's normal and constant. */
function sameView(a: Frustum | null, b: Frustum | null): boolean {
  if (a === null || b === null) return a === b;
  for (let i = 0; i < 6; i++) {
    const p = a.planes[i]!, q = b.planes[i]!;
    if (p.constant !== q.constant || !p.normal.equals(q.normal)) return false;
  }
  return true;
}

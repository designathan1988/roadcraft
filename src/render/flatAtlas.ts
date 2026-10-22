import { BufferAttribute, BufferGeometry, Group, Mesh, MeshStandardMaterial, type WebGLRenderer } from 'three';
import type { CoverKind, GeologyKind, PaintDab } from '@world/terrainPaint';
import { reliefHeight, type ReliefVersion, type TerrainStamp } from '@world/terrain';
import type { RoadDoc } from '@world/doc';
import { PLATE_SIZE, plateOf, plateRegion, platesOver } from '@world/bounds';
import { type ChangeKind, type ChangeRect, isStreaming } from '@world/changes';
import { plateDabs, sameList } from './platePaint';
import { JournalCursor } from '@world/derived';
import { GroundChanges } from './groundChanges';
import { cancelFlatGround, flatGroundOffPage, readFlatGround, setFlatGroundFocus } from './flatGroundPool';
import { readFarWoods } from './ecologyPool';
import { createFarForest } from './farForest';
import type { PlateMesh } from './plateMesh';
import type { WaterLook } from './water';
import {
  TERRAIN_BASE,
  TERRAIN_CELL,
  TERRAIN_HALF,
  createTerrainSurface,
  farLandMaterial,
  slabGeometry,
  wallMaterial,
  type PlateSurface,
  type TerrainPart,
  type TerrainRegion,
  type ShapeAsking,
  type TerrainShaper,
  type TerrainSource,
  type TerrainSurface,
} from './terrain';
import { m } from '@world/units';
import { Digest } from '@core/digest';
import type { Aabb } from '@core/aabb';
import type { NaturalPlate } from './groundShape';
import { GroundShare, type SharedGroundAt } from './sharedGround';
import { setJobFocus } from '../jobs/jobPool';
import { gpuLedger } from './gpuLedger';
import { measureHitch } from '@core/hitch';
import { cancelUploads, compilesAhead, programsReady, queueUpload } from './uploads';
import { MAP_HALF } from '@world/cityGen/wholeMap';
import { type FarNode, farNodesFor } from './farGround';
import { TILE, tileOfKey } from '@world/tiles';

/** THE WORLD'S GROUND, plate by plate of the unbounded grid (`world/bounds.ts`): the plates near the view made in full, a ring of far patches round it, nothing beyond */

const REGION_STRIDE = 1000;
/** DO NOT cap the plates by count: the six newest were kept wherever the view stood */
const KEEP_MARGIN = 1.25;
/** Most plates drawn in full near the view, unless the tier holds fewer (`setPlates`). */
export const NEAR_MOST = 9;
/** Most plates made but not drawn kept (nearest the view first), past the GPU's room: a view's worth, for a zoom out and back. DO NOT keep them by the GPU's room alone: a plate holds 10-20 MB of arrays on the page the GPU's book does not count (its corners, water, rock, ecosystem, paint), and every plate the view passed stayed made. */
export const CACHED_MOST = NEAR_MOST;
/** Beyond this much ground in view, no plate is drawn in full: the far mesh alone. */
const NEAR_VIEW = m(1400);
/** Corners along a plate's side (the terrain's grid). */
const SIDE = Math.round((2 * TERRAIN_HALF) / TERRAIN_CELL) + 1;
/** The kinds of change that put content on a plate (`readContent`): what the whole read marks. */
const CONTENT_KINDS: readonly ChangeKind[] = ['roads', 'buildings', 'lots', 'utilities', 'landscape', 'trees', 'barriers', 'terrain', 'paint'];
/** A load or an unload of a tile (CLAUDE.md, "Streaming world"): what a plate holds is read again from the document. */
const TILE_UNLOADED = 'tile unloaded';

/** THE MAP'S GROUND (`wholeMap.ts` MAP_HALF, the player's order: never a world without an edge): the plates of the map round the origin's plate (5 x 5 plates, 10 km; the map's edge lies on the plates' edges), drawn far as the quadtree's nodes the view asks (`farGround.ts`), its cut sides on the map's edge, nothing past it */
const FAR_RING = Math.round(MAP_HALF / PLATE_SIZE - 0.5);
/** The far mesh's slots at first (grown twice over when the view asks more nodes, `growFar`): a 10 km map's 25 plates. */
const FAR_SLOTS_FIRST = 32;
/** The view moved this far: the far nodes chosen again (a node's choice moves with its distance, never by less than a quad). */
const FAR_RESELECT = m(64);
/** Plates' woods at most (the level-0 nodes the view can ask, `farGround.ts`, for a map of any size; the shader's fades are sized by it). */
export const WOODS_MOST = 192;

class PlateSource implements TerrainSource {
  changes!: RoadDoc['changes'];
  terrainRevision = 0;
  terrainStamps: TerrainStamp[] = [];
  terrainRelief!: RoadDoc['terrainRelief'];
  natureRevision = 0;
  nature: RoadDoc['nature'] = null;
  paintRevision = 0;
  terrainPaint: PaintDab[] = [];
  stampSources: readonly TerrainStamp[] = [];
  paintSources: readonly PaintDab[] = [];
  /** The identities of the dabs laid (`dabKey`): a tile come back lays none of its own again. */
  laid = new Set<string>();
  terrainGround?: (x: number, y: number) => number;
}

interface Plate {
  /** Its key (`world/bounds.ts` `plateOf`) and centre. */
  readonly key: number;
  readonly cx: number;
  readonly cy: number;
  readonly source: PlateSource;
  /** The document's stamps and dabs that reach it, moved to its map (about its centre). */
  /** The copies, moved to the plate's map, of the stamps and dabs that reach it (`copyOn`): none for the others. */
  readonly stampCopies: WeakMap<TerrainStamp, TerrainStamp>;
  readonly dabCopies: WeakMap<PaintDab, PaintDab>;
  surface: PlateSurface | null;
  shown: boolean;
  /** Its surface's programs built (`uploads.ts` programsReady): not shown before, the far patch standing in. */
  ready: boolean;
  /** The land at the plate's grid corners, the base level added, read off the page (`flatGroundPool.ts`), rows from the north edge; null until then. */
  heights: Float64Array | null;
  /** Its first build made off the page, until the plate is made from it (`plateMesh.ts`). */
  mesh: PlateMesh | null;
  /** Whether its corners were asked of the workers (and not yet come back). */
  asked: boolean;
  /** The highest corner of its drawn ground, kept as it changes. */
  top: number;
}

/** A node of the far ground resident: what it is, its slot in the far mesh, and its woods' slot (level 0 only). */
interface FarResident {
  readonly node: FarNode;
  readonly slot: number;
  readonly woods: number;
}

/** Whether a disc reaches a plate (its square grown by the disc). */
const reaches = (p: { readonly cx: number; readonly cy: number }, x: number, y: number, radius: number): boolean =>
  Math.abs(x - p.cx) <= TERRAIN_HALF + radius && Math.abs(y - p.cy) <= TERRAIN_HALF + radius;

/** The far ground: a coarse patch of `FAR_QUADS` x `FAR_QUADS` quads per far plate, in world coordinates, each in its slot */
const FAR_QUADS = 32;
const FAR_SIDE = FAR_QUADS + 1;
const SKIRT = m(30);
const FAR_VERTS = FAR_SIDE * FAR_SIDE + 4 * FAR_SIDE;
const FAR_INDICES = FAR_QUADS * FAR_QUADS * 6 + 4 * FAR_QUADS * 12;
/** The far mesh's room: `slots` patches, written one slot at a time (`writeFarPatch`), drawn by the index (`farIndexInto`). */
export interface FlatFar { readonly geometry: BufferGeometry; readonly slots: number }
export function createFlatFar(slots: number): FlatFar {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(slots * FAR_VERTS * 3), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(slots * FAR_VERTS * 3), 3));
  geometry.setIndex(new BufferAttribute(new Uint32Array(slots * FAR_INDICES), 1));
  geometry.setDrawRange(0, 0);
  return { geometry, slots };
}

/** Writes plate (cx, cy)'s patch into `slot` from the land `ground` (the base added here), and marks only that slot to be sent. */
export function writeFarPatch(far: FlatFar, slot: number, cx: number, cy: number, ground: (x: number, y: number) => number): void {
  writeFarNode(far, slot, cx - TERRAIN_HALF, cy - TERRAIN_HALF, PLATE_SIZE / FAR_QUADS, SKIRT, ground);
}

const FAR_RING_SIDE = FAR_SIDE + 2;
/** `writeFarNode`'s heights, one array for every node written (each fills it whole before reading it). */
const farRingHeights = new Float64Array(FAR_RING_SIDE * FAR_RING_SIDE);

/** Writes the patch of `FAR_QUADS` quads of `step` from (x0, y0) into `slot`, its skirts `skirt` deep (a coarser node's sampling misses more: deeper), from the land `ground` (the base added here); marks only that slot to be sent. */
export function writeFarNode(far: FlatFar, slot: number, x0: number, y0: number, step: number, skirt: number, ground: (x: number, y: number) => number): void {
  const position = far.geometry.getAttribute('position') as BufferAttribute;
  const normal = far.geometry.getAttribute('normal') as BufferAttribute;
  const positions = position.array as Float32Array, normals = normal.array as Float32Array;
  // Heights on a ring one cell wider than the patch, for its normals.
  const RING = FAR_RING_SIDE;
  const h = farRingHeights;
  for (let j = 0; j < RING; j++) for (let i = 0; i < RING; i++) h[j * RING + i] = TERRAIN_BASE + ground(x0 + (i - 1) * step, y0 + (j - 1) * step);
  const first = slot * FAR_VERTS;
  let v = first;
  for (let j = 0; j < FAR_SIDE; j++) {
    for (let i = 0; i < FAR_SIDE; i++) {
      const y = h[(j + 1) * RING + i + 1]!;
      positions[v * 3] = x0 + i * step; positions[v * 3 + 1] = y; positions[v * 3 + 2] = -(y0 + j * step);
      // three's axes: x east, y up, z south.
      const nx = h[(j + 1) * RING + i]! - h[(j + 1) * RING + i + 2]!;
      const nz = h[(j + 2) * RING + i + 1]! - h[j * RING + i + 1]!;
      const ny = 2 * step;
      const len = Math.hypot(nx, ny, nz);
      normals[v * 3] = nx / len; normals[v * 3 + 1] = ny / len; normals[v * 3 + 2] = nz / len;
      v++;
    }
  }
  // The skirts' corners: each edge's hung below it (drawn or not by `farIndexInto`).
  const corner = (i: number, j: number): number => first + j * FAR_SIDE + i;
  for (let e = 0; e < 4; e++) {
    for (let k = 0; k < FAR_SIDE; k++) {
      const t = e === 0 ? corner(k, 0) : e === 1 ? corner(k, FAR_QUADS) : e === 2 ? corner(0, k) : corner(FAR_QUADS, k);
      positions[v * 3] = positions[t * 3]!; positions[v * 3 + 1] = positions[t * 3 + 1]! - skirt; positions[v * 3 + 2] = positions[t * 3 + 2]!;
      normals[v * 3] = normals[t * 3]!; normals[v * 3 + 1] = normals[t * 3 + 1]!; normals[v * 3 + 2] = normals[t * 3 + 2]!;
      v++;
    }
  }
  for (const attribute of [position, normal]) {
    attribute.addUpdateRange(first * 3, FAR_VERTS * 3);
    attribute.needsUpdate = true;
  }
}

/** A far patch to draw: its slot, which of its edges (south, north, west, east) are the ring's rim (no skirt: the cut side stands there), and how many of its quads lie on the map each way (all, `FAR_QUADS`, unless said). */
export interface FarPatchDrawn { readonly slot: number; readonly rim: readonly [boolean, boolean, boolean, boolean]; readonly quadsX?: number; readonly quadsY?: number }

/** Writes into the far ground's index the patches given (the far plates not drawn in full); returns how many indices. */
export function farIndexInto(far: FlatFar, patches: Iterable<FarPatchDrawn>): number {
  const index = far.geometry.getIndex()!;
  const all = index.array as Uint32Array;
  let w = 0;
  for (const { slot, rim, quadsX = FAR_QUADS, quadsY = FAR_QUADS } of patches) {
    const first = slot * FAR_VERTS;
    const corner = (i: number, j: number): number => first + j * FAR_SIDE + i;
    for (let j = 0; j < quadsY; j++) {
      for (let i = 0; i < quadsX; i++) {
        const p00 = corner(i, j), p10 = corner(i + 1, j), p01 = corner(i, j + 1), p11 = corner(i + 1, j + 1);
        // Counter-clockwise seen from above (east x north = up).
        all[w++] = p00; all[w++] = p10; all[w++] = p01;
        all[w++] = p10; all[w++] = p11; all[w++] = p01;
      }
    }
    for (let e = 0; e < 4; e++) {
      if (rim[e]) continue;
      const hung = first + FAR_SIDE * FAR_SIDE + e * FAR_SIDE;
      // Along the edge: as many quads as lie on the map (a node the ring's edge cuts is the rim on that side).
      for (let k = 0; k < (e < 2 ? quadsX : quadsY); k++) {
        const t0 = e === 0 ? corner(k, 0) : e === 1 ? corner(k, FAR_QUADS) : e === 2 ? corner(0, k) : corner(FAR_QUADS, k);
        const t1 = e === 0 ? corner(k + 1, 0) : e === 1 ? corner(k + 1, FAR_QUADS) : e === 2 ? corner(0, k + 1) : corner(FAR_QUADS, k + 1);
        const h0 = hung + k, h1 = hung + k + 1;
        // Both ways round: the skirt is seen from either side.
        all[w++] = t0; all[w++] = h0; all[w++] = t1;
        all[w++] = t1; all[w++] = h0; all[w++] = h1;
        all[w++] = t0; all[w++] = t1; all[w++] = h0;
        all[w++] = t1; all[w++] = h1; all[w++] = h0;
      }
    }
  }
  index.needsUpdate = true;
  index.clearUpdateRanges();
  index.addUpdateRange(0, w);
  far.geometry.setDrawRange(0, w);
  return w;
}

export function createFlatAtlas(anisotropy: number): TerrainSurface {
  /** The plates there are: made, being read off the page, or holding the document's share; never one per plate of a map (it has none). */
  const plates = new Map<number, Plate>();
  const root = new Group();
  root.name = 'flat-world-ground';
  /** The plates' corners in shared memory, each plate's own arrays: what the workers read the ground from (`sharedGround.ts`). */
  const share = new GroundShare(SIDE, TERRAIN_CELL, TERRAIN_HALF, TERRAIN_BASE);

  // The far ground: the terrain's material without a plate of its own (DO NOT make a whole plate, ~15 MB, for its material)
  const farGround = farLandMaterial(anisotropy);
  let far = createFlatFar(FAR_SLOTS_FIRST);
  const farMesh = new Mesh(far.geometry, farGround.material);
  farMesh.matrixAutoUpdate = false;
  farMesh.name = 'flat-world-far';
  farMesh.frustumCulled = false;
  farMesh.receiveShadow = true;
  farMesh.visible = false;
  root.add(farMesh);
  // THE SLAB round the far ring (SimCity 4's): its cut sides, the strata from the land down to the bedrock.
  const slab = new Mesh(new BufferGeometry(), wallMaterial(anisotropy));
  slab.name = 'flat-world-slab';
  slab.receiveShadow = true;
  slab.visible = false;
  root.add(slab);
  // THE WOODS OF THE FAR PLATES (`farForest.ts`)
  const farForest = createFarForest(WOODS_MOST, { side: SIDE, cell: TERRAIN_CELL, half: TERRAIN_HALF, base: TERRAIN_BASE, farQuads: FAR_QUADS }, readFarWoods);
  root.add(farForest.object);
  let focusX = 0, focusY = 0;
  /** The plates drawn in full and kept made at most, as the tier holds them (`setPlates`). */
  let nearMost = NEAR_MOST, keptMost = CACHED_MOST;
  /** How far from the view a made plate not drawn is kept (`KEEP_MARGIN`); set with the view (`focus`). */
  let keepReach = Infinity;
  let farRelief: ReliefVersion | null = null;

  // The far ground's nodes resident, by key, the slots free (`farGround.ts`): what the view's distance asks, never every plate of the map.
  const farNodes = new Map<string, FarResident>();
  const freeSlots: number[] = Array.from({ length: FAR_SLOTS_FIRST }, (_, i) => FAR_SLOTS_FIRST - 1 - i);
  const freeWoods: number[] = Array.from({ length: WOODS_MOST }, (_, i) => WOODS_MOST - 1 - i);
  let ringSet = false;
  /** Where the nodes were last chosen for. */
  let farAtX = NaN, farAtY = NaN;
  const writeFar = (r: FarResident): void => {
    const relief = farRelief;
    if (relief === null) return;
    const n = r.node;
    writeFarNode(far, r.slot, n.x0, n.y0, n.step, SKIRT * (1 << n.k), (x, y) => reliefHeight(relief, x, y));
  };
  /** The far mesh twice as roomy, every slot written kept (a new geometry: three r186 keeps a buffer's size). */
  const growFar = (): void => {
    const was = far;
    const next = createFlatFar(was.slots * 2);
    for (const name of ['position', 'normal'] as const) (next.geometry.getAttribute(name).array as Float32Array).set(was.geometry.getAttribute(name).array as Float32Array);
    for (let slot = next.slots - 1; slot >= was.slots; slot--) freeSlots.unshift(slot);
    far = next;
    farMesh.geometry = next.geometry;
    was.geometry.dispose();
    farDrawn = '';
  };
  /** The relief the slab was last made for: it reads the relief alone, never the far nodes the view asks (TER-15). */
  let slabRelief: ReliefVersion | null = null;
  /** The cut sides on the map's edge, along the far patches' own edge (their quads' step): where the land ends. */
  const buildSlab = (): void => {
    const relief = farRelief;
    if (relief === null || !ringSet || relief === slabRelief) return;
    slabRelief = relief;
    slab.geometry.dispose();
    slab.geometry = slabGeometry(-MAP_HALF, MAP_HALF, -MAP_HALF, MAP_HALF, PLATE_SIZE / FAR_QUADS, (x, y) => TERRAIN_BASE + reliefHeight(relief, x, y));
    slab.visible = true;
  };
  /** The slots the far index was last written with (their rims follow the ring). */
  let farDrawn = '';
  /** The far patches of the nodes resident, but a plate drawn in full. */
  const drawFar = (): void => {
    const patches: FarPatchDrawn[] = [];
    for (const r of farNodes.values()) {
      if (r.node.plate !== null && plates.get(r.node.plate)?.shown) continue;
      patches.push({ slot: r.slot, rim: r.node.rim, quadsX: r.node.quadsX, quadsY: r.node.quadsY });
    }
    // DO NOT write the whole far index again at each refresh (every edit of the content calls one): only when the patches it draws changed.
    const key = patches.map((p) => p.slot).join(',');
    if (key === farDrawn) return;
    farDrawn = key;
    farIndexInto(far, patches);
  };
  /** The far nodes the view over (x, y) asks (`farNodesFor`): the ones it no longer asks let go, the new ones written; true when they changed. */
  const followFar = (x: number, y: number): boolean => {
    if (ringSet && Math.hypot(x - farAtX, y - farAtY) < FAR_RESELECT) return false;
    ringSet = true;
    farAtX = x; farAtY = y;
    const want = farNodesFor(x, y, FAR_RING, FAR_QUADS);
    const kept = new Set(want.map((n) => n.key));
    let changed = false;
    for (const [key, r] of farNodes) {
      if (kept.has(key)) continue;
      farNodes.delete(key);
      freeSlots.push(r.slot);
      if (r.node.plate !== null) { farForest.book.drop(r.node.plate); freeWoods.push(r.woods); }
      changed = true;
    }
    // Nearest first: the woods asked in that order.
    want.sort((a, b) => Math.hypot(a.x0 + a.step * FAR_QUADS / 2 - x, a.y0 + a.step * FAR_QUADS / 2 - y) - Math.hypot(b.x0 + b.step * FAR_QUADS / 2 - x, b.y0 + b.step * FAR_QUADS / 2 - y));
    for (const node of want) {
      if (farNodes.has(node.key)) continue;
      if (!freeSlots.length) growFar();
      const woods = node.plate !== null ? freeWoods.pop() ?? -1 : -1;
      const r: FarResident = { node, slot: freeSlots.pop()!, woods };
      farNodes.set(node.key, r);
      writeFar(r);
      if (woods >= 0) farForest.book.add(node.plate!, woods, node.x0 + TERRAIN_HALF, node.y0 + TERRAIN_HALF);
      changed = true;
    }
    if (!changed) return false;
    drawFar();
    return true;
  };
  const buildFar = (relief: ReliefVersion): void => {
    if (relief === farRelief) return;
    farRelief = relief;
    for (const r of farNodes.values()) writeFar(r);
    buildSlab();
    farMesh.visible = true;
    drawFar();
  };

  let content = new Set<number>();
  let near: number[] = [];
  const shownList: Plate[] = [];
  /** The plates shown, each with its own surface: what changed on a plate is read off its own revisions, never a sum over them (`plateFollow.ts`). */
  let partsShown: TerrainPart[] = [];
  let lastSun: { x: number; y: number; z: number } | null = null;
  const lastLook = { waves: NaN, foam: NaN, current: NaN, windX: NaN, windZ: NaN, windSpeed: NaN };
  let lookGiven = false;
  let lastDoc: TerrainSource | null = null;
  let highest = 0;
  /** The map's own land before any stamp, world coordinates (`reliefHeight`). */
  let bare: (x: number, y: number) => number = () => 0;
  let seenRelief: ReliefVersion | null = null;

  /** A plate's highest drawn corner, read each time its ground moved (its levels keep it, `terrainLevels.ts`). */
  /** The atlas as its callers hold it, once made: told when a plate's levels land (`onLevels`). */
  let atlas: TerrainSurface | null = null;
  const measureTop = (p: Plate): void => {
    p.top = p.surface!.highest!();
  };
  const measureHighest = (): void => {
    highest = -Infinity;
    for (const p of shownList) if (p.top > highest) highest = p.top;
  };

  /** DO NOT remember a null for every stamp and dab that misses a plate (each plate's weak map held an entry for every dab of the map: plates x dabs, 59 MB in the city of 70,000 buildings, 2026-10-21): only the copies of those that reach it, the test (`reaches`) asked again for the others. */
  const copyOn = <T extends { readonly x: number; readonly y: number; readonly radius: number; readonly ox?: number; readonly oy?: number }>(copies: WeakMap<T, T>, p: Plate, item: T): T | null => {
    const known = copies.get(item);
    if (known !== undefined) return known;
    if (!reaches(p, item.x, item.y, item.radius)) return null;
    const local = { ...item, x: item.x - p.cx, y: item.y - p.cy, ...(item.ox !== undefined && item.oy !== undefined ? { ox: item.ox - p.cx, oy: item.oy - p.cy } : {}) };
    copies.set(item, local);
    return local;
  };
  /** A plate's stamps from the document: those that reach it, moved to its map; true when they changed. */
  const takeStamps = (p: Plate, doc: TerrainSource): boolean => {
    const sources = doc.terrainStamps.filter((s) => copyOn(p.stampCopies, p, s) !== null);
    if (p.source.terrainRevision !== 0 && sameList(sources, p.source.stampSources)) return false;
    p.source.stampSources = sources;
    p.source.terrainStamps = sources.map((s) => p.stampCopies.get(s) as TerrainStamp);
    p.source.terrainRevision = doc.terrainRevision;
    return true;
  };
  /** The plate's dabs brought up to the document's (`plateDabs`); `edited`: where a stroke changed them since (empty: only tiles came or went), null: the diary could not say. */
  const takePaint = (p: Plate, doc: TerrainSource, edited: readonly ChangeRect[] | null): void => {
    const reaching = doc.terrainPaint.filter((d) => copyOn(p.dabCopies, p, d) !== null);
    const next = plateDabs(p.source.paintSources, p.source.laid, reaching, edited);
    if (!next) return;
    p.source.paintSources = next;
    p.source.terrainPaint = next.map((d) => p.dabCopies.get(d) as PaintDab);
    p.source.paintRevision = doc.paintRevision;
  };
  /** A plate come into being: its share of the document read at once (each later change reaches it by `sync`). */
  const fill = (p: Plate, doc: TerrainSource): void => {
    p.source.changes = doc.changes;
    p.source.natureRevision = doc.natureRevision;
    p.source.nature = doc.nature;
    p.source.terrainRelief = doc.terrainRelief;
    p.source.terrainGround = (lx, ly) => groundOn(p, lx, ly);
    takeStamps(p, doc);
    takePaint(p, doc, null);
  };
  /** The plate of `key`, made a record (not a surface) the first time it is asked for. */
  const plateFor = (key: number): Plate => {
    let p = plates.get(key);
    if (p) return p;
    const r = plateRegion(key);
    p = {
      key, cx: r.cx, cy: r.cy, source: new PlateSource(), stampCopies: new WeakMap(), dabCopies: new WeakMap(),
      surface: null, shown: false, ready: false, heights: null, mesh: null, asked: false, top: -Infinity,
    };
    plates.set(key, p);
    if (lastDoc) fill(p, lastDoc);
    return p;
  };

  const ensure = (p: Plate): TerrainSurface => {
    if (p.surface) return p.surface;
    // Each step of a plate's making measured (F9 and the probes read hitch: measures).
    const t0 = performance.now();
    const s = createTerrainSurface(anisotropy, { x: p.cx, y: p.cy }, p.key, p.mesh, share.open(p.key));
    // A dab's levels come after it, off the page (`landStroke.ts`): the plate's top read again when they land, and the atlas's told on.
    s.onLevels = () => {
      if (p.surface !== s) return;
      measureTop(p);
      measureHighest();
      atlas?.onLevels?.();
    };
    // The surface keeps what it copied; the plate keeps only its corners (its land's field).
    p.mesh = null;
    const t1 = performance.now();
    p.surface = s;
    if (lastDoc) {
      s.update(p.source, false);
      const t2 = performance.now();
      s.updatePaint(p.source, true);
      measureHitch('hitch:flat-plate/update', t1, t2);
      measureHitch('hitch:flat-plate/paint', t2);
    }
    measureHitch('hitch:flat-plate/create', t0, t1);
    if (lastSun) s.setSun(lastSun);
    if (lookGiven) s.setWaterLook(lastLook);
    // Sent ahead of its first draw (`uploads.ts`), not inside it.
    queueUpload(...s.textures());
    // Shown once its programs are built (`uploads.ts` programsReady, the door's own variants): until then its far patch stands in, not a hole while the scene's door holds its meshes.
    p.ready = !compilesAhead();
    if (!p.ready) {
      programsWaited++;
      const shown = (): void => { programsWaited--; if (p.surface === s) { p.ready = true; contentCame = true; } };
      // DO NOT let a failed wait leave the plate on its far patch for good (no water, no road cut: conf52, conf54): a wait that throws or is rejected shows it all the same, three building its programs at its first draw.
      let waits: Promise<unknown>;
      try { waits = Promise.all((s.meshes as Mesh[]).map((mesh) => programsReady(mesh))); } catch (error) { waits = Promise.reject(error); }
      void waits.then(shown, (error: unknown) => { console.warn('[terrain] a plate\'s programs could not be built ahead; it is shown all the same', error); shown(); });
    }
    measureTop(p);
    return s;
  };
  const show = (p: Plate, on: boolean): void => {
    if (p.shown === on) return;
    p.shown = on;
    const s = p.surface!;
    if (on) root.add(...s.meshes); else root.remove(...s.meshes);
  };
  const geologySeen = new Map<Plate, number>();
  const letGo = (p: Plate): void => {
    if (!p.surface) return;
    show(p, false);
    // A texture still waiting to be sent would be sent by the queue after this dispose: its GL texture would outlive every reference to it.
    cancelUploads(p.surface.textures());
    p.surface.dispose();
    p.surface = null;
    // Read off the relief from now on, as `ask` reads it.
    share.close(p.key);
    // Its corners go too (725 kB a plate): read again if it comes back.
    p.heights = null;
    p.mesh = null;
    geologySeen.delete(p);
  };
  // The first plate made, at the origin: its materials are the ones the verges and the far ground lend (`vergeMaterial`), so it is never let go.
  const home = plateFor(plateOf(0, 0));
  const outOfReach = (p: Plate): boolean => Math.abs(p.cx - focusX) > keepReach || Math.abs(p.cy - focusY) > keepReach;
  /** A plate of the content waiting for its corners from the workers: the atlas refreshed when they come (`focus`). */
  let contentCame = false;
  /** Plates whose programs are being built before they are shown (`ensure`). */
  let programsWaited = 0;
  const refresh = (): void => {
    const wanted = new Set<number>(content);
    for (const key of near) wanted.add(key);
    // DO NOT make every plate wanted on the page in one frame (the whole city's at its opening): a plate whose corners the workers can read is asked for them and made when they come, the far patch standing in meanwhile (as the near ones, `focus`).
    const offPage = !failedOffPage && flatGroundOffPage();
    for (const key of wanted) {
      const p = plateFor(key);
      if (p.surface) continue;
      if (offPage && !p.heights && seenRelief !== null) askCorners(p); else ensure(p);
    }
    shownList.length = 0;
    const cached: Plate[] = [];
    for (const p of plates.values()) {
      if (!p.surface) continue;
      // Wanted but its programs still being built: neither shown nor let go (the far patch stands in).
      if (wanted.has(p.key) && !p.ready) { show(p, false); continue; }
      const want = wanted.has(p.key);
      show(p, want);
      if (want) shownList.push(p); else cached.push(p);
    }
    keepWithinBudget(cached);
    // A plate holding nothing any more (not made, not asked, out of reach) forgotten: made again from the document if it comes back.
    for (const p of plates.values()) {
      if (p !== home && !p.surface && !p.asked && !wanted.has(p.key) && !wantedNear.includes(p) && outOfReach(p)) plates.delete(p.key);
    }
    partsShown = shownList.map((p) => ({ surface: p.surface!, cx: p.cx, cy: p.cy }));
    drawFar();
    measureHighest();
  };
  /**
   * The plates made but not drawn kept, nearest the view first, `CACHED_MOST` at most and while the GPU's book has room for them past what it holds and the plates drawn:
   * DO NOT let every one go once the view takes in more than `NEAR_VIEW` (a zoom out and back made each again from nothing).
   */
  const keepWithinBudget = (cached: Plate[]): void => {
    let room = gpuLedger.cap - gpuLedger.bytes();
    for (const p of shownList) room -= p.surface!.gpuBytes();
    cached.sort((a, b) => Math.hypot(a.cx - focusX, a.cy - focusY) - Math.hypot(b.cx - focusX, b.cy - focusY));
    let kept = 0;
    for (const p of cached) {
      if (p === home) continue;
      room -= p.surface!.gpuBytes();
      if (room < 0 || ++kept > keptMost) letGo(p);
    }
  };

  let contentKey = '';
  /** DO NOT walk every node, building, lot, pole, plant and wall of the map at each change */
  const contentCursor = new JournalCursor(CONTENT_KINDS);
  const readContent = (doc: TerrainSource): boolean => {
    const d = doc as Partial<RoadDoc>;
    const key = [d.revision, d.buildings?.revision, d.lotRevision, d.utilityRevision, d.treeRevision, doc.terrainRevision, doc.paintRevision].join(':');
    if (key === contentKey) return false;
    contentKey = key;
    const entries = contentCursor.read(doc.changes);
    const loaded = (doc as Partial<RoadDoc>).loadedTiles;
    // An unloaded tile takes its records away: the plates it reaches asked again (DO NOT read the whole document at each tile let go).
    const unloads = entries?.some((e) => e.cause === TILE_UNLOADED) ?? false;
    if (entries && entries.every((e) => e.rects !== null) && (!unloads || loaded)) {
      const before = new Set(content);
      const emptied = new Set<number>();
      // Marked in place: the plates the changes reach (a stamp or paint has its rects too).
      for (const e of entries) {
        for (const rect of e.rects!) for (const k of platesOver(rect)) (e.cause === TILE_UNLOADED ? emptied : content).add(k);
      }
      for (const k of emptied) if (!plateHolds(doc, k, loaded!)) content.delete(k); else content.add(k);
      return content.size !== before.size || [...content].some((k) => !before.has(k));
    }
    return readWholeContent(doc);
  };
  /** Whether plate `key` holds anything after a tile left: a tile of the page in it (a tile lies in one plate), or a stamp or a dab reaching it. */
  const plateHolds = (doc: TerrainSource, key: number, loaded: ReadonlySet<number>): boolean => {
    const r = plateRegion(key);
    for (const t of loaded) {
      const { i, j } = tileOfKey(t);
      if (plateOf((i + 0.5) * TILE, (j + 0.5) * TILE) === key) return true;
    }
    const reach = (x: number, y: number, radius: number): boolean => Math.abs(x - r.cx) <= TERRAIN_HALF + radius && Math.abs(y - r.cy) <= TERRAIN_HALF + radius;
    return doc.terrainStamps.some((s) => reach(s.x, s.y, s.radius)) || doc.terrainPaint.some((d) => reach(d.x, d.y, d.radius));
  };
  /** @rebuild Every plate's content read from the whole document (the page's: the active region): the first time, an unload, or when the diary cannot say where. */
  const readWholeContent = (doc: TerrainSource): boolean => {
    const d = doc as Partial<RoadDoc>;
    const next = new Set<number>();
    const mark = (x: number, y: number): void => { next.add(plateOf(x, y)); };
    const disc = (x: number, y: number, r: number): void => { for (const k of platesOver([x - r, y - r, x + r, y + r])) next.add(k); };
    for (const n of d.nodes?.values() ?? []) mark(n.x, n.y);
    for (const b of d.buildings?.all() ?? []) mark(b.x, b.y);
    for (const l of d.lots ?? []) for (const c of l.corners) mark(c.x, c.y);
    for (const p of d.poles?.values() ?? []) mark(p.x, p.y);
    for (const item of d.landscape?.values() ?? []) mark(item.x, item.y);
    for (const tree of d.trees ?? []) mark(tree.x, tree.y);
    for (const barrier of d.barriers?.values() ?? []) for (const q of barrier.points) mark(q.x, q.y);
    // A stamp or a dab puts content on every plate its disc reaches (`copyOn`).
    for (const s of doc.terrainStamps) disc(s.x, s.y, s.radius);
    for (const dab of doc.terrainPaint) disc(dab.x, dab.y, dab.radius);
    const changed = next.size !== content.size || [...next].some((i) => !content.has(i));
    content = next;
    return changed;
  };

  let seenTerrain = -1;
  /** DO NOT filter the map's every stamp for every plate at each change: stamps times plates for one dab of the brush. */
  const terrainCursor = new JournalCursor(['terrain']);
  const paintCursor = new JournalCursor(['paint']);
  let seenPaint = -1;
  const sync = (doc: TerrainSource): void => {
    lastDoc = doc;
    for (const p of plates.values()) {
      p.source.changes = doc.changes;
      p.source.natureRevision = doc.natureRevision;
      p.source.nature = doc.nature;
    }
    if (doc.terrainRelief !== undefined) farForest.book.sync(doc.terrainRelief, doc.nature, focusX, focusY);
    if (doc.terrainRevision !== seenTerrain) {
      seenTerrain = doc.terrainRevision;
      const relief = doc.terrainRelief;
      const reliefMoved = seenRelief !== relief;
      seenRelief = relief;
      if (reliefMoved) { bare = (x, y) => reliefHeight(relief, x, y); share.setRelief(relief); }
      buildFar(relief);
      const entries = terrainCursor.read(doc.changes);
      const rects = entries && entries.every((e) => e.rects !== null) ? entries.flatMap((e) => e.rects!) : null;
      for (const p of plates.values()) {
        // A plate no change reached keeps its stamps as they were (the relief moved: every plate).
        if (!reliefMoved && rects && p.source.terrainRevision !== 0
          && !rects.some((r) => reaches(p, (r[0] + r[2]) / 2, (r[1] + r[3]) / 2, Math.hypot(r[2] - r[0], r[3] - r[1]) / 2))) continue;
        p.source.terrainRelief = relief;
        if (reliefMoved || !p.source.terrainGround) {
          if (reliefMoved) { p.heights = null; p.mesh = null; p.asked = false; }
          // Read over the plate's own corners (off the page), not the field again at each.
          p.source.terrainGround = (lx, ly) => groundOn(p, lx, ly);
        }
        if (reliefMoved) p.source.terrainRevision = 0;
        takeStamps(p, doc);
      }
    }
    if (doc.paintRevision !== seenPaint) {
      seenPaint = doc.paintRevision;
      // Tiles came or went (`isStreaming`): what each plate laid stays; a stroke: its rectangles say what to lay again (`plateDabs`).
      const entries = paintCursor.read(doc.changes);
      const edited = entries && entries.every((e) => e.rects !== null) ? entries.filter((e) => !isStreaming(e)).flatMap((e) => e.rects!) : null;
      // DO NOT filter the map's every dab for every plate at a dab: only the plates a stroke's rectangles reach (a dab's rectangle holds its disc); a tile come or gone, every plate (its dabs may reach past its square).
      const strokes = edited && !entries!.some(isStreaming) ? edited : null;
      for (const p of plates.values()) {
        if (strokes && !strokes.some((r) => r[2] >= p.cx - TERRAIN_HALF && r[0] <= p.cx + TERRAIN_HALF && r[3] >= p.cy - TERRAIN_HALF && r[1] <= p.cy + TERRAIN_HALF)) continue;
        takePaint(p, doc, edited);
      }
    }
    if (readContent(doc)) refresh();
  };
  /** A plate's land at a point of its map: its corners as the workers read them */
  function groundOn(p: Plate, lx: number, ly: number): number {
    const h = p.heights;
    if (h) {
      const gx = (lx + TERRAIN_HALF) / TERRAIN_CELL, gy = (TERRAIN_HALF - ly) / TERRAIN_CELL;
      if (gx >= 0 && gy >= 0 && gx <= SIDE - 1 && gy <= SIDE - 1) {
        const i = Math.min(SIDE - 2, Math.floor(gx)), j = Math.min(SIDE - 2, Math.floor(gy));
        const u = gx - i, v = gy - j, k = j * SIDE + i;
        const a = h[k]!, b = h[k + 1]!, c = h[k + SIDE]!, d = h[k + SIDE + 1]!;
        return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v - TERRAIN_BASE;
      }
    }
    return bare(p.cx + lx, p.cy + ly);
  }
  /** Asks the workers for a plate's corners, nearest the view first; the far patch stands in meanwhile (Proland). */
  const askCorners = (p: Plate): void => {
    if (p.asked || p.heights || p.surface || seenRelief === null) return;
    p.asked = true;
    const relief = seenRelief;
    readFlatGround({
      key: p.key, relief, at: { x: p.cx, y: p.cy }, cx: p.cx, cy: p.cy, half: TERRAIN_HALF, cell: TERRAIN_CELL, side: SIDE, base: TERRAIN_BASE,
      done: (mesh) => {
        p.asked = false;
        // A plate made meanwhile keeps the field it was made on; a relief changed meanwhile, the new one; a plate forgotten meanwhile, nothing.
        if (relief === seenRelief && !p.surface && plates.get(p.key) === p) { p.heights = mesh.heights; p.mesh = mesh; }
        if (content.has(p.key)) contentCame = true;
        focusKey = '';
      },
      failed: () => { p.asked = false; p.heights = null; p.mesh = null; failedOffPage = true; contentCame = true; focusKey = ''; },
    });
  };
  let failedOffPage = false;
  let focusKey = '';
  /** The plates the view wants in full, nearest first, and those of them made (reused: no allocation a frame). */
  const wantedNear: Plate[] = [];
  const nextNear: number[] = [];

  const decode = (region: TerrainRegion): { plate: Plate; local: TerrainRegion } => {
    const key = Math.floor(region[0] / REGION_STRIDE);
    const off = key * REGION_STRIDE;
    return { plate: plateFor(key), local: [region[0] - off, region[1] - off, region[2], region[3]] };
  };
  const encode = (p: Plate, region: TerrainRegion): TerrainRegion => {
    const off = p.key * REGION_STRIDE;
    return [region[0] + off, region[1] + off, region[2], region[3]];
  };
  /** A road field asked in a plate's own coordinates. */
  const shaperFor = (p: Plate, shape: TerrainShaper): TerrainShaper => ({
    shapeAt: (x, y, ground) => shape.shapeAt(x + p.cx, y + p.cy, ground),
    shapeBounds: () => shape.shapeBounds().map((b) => ({ minX: b.minX - p.cx, minY: b.minY - p.cy, maxX: b.maxX - p.cx, maxY: b.maxY - p.cy })),
  });

  let lastPlate: Plate | null = null;
  const geologyChanges = new GroundChanges();
  /** A point read off its plate's surface where the plate is made, otherwise off the land (`bareRead`, world coordinates): no plate made for a read. */
  const ask = <T>(x: number, y: number, read: (s: TerrainSurface, lx: number, ly: number) => T, bareRead: (x: number, y: number) => T): T => {
    const p = plates.get(plateOf(x, y));
    return p?.surface ? read(p.surface, x - p.cx, y - p.cy) : bareRead(x, y);
  };
  const bareAt = (x: number, y: number): number => TERRAIN_BASE + bare(x, y);

  ensure(home);
  followFar(0, 0);
  refresh();
  const firstSurface = home.surface!;
  atlas = {
    meshes: [root],
    highest: () => highest,
    onLevels: null,
    ground: firstSurface.ground,
    get parts() { return partsShown; },
    focus(x, y, reach) {
      // In full within some times the ground the view takes in (Proland's split rule), none from far out: the far mesh alone.
      setFlatGroundFocus(x, y);
      // The queued jobs ranked by their distance to it (`jobPool.ts`).
      setJobFocus(x, y);
      focusX = x;
      focusY = y;
      const ringMoved = followFar(x, y);
      const radius = reach < NEAR_VIEW ? Math.max(TERRAIN_HALF, reach * 1.6) + TERRAIN_HALF : -1;
      keepReach = radius > 0 ? radius * KEEP_MARGIN : 0;
      const key = `${plateOf(x, y)}:${Math.round(radius / TERRAIN_HALF)}`;
      if (key !== focusKey) {
        focusKey = key;
        wantedNear.length = 0;
        if (radius > 0) {
          // The plates whose centre is within the radius: those under its square, never a walk over the world's.
          for (const k of platesOver([x - radius, y - radius, x + radius, y + radius])) {
            const r = plateRegion(k);
            // Nothing past the map's edge: a plate off the map is never made.
            if (Math.abs(r.cx) > MAP_HALF || Math.abs(r.cy) > MAP_HALF) continue;
            if (Math.abs(r.cx - x) <= radius && Math.abs(r.cy - y) <= radius) wantedNear.push(plateFor(k));
          }
          wantedNear.sort((a, b) => Math.hypot(a.cx - x, a.cy - y) - Math.hypot(b.cx - x, b.cy - y));
          if (wantedNear.length > nearMost) wantedNear.length = nearMost;
        }
        for (const p of plates.values()) if (p.asked && !wantedNear.includes(p) && !content.has(p.key)) { cancelFlatGround(p.key); p.asked = false; }
      }
      // Every plate wanted whose corners are in made now (DO NOT make one a frame: they come ready from the workers, `plateMesh.ts`, and their textures go up the upload queue before they are first drawn); with no workers, on the page.
      const offPage = !failedOffPage && flatGroundOffPage();
      for (const p of wantedNear) {
        if (p.surface) continue;
        if (offPage && !p.heights) { askCorners(p); continue; }
        ensure(p);
      }
      // Drawn: the wanted plates that are made.
      nextNear.length = 0;
      for (const p of wantedNear) if (p.surface) nextNear.push(p.key);
      const came = contentCame;
      contentCame = false;
      if (!came && !ringMoved && nextNear.length === near.length && nextNear.every((v, k) => v === near[k]) && nextNear.every((k) => plates.get(k)?.shown)) return;
      near = nextNear.slice();
      refresh();
    },
    waiting() {
      if (contentCame || programsWaited > 0) return true;
      for (const p of plates.values()) if (p.asked) return true;
      return false;
    },
    setSun(direction) {
      lastSun = direction;
      for (const p of shownList) p.surface!.setSun(direction);
    },
    bakeRelief(renderer: WebGLRenderer) {
      // The far woods: each far plate's fade from whether it is in full and its own trees can grow.
      const now = performance.now() / 1000;
      for (const r of farNodes.values()) {
        if (r.woods < 0) continue;
        const p = plates.get(r.node.plate!);
        farForest.book.setFull(r.node.plate!, p?.shown ?? false, p?.surface?.ecology() != null, now);
      }
      farForest.update(renderer, now);
      // Each plate drawn sends the paint a stroke laid since the last frame (`terrain.ts` flushPaint).
      for (const p of shownList) p.surface!.bakeRelief(renderer, null);
    },
    setWaterLook(look: WaterLook) {
      const was = lastLook;
      if (was.waves === look.waves && was.foam === look.foam && was.current === look.current
        && was.windX === look.windX && was.windZ === look.windZ && was.windSpeed === look.windSpeed) return;
      Object.assign(was, look);
      lookGiven = true;
      for (const p of plates.values()) p.surface?.setWaterLook(look);
    },
    // The gullies were drawn by the fine relief alone, which nothing the ground draws read (`terrain.ts` `bakeRelief`).
    setGullies() {},

    setVegetation(amount) {
      farForest.book.setVegetation(amount);
    },
    setPlates(nearPlates, keptPlates) {
      const n = Math.max(1, Math.min(NEAR_MOST, Math.floor(nearPlates))), k = Math.max(0, Math.min(CACHED_MOST, Math.floor(keptPlates)));
      if (n === nearMost && k === keptMost) return;
      nearMost = n; keptMost = k;
      // The plates wanted chosen again at the next focus, the ones past the caps let go now.
      focusKey = '';
      refresh();
    },
    vergeMaterial: firstSurface.vergeMaterial,
    meshMaterial: firstSurface.meshMaterial,
    lookFrom(camera, pixels) {
      for (const p of shownList) p.surface!.lookFrom?.(camera, pixels);
    },
    heightAt: (x, y) => ask(x, y, (s, lx, ly) => s.heightAt(lx, ly), bareAt),
    naturalRenderedHeightAt: (x, y) => ask(x, y, (s, lx, ly) => s.naturalRenderedHeightAt(lx, ly), bareAt),
    // With the shared plates it reads, for a worker to read the same ground (`cellPool.ts`).
    renderedHeightAt: Object.assign((x: number, y: number): number => ask(x, y, (s, lx, ly) => s.renderedHeightAt(lx, ly), bareAt), { share }) satisfies SharedGroundAt,
    wetAt: (x, y) => ask(x, y, (s, lx, ly) => s.wetAt(lx, ly), () => false),
    // Every plate the box reaches, each read over its own part (a box across a plate's edge read one plate before: the other's ground was left out).
    digest(minX, minY, maxX, maxY) {
      const one = (key: number, x0: number, y0: number, x1: number, y1: number): number => {
        const p = plates.get(key);
        if (!p?.surface) return key * 7919 + (seenRelief ?? 0) * 31 + 1;
        return p.surface.digest(x0 - p.cx, y0 - p.cy, x1 - p.cx, y1 - p.cy) + p.key;
      };
      const keys = platesOver([minX, minY, maxX, maxY]);
      if (keys.length === 1) return one(keys[0]!, minX, minY, maxX, maxY);
      const out = new Digest();
      for (const key of keys) {
        const r = plateRegion(key);
        out.add(one(key, Math.max(minX, r.cx - r.half), Math.max(minY, r.cy - r.half), Math.min(maxX, r.cx + r.half), Math.min(maxY, r.cy + r.half)));
      }
      return out.value();
    },
    update(doc, stroking) {
      sync(doc);
      let moved = false;
      for (const p of shownList) {
        if (!p.surface!.update(p.source, stroking)) continue;
        moved = true;
        lastPlate = p;
        measureTop(p);
      }
      if (moved) measureHighest();
      return moved;
    },
    updatePaint(doc) {
      sync(doc);
      for (const p of shownList) {
        p.surface!.updatePaint(p.source, false);
        const log = p.surface!.geologyChanges, v = log.version, was = geologySeen.get(p);
        if (v === was) continue;
        geologySeen.set(p, v);
        // DO NOT mark every plate's ground for one plate's geology: its own rectangles, or its square when it came or its log cannot say.
        const rects = was === undefined ? null : log.rectsSince(was);
        geologyChanges.mark(rects ? rects.map((r) => [r[0] + p.cx, r[1] + p.cy, r[2] + p.cx, r[3] + p.cy] as const)
          : [[p.cx - TERRAIN_HALF, p.cy - TERRAIN_HALF, p.cx + TERRAIN_HALF, p.cy + TERRAIN_HALF]]);
      }
    },
    forestAt: (x, y) => ask(x, y, (s, lx, ly) => s.forestAt(lx, ly), () => 0),
    coverAt: (kind: CoverKind, x, y) => ask(x, y, (s, lx, ly) => s.coverAt(kind, lx, ly), () => 0),
    geologyAt: (x, y) => ask(x, y, (s, lx, ly) => s.geologyAt(lx, ly), (): GeologyKind => firstSurface.geologyAt(0, 0)),
    ecology: () => firstSurface.ecology(),
    geologyChanges,
    // DO NOT merge the plates' ecology or water into one revision or one box: each part's own surface says (`plateFollow.ts`)
    shoreLevelAt: (x, y) => ask(x, y, (s, lx, ly) => s.shoreLevelAt(lx, ly), () => null),
    get lastRegion() {
      const region = lastPlate?.surface?.lastRegion ?? null;
      return region && lastPlate ? encode(lastPlate, region) : null;
    },
    settle() { for (const p of shownList) p.surface!.settle(); },
    shapeToRoads(shape, region = null) {
      const list: readonly TerrainRegion[] | null = region === null ? null
        : typeof region[0] === 'number' ? [region as TerrainRegion] : region as readonly TerrainRegion[];
      let moved = false;
      if (list === null) {
        for (const p of shownList) if (p.surface!.shapeToRoads(shape && shaperFor(p, shape), null)) { moved = true; measureTop(p); }
        if (moved) measureHighest();
        return moved;
      }
      const byPlate = new Map<Plate, TerrainRegion[]>();
      for (const r of list) {
        const { plate, local } = decode(r);
        let mine = byPlate.get(plate);
        if (!mine) byPlate.set(plate, mine = []);
        mine.push(local);
      }
      for (const [p, regions] of byPlate) if (ensure(p).shapeToRoads(shape && shaperFor(p, shape), regions)) { moved = true; measureTop(p); }
      if (moved) measureHighest();
      return moved;
    },
    askShape(region, bounds) {
      const list: readonly TerrainRegion[] | null = region === null ? null
        : typeof region[0] === 'number' ? [region as TerrainRegion] : region as readonly TerrainRegion[];
      // Each plate's pass, as `shapeToRoads` above makes them: the plates shown, or those the regions name.
      const parts: { p: Plate; s: TerrainSurface; asking: ShapeAsking }[] = [];
      if (list === null) {
        const local = (p: Plate): Aabb[] | null => bounds && bounds.map((b) => ({ minX: b.minX - p.cx, minY: b.minY - p.cy, maxX: b.maxX - p.cx, maxY: b.maxY - p.cy }));
        for (const p of shownList) parts.push({ p, s: p.surface!, asking: p.surface!.askShape(null, local(p)) });
      } else {
        const byPlate = new Map<Plate, TerrainRegion[]>();
        for (const r of list) {
          const { plate, local } = decode(r);
          let mine = byPlate.get(plate);
          if (!mine) byPlate.set(plate, mine = []);
          mine.push(local);
        }
        for (const [p, regions] of byPlate) { const s = ensure(p); parts.push({ p, s, asking: s.askShape(regions, null) }); }
      }
      return {
        plates: parts.flatMap(({ p, asking }) => asking.plates.map((a) => ({ ...a, cx: p.cx, cy: p.cy }))),
        take(answers) {
          let moved = false;
          let k = 0;
          for (const { p, s, asking } of parts) {
            const mine = answers.slice(k, k += asking.plates.length);
            // A plate let go meanwhile took its ground with it, as it would have with the pass made here.
            if (p.surface !== s) continue;
            if (asking.take(mine)) { moved = true; measureTop(p); }
          }
          if (moved) measureHighest();
          return moved;
        },
      };
    },
    naturalCut(boxes) {
      const out = new Map<number, NaturalPlate>();
      for (const box of boxes) {
        for (const [x, y] of [[box[0], box[1]], [box[2], box[1]], [box[0], box[3]], [box[2], box[3]]] as const) {
          const p = plates.get(plateOf(x, y));
          const corners = p?.surface?.naturalCorners?.();
          if (!p || !corners || out.has(p.key)) continue;
          out.set(p.key, { index: p.key, cx: p.cx, cy: p.cy, n: SIDE, cell: TERRAIN_CELL, half: TERRAIN_HALF, ...corners });
        }
      }
      return [...out.values()];
    },
    regionOf(box) {
      const p = plateFor(plateOf((box[0] + box[2]) / 2, (box[1] + box[3]) / 2));
      return encode(p, ensure(p).regionOf([box[0] - p.cx, box[1] - p.cy, box[2] - p.cx, box[3] - p.cy]));
    },
    rectOf(region) {
      const { plate, local } = decode(region);
      const r = ensure(plate).rectOf(local);
      return [r[0] + plate.cx, r[1] + plate.cy, r[2] + plate.cx, r[3] + plate.cy];
    },
    dispose() {
      for (const p of plates.values()) p.surface?.dispose();
      farGround.dispose();
      farForest.dispose();
      far.geometry.dispose();
      slab.geometry.dispose();
      (slab.material as MeshStandardMaterial).map?.dispose();
      (slab.material as MeshStandardMaterial).dispose();
    },
  };
  return atlas;
}

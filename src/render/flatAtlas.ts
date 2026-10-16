import { BufferAttribute, BufferGeometry, Group, Mesh, MeshStandardMaterial, type WebGLRenderer } from 'three';
import type { CoverKind, GeologyKind, PaintDab } from '@world/terrainPaint';
import { reliefHeight, type ReliefVersion, type TerrainStamp } from '@world/terrain';
import type { RoadDoc } from '@world/doc';
import { PLATE_SIZE, plateIJ, plateOf, plateRegion, platesAround, platesOver } from '@world/bounds';
import type { ChangeKind } from '@world/changes';
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
  slabGeometry,
  wallMaterial,
  type TerrainPart,
  type TerrainRegion,
  type ShapeAsking,
  type TerrainShaper,
  type TerrainSource,
  type TerrainSurface,
} from './terrain';
import { m } from '@world/units';
import type { Aabb } from '@core/aabb';
import type { NaturalPlate } from './groundShape';
import { GroundShare, type SharedGroundAt } from './sharedGround';
import { setJobFocus } from '../jobs/jobPool';

/** THE WORLD'S GROUND, plate by plate of the unbounded grid (`world/bounds.ts`): the plates near the view made in full, a ring of far patches round it, nothing beyond */

const REGION_STRIDE = 1000;
/** DO NOT cap the plates by count: the six newest were kept wherever the view stood */
const KEEP_MARGIN = 1.25;
/** Most plates drawn in full near the view. */
const NEAR_MOST = 9;
/** Beyond this much ground in view, no plate is drawn in full: the far mesh alone. */
const NEAR_VIEW = m(1400);
/** Corners along a plate's side (the terrain's grid). */
const SIDE = Math.round((2 * TERRAIN_HALF) / TERRAIN_CELL) + 1;
/** The kinds of change that put content on a plate (`readContent`): what the whole read marks. */
const CONTENT_KINDS: readonly ChangeKind[] = ['roads', 'buildings', 'lots', 'utilities', 'landscape', 'trees', 'barriers', 'terrain', 'paint'];
/** A load or an unload of a tile (CLAUDE.md, "Streaming world"): what a plate holds is read again from the document. */
const TILE_UNLOADED = 'tile unloaded';

/** THE FAR RING: plates each way from the ring's centre plate drawn as far patches (7 x 7 plates, about 14 km), its cut sides round it */
const FAR_RING = 3;
/** Far plates there are at once: the ring's square, each in its own slot of the far mesh and of the far woods. */
const FAR_SLOTS = (2 * FAR_RING + 1) ** 2;
/** How far the view's focus goes from the ring's centre plate before the ring follows it: a quarter plate past its edge, so a focus on an edge does not swap a row of plates back and forth. */
const RING_HOLD = PLATE_SIZE * 0.75;
/** The far ground stands in for no surface of its own: no plate has this key. */
const FAR_SURFACE_KEY = -1;

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
  terrainGround?: (x: number, y: number) => number;
}

interface Plate {
  /** Its key (`world/bounds.ts` `plateOf`) and centre. */
  readonly key: number;
  readonly cx: number;
  readonly cy: number;
  readonly source: PlateSource;
  /** The document's stamps and dabs that reach it, moved to its map (about its centre). */
  readonly stampCopies: WeakMap<TerrainStamp, TerrainStamp | null>;
  readonly dabCopies: WeakMap<PaintDab, PaintDab | null>;
  surface: TerrainSurface | null;
  shown: boolean;
  /** The land at the plate's grid corners, the base level added, read off the page (`flatGroundPool.ts`), rows from the north edge; null until then. */
  heights: Float64Array | null;
  /** Its first build made off the page, until the plate is made from it (`plateMesh.ts`). */
  mesh: PlateMesh | null;
  /** Whether its corners were asked of the workers (and not yet come back). */
  asked: boolean;
  /** The highest corner of its drawn ground, kept as it changes. */
  top: number;
}

/** A plate of the far ring: where it stands and its slot. */
interface FarPlate {
  readonly key: number;
  readonly cx: number;
  readonly cy: number;
  readonly slot: number;
}

const sameList = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
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
  const position = far.geometry.getAttribute('position') as BufferAttribute;
  const normal = far.geometry.getAttribute('normal') as BufferAttribute;
  const positions = position.array as Float32Array, normals = normal.array as Float32Array;
  const step = PLATE_SIZE / FAR_QUADS;
  // Heights on a ring one cell wider than the patch, for its normals.
  const RING = FAR_SIDE + 2;
  const h = new Float64Array(RING * RING);
  const x0 = cx - TERRAIN_HALF, y0 = cy - TERRAIN_HALF;
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
      positions[v * 3] = positions[t * 3]!; positions[v * 3 + 1] = positions[t * 3 + 1]! - SKIRT; positions[v * 3 + 2] = positions[t * 3 + 2]!;
      normals[v * 3] = normals[t * 3]!; normals[v * 3 + 1] = normals[t * 3 + 1]!; normals[v * 3 + 2] = normals[t * 3 + 2]!;
      v++;
    }
  }
  for (const attribute of [position, normal]) {
    attribute.addUpdateRange(first * 3, FAR_VERTS * 3);
    attribute.needsUpdate = true;
  }
}

/** A far patch to draw: its slot, and which of its edges (south, north, west, east) are the ring's rim (no skirt: the cut side stands there). */
export interface FarPatchDrawn { readonly slot: number; readonly rim: readonly [boolean, boolean, boolean, boolean] }

/** Writes into the far ground's index the patches given (the far plates not drawn in full); returns how many indices. */
export function farIndexInto(far: FlatFar, patches: Iterable<FarPatchDrawn>): number {
  const index = far.geometry.getIndex()!;
  const all = index.array as Uint32Array;
  let w = 0;
  for (const { slot, rim } of patches) {
    const first = slot * FAR_VERTS;
    const corner = (i: number, j: number): number => first + j * FAR_SIDE + i;
    for (let j = 0; j < FAR_QUADS; j++) {
      for (let i = 0; i < FAR_QUADS; i++) {
        const p00 = corner(i, j), p10 = corner(i + 1, j), p01 = corner(i, j + 1), p11 = corner(i + 1, j + 1);
        // Counter-clockwise seen from above (east x north = up).
        all[w++] = p00; all[w++] = p10; all[w++] = p01;
        all[w++] = p10; all[w++] = p11; all[w++] = p01;
      }
    }
    for (let e = 0; e < 4; e++) {
      if (rim[e]) continue;
      const hung = first + FAR_SIDE * FAR_SIDE + e * FAR_SIDE;
      for (let k = 0; k < FAR_QUADS; k++) {
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

  // The far ground: a surface of its own lends the terrain's material
  const farSurface = createTerrainSurface(anisotropy, { x: 0, y: 0 }, FAR_SURFACE_KEY);
  const far = createFlatFar(FAR_SLOTS);
  const farMesh = new Mesh(far.geometry, farSurface.meshMaterial);
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
  const farForest = createFarForest(FAR_SLOTS, { side: SIDE, cell: TERRAIN_CELL, half: TERRAIN_HALF, base: TERRAIN_BASE, farQuads: FAR_QUADS }, readFarWoods);
  root.add(farForest.object);
  let focusX = 0, focusY = 0;
  /** How far from the view a made plate not drawn is kept (`KEEP_MARGIN`); set with the view (`focus`). */
  let keepReach = Infinity;
  let farRelief: ReliefVersion | null = null;

  // The far ring: its centre plate, its plates by key, the slots free.
  const farPlates = new Map<number, FarPlate>();
  const freeSlots: number[] = Array.from({ length: FAR_SLOTS }, (_, i) => FAR_SLOTS - 1 - i);
  let ringI = 0, ringJ = 0;
  let ringSet = false;
  const writeFar = (fp: FarPlate): void => {
    const relief = farRelief;
    if (relief === null) return;
    writeFarPatch(far, fp.slot, fp.cx, fp.cy, (x, y) => reliefHeight(relief, x, y));
  };
  /** The cut sides round the ring's square, along the far patches' own edge (their quads' step). */
  const buildSlab = (): void => {
    const relief = farRelief;
    if (relief === null || !ringSet) return;
    const reach = (FAR_RING + 0.5) * PLATE_SIZE;
    const cx = ringI * PLATE_SIZE, cy = ringJ * PLATE_SIZE;
    slab.geometry.dispose();
    slab.geometry = slabGeometry(cx - reach, cx + reach, cy - reach, cy + reach, PLATE_SIZE / FAR_QUADS, (x, y) => TERRAIN_BASE + reliefHeight(relief, x, y));
    slab.visible = true;
  };
  const neighbour = (fp: FarPlate, di: number, dj: number): boolean => farPlates.has(plateOf(fp.cx + di * PLATE_SIZE, fp.cy + dj * PLATE_SIZE));
  /** The far patches of the plates not drawn in full, their rims where the ring ends. */
  const drawFar = (): void => {
    const patches: FarPatchDrawn[] = [];
    for (const fp of farPlates.values()) {
      if (plates.get(fp.key)?.shown) continue;
      patches.push({ slot: fp.slot, rim: [!neighbour(fp, 0, -1), !neighbour(fp, 0, 1), !neighbour(fp, -1, 0), !neighbour(fp, 1, 0)] });
    }
    farIndexInto(far, patches);
  };
  /** The ring follows the focus once it is `RING_HOLD` off the centre plate: the plates that left it let go, those come in written; true when it moved. */
  const moveRing = (x: number, y: number): boolean => {
    if (ringSet && Math.abs(x - ringI * PLATE_SIZE) <= RING_HOLD && Math.abs(y - ringJ * PLATE_SIZE) <= RING_HOLD) return false;
    ({ pi: ringI, pj: ringJ } = plateIJ(x, y));
    ringSet = true;
    const want = platesAround(ringI, ringJ, FAR_RING);
    const kept = new Set(want);
    for (const [key, fp] of farPlates) {
      if (kept.has(key)) continue;
      farPlates.delete(key);
      freeSlots.push(fp.slot);
      farForest.book.drop(key);
    }
    // Nearest first: the woods asked in that order.
    for (const key of want) {
      if (farPlates.has(key)) continue;
      const r = plateRegion(key);
      const fp: FarPlate = { key, cx: r.cx, cy: r.cy, slot: freeSlots.pop()! };
      farPlates.set(key, fp);
      writeFar(fp);
      farForest.book.add(key, fp.slot, fp.cx, fp.cy);
    }
    buildSlab();
    drawFar();
    return true;
  };
  const buildFar = (relief: ReliefVersion): void => {
    if (relief === farRelief) return;
    farRelief = relief;
    for (const fp of farPlates.values()) writeFar(fp);
    buildSlab();
    farMesh.visible = true;
    drawFar();
  };

  let content = new Set<number>();
  let near: number[] = [];
  const shownList: Plate[] = [];
  let partsShown: TerrainPart[] = [];
  let shownVersion = 0;
  let lastSun: { x: number; y: number; z: number } | null = null;
  const lastLook = { waves: NaN, foam: NaN, current: NaN, windX: NaN, windZ: NaN, windSpeed: NaN };
  let lookGiven = false;
  let lastDoc: TerrainSource | null = null;
  let highest = 0;
  /** The map's own land before any stamp, world coordinates (`reliefHeight`). */
  let bare: (x: number, y: number) => number = () => 0;
  let seenRelief: ReliefVersion | null = null;

  /** A plate's highest drawn corner, read each time its ground moved (its levels keep it, `terrainLevels.ts`). */
  const measureTop = (p: Plate): void => {
    p.top = p.surface!.highest!();
  };
  const measureHighest = (): void => {
    highest = -Infinity;
    for (const p of shownList) if (p.top > highest) highest = p.top;
  };

  const copyOn = <T extends { readonly x: number; readonly y: number; readonly radius: number; readonly ox?: number; readonly oy?: number }>(copies: WeakMap<T, T | null>, p: Plate, item: T): T | null => {
    let local = copies.get(item);
    if (local === undefined) {
      copies.set(item, local = reaches(p, item.x, item.y, item.radius)
        ? { ...item, x: item.x - p.cx, y: item.y - p.cy, ...(item.ox !== undefined && item.oy !== undefined ? { ox: item.ox - p.cx, oy: item.oy - p.cy } : {}) }
        : null);
    }
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
  const takePaint = (p: Plate, doc: TerrainSource): void => {
    const sources = doc.terrainPaint.filter((d) => copyOn(p.dabCopies, p, d) !== null);
    if (sameList(sources, p.source.paintSources)) return;
    p.source.paintSources = sources;
    p.source.terrainPaint = sources.map((d) => p.dabCopies.get(d) as PaintDab);
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
    takePaint(p, doc);
  };
  /** The plate of `key`, made a record (not a surface) the first time it is asked for. */
  const plateFor = (key: number): Plate => {
    let p = plates.get(key);
    if (p) return p;
    const r = plateRegion(key);
    p = {
      key, cx: r.cx, cy: r.cy, source: new PlateSource(), stampCopies: new WeakMap(), dabCopies: new WeakMap(),
      surface: null, shown: false, heights: null, mesh: null, asked: false, top: -Infinity,
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
    // The surface keeps what it copied; the plate keeps only its corners (its land's field).
    p.mesh = null;
    const t1 = performance.now();
    p.surface = s;
    if (lastDoc) {
      s.update(p.source, false);
      const t2 = performance.now();
      s.updatePaint(p.source, true);
      performance.measure('hitch:flat-plate/update', { start: t1, end: t2 });
      performance.measure('hitch:flat-plate/paint', { start: t2, end: performance.now() });
    }
    performance.measure('hitch:flat-plate/create', { start: t0, end: t1 });
    if (lastSun) s.setSun(lastSun);
    if (lookGiven) s.setWaterLook(lastLook);
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
  const refresh = (): void => {
    const wanted = new Set<number>(content);
    for (const key of near) wanted.add(key);
    for (const key of wanted) ensure(plateFor(key));
    shownList.length = 0;
    const cached: Plate[] = [];
    for (const p of plates.values()) {
      if (!p.surface) continue;
      const want = wanted.has(p.key);
      show(p, want);
      if (want) shownList.push(p); else cached.push(p);
    }
    for (const p of cached) if (p !== home && outOfReach(p)) letGo(p);
    // A plate holding nothing any more (not made, not asked, out of reach) forgotten: made again from the document if it comes back.
    for (const p of plates.values()) {
      if (p !== home && !p.surface && !p.asked && !wanted.has(p.key) && !wantedNear.includes(p) && outOfReach(p)) plates.delete(p.key);
    }
    if (shownList.length !== partsShown.length || shownList.some((p, k) => partsShown[k]!.surface !== p.surface)) shownVersion++;
    partsShown = shownList.map((p) => ({ surface: p.surface!, cx: p.cx, cy: p.cy }));
    drawFar();
    measureHighest();
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
    // An unloaded tile takes its records away: what each plate still holds is only known from the document (the active region's).
    if (entries && entries.every((e) => e.rects !== null) && !entries.some((e) => e.cause === TILE_UNLOADED)) {
      // Marked in place: the plates the changes reach (a stamp or paint has its rects too).
      const before = content.size;
      for (const e of entries) for (const rect of e.rects!) for (const k of platesOver(rect)) content.add(k);
      return content.size !== before;
    }
    return readWholeContent(doc);
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
      for (const p of plates.values()) takePaint(p, doc);
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
        focusKey = '';
      },
      failed: () => { p.asked = false; p.heights = null; p.mesh = null; failedOffPage = true; focusKey = ''; },
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
  const sum = (read: (s: TerrainSurface) => number): number => {
    let total = 0;
    for (const p of shownList) total += read(p.surface!);
    return total;
  };
  /** A point read off its plate's surface where the plate is made, otherwise off the land (`bareRead`, world coordinates): no plate made for a read. */
  const ask = <T>(x: number, y: number, read: (s: TerrainSurface, lx: number, ly: number) => T, bareRead: (x: number, y: number) => T): T => {
    const p = plates.get(plateOf(x, y));
    return p?.surface ? read(p.surface, x - p.cx, y - p.cy) : bareRead(x, y);
  };
  const bareAt = (x: number, y: number): number => TERRAIN_BASE + bare(x, y);

  ensure(home);
  moveRing(0, 0);
  refresh();
  const firstSurface = home.surface!;
  return {
    meshes: [root],
    highest: () => highest,
    ground: firstSurface.ground,
    get parts() { return partsShown; },
    focus(x, y, reach) {
      // In full within some times the ground the view takes in (Proland's split rule), none from far out: the far mesh alone.
      setFlatGroundFocus(x, y);
      // The queued jobs ranked by their distance to it (`jobPool.ts`).
      setJobFocus(x, y);
      focusX = x;
      focusY = y;
      const ringMoved = moveRing(x, y);
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
            if (Math.abs(r.cx - x) <= radius && Math.abs(r.cy - y) <= radius) wantedNear.push(plateFor(k));
          }
          wantedNear.sort((a, b) => Math.hypot(a.cx - x, a.cy - y) - Math.hypot(b.cx - x, b.cy - y));
          if (wantedNear.length > NEAR_MOST) wantedNear.length = NEAR_MOST;
        }
        for (const p of plates.values()) if (p.asked && !wantedNear.includes(p) && !content.has(p.key)) { cancelFlatGround(p.key); p.asked = false; }
      }
      // One plate made this frame: the nearest whose corners are in (or, with no workers, the nearest at all).
      const offPage = !failedOffPage && flatGroundOffPage();
      let made = false;
      for (const p of wantedNear) {
        if (p.surface) continue;
        if (offPage && !p.heights) { askCorners(p); continue; }
        if (made) continue;
        ensure(p);
        made = true;
      }
      // Drawn: the wanted plates that are made.
      nextNear.length = 0;
      for (const p of wantedNear) if (p.surface) nextNear.push(p.key);
      if (!ringMoved && nextNear.length === near.length && nextNear.every((v, k) => v === near[k]) && nextNear.every((k) => plates.get(k)?.shown)) return;
      near = nextNear.slice();
      refresh();
    },
    setSun(direction) {
      lastSun = direction;
      for (const p of shownList) p.surface!.setSun(direction);
      farSurface.setSun(direction);
    },
    bakeRelief(renderer: WebGLRenderer) {
      // The far woods: each far plate's fade from whether it is in full and its own trees can grow.
      const now = performance.now() / 1000;
      for (const fp of farPlates.values()) {
        const p = plates.get(fp.key);
        farForest.book.setFull(fp.key, p?.shown ?? false, p?.surface?.ecology() != null, now);
      }
      farForest.update(renderer, now);
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
    digest(minX, minY, maxX, maxY) {
      const key = plateOf((minX + maxX) / 2, (minY + maxY) / 2);
      const p = plates.get(key);
      if (!p?.surface) return key * 7919 + (seenRelief ?? 0) * 31 + 1;
      return p.surface.digest(minX - p.cx, minY - p.cy, maxX - p.cx, maxY - p.cy) + p.key;
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
        const v = p.surface!.geologyChanges.version;
        if (v !== geologySeen.get(p)) { geologySeen.set(p, v); geologyChanges.mark(null); }
      }
    },
    forestAt: (x, y) => ask(x, y, (s, lx, ly) => s.forestAt(lx, ly), () => 0),
    coverAt: (kind: CoverKind, x, y) => ask(x, y, (s, lx, ly) => s.coverAt(kind, lx, ly), () => 0),
    get forestRevision() { return sum((s) => s.forestRevision) + shownVersion * 1_000_003; },
    geologyAt: (x, y) => ask(x, y, (s, lx, ly) => s.geologyAt(lx, ly), (): GeologyKind => firstSurface.geologyAt(0, 0)),
    ecology: () => firstSurface.ecology(),
    get ecologyRevision() { return sum((s) => s.ecologyRevision) + shownVersion * 1_000_003; },
    geologyChanges,
    shoreLevelAt: (x, y) => ask(x, y, (s, lx, ly) => s.shoreLevelAt(lx, ly), () => null),
    waterArea() {
      let box: { minX: number; maxX: number; minY: number; maxY: number } | null = null;
      for (const p of shownList) {
        const w = p.surface!.waterArea();
        if (!w) continue;
        const b = { minX: w.minX + p.cx, maxX: w.maxX + p.cx, minY: w.minY + p.cy, maxY: w.maxY + p.cy };
        box = box ? { minX: Math.min(box.minX, b.minX), maxX: Math.max(box.maxX, b.maxX), minY: Math.min(box.minY, b.minY), maxY: Math.max(box.maxY, b.maxY) } : b;
      }
      return box;
    },
    get waterRevision() { return sum((s) => s.waterRevision); },
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
      farSurface.dispose();
      farForest.dispose();
      far.geometry.dispose();
      slab.geometry.dispose();
      (slab.material as MeshStandardMaterial).map?.dispose();
      (slab.material as MeshStandardMaterial).dispose();
    },
  };
}

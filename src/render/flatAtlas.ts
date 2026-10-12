import { BufferAttribute, BufferGeometry, Color, Float32BufferAttribute, FrontSide, Group, Mesh, MeshStandardMaterial, type WebGLRenderer } from 'three';
import type { CoverKind, GeologyKind, PaintDab } from '@world/terrainPaint';
import { RELIEF_EARTH, type ReliefVersion, type TerrainStamp } from '@world/terrain';
import type { GullyDab } from '@world/gullies';
import type { RoadDoc } from '@world/doc';
import { FLAT_PLATE, FLAT_PLATES, FLAT_WORLD, flatGroundFor, flatPlateCentre, flatPlateOf, flatSeaFor, flatSeaHold, flatSeaOver } from '@world/flatEarth';
import { GroundChanges } from './groundChanges';
import { SEA_LEVEL } from '@world/planet/seaLevel';
import { createFlatOcean } from './flatOcean';
import { compileAhead } from './uploads';
import { cancelFlatGround, flatGroundOffPage, readFlatGround, setFlatGroundFocus } from './flatGroundPool';
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
  type TerrainShaper,
  type TerrainSource,
  type TerrainSurface,
} from './terrain';
import { m } from '@world/units';

/**
 * THE FLAT MAP AS BIG AS THE GLOBE (docs/MAPA-PLANO-COMPLETO.md): the whole
 * Earth laid flat (`world/flatEarth.ts`, the equirectangular world map, 24 x
 * 12 km), drawn as a grid of the flat map's own plates (1.92 km, the old
 * map's), each a `createTerrainSurface` of its own, brought in where the view
 * is and let go when far, as the planet's pieces are (`planet/terrainAtlas.ts`,
 * Proland's split rule) - and the land beyond them a light mesh of the whole
 * world (as the planet's far globe). On one plane every plate meets the next
 * as it is: no charts, no curvature. A plate is centred on the origin: the old
 * flat map is that plate, its roads where they were.
 */

const REGION_STRIDE = 1000;
/** Plates kept made but not drawn, the oldest let go first. */
const CACHE = 6;
/** Most plates drawn in full near the view. */
const NEAR_MOST = 9;
/** Beyond this much ground in view, no plate is drawn in full: the far mesh alone. */
const NEAR_VIEW = m(1400);
/** Corners along a plate's side (the terrain's grid). */
const SIDE = Math.round((2 * TERRAIN_HALF) / TERRAIN_CELL) + 1;

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
  terrainSea?: (x: number, y: number) => boolean;
}

interface Plate {
  readonly index: number;
  readonly cx: number;
  readonly cy: number;
  readonly source: PlateSource;
  surface: TerrainSurface | null;
  shown: boolean;
  used: number;
  /** The land at the plate's grid corners, the base level added, read off the page (`flatGroundPool.ts`), rows from the north edge; null until then. */
  heights: Float64Array | null;
  /** Its first build made off the page, until the plate is made from it (`plateMesh.ts`). */
  mesh: PlateMesh | null;
  /** Whether its corners were asked of the workers (and not yet come back). */
  asked: boolean;
  /** The highest corner of its drawn ground, kept as it changes. */
  top: number;
}

const sameList = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
/** Whether a disc reaches a plate (its square grown by the disc). */
const reaches = (p: Plate, x: number, y: number, radius: number): boolean =>
  Math.abs(x - p.cx) <= TERRAIN_HALF + radius && Math.abs(y - p.cy) <= TERRAIN_HALF + radius;

/**
 * The whole flat Earth's far ground, as the planet's far globe
 * (`planet/globeGround.ts`): a coarse patch of `FAR_QUADS` x `FAR_QUADS`
 * quads per plate, in world coordinates, every height the land's own, a skirt
 * hung `SKIRT` under each edge (hiding the step where a patch meets a plate
 * drawn in full). One geometry; its index lists the patches of the plates not
 * drawn in full (`farIndexInto`), so nothing is drawn twice.
 */
const FAR_QUADS = 32;
const FAR_SIDE = FAR_QUADS + 1;
const SKIRT = m(30);
const FAR_VERTS = FAR_SIDE * FAR_SIDE + 4 * FAR_SIDE;
const FAR_INDICES = FAR_QUADS * FAR_QUADS * 6 + 4 * FAR_QUADS * 12;
export interface FlatFar { readonly geometry: BufferGeometry; readonly all: Uint32Array; readonly high: Float32Array }
export function buildFlatFar(ground: (x: number, y: number) => number): FlatFar {
  const positions = new Float32Array(FLAT_PLATES * FAR_VERTS * 3);
  const normals = new Float32Array(FLAT_PLATES * FAR_VERTS * 3);
  const steep = new Float32Array(FLAT_PLATES * FAR_VERTS);
  const all = new Uint32Array(FLAT_PLATES * FAR_INDICES);
  const high = new Float32Array(FLAT_PLATES);
  const step = FLAT_PLATE / FAR_QUADS;
  // Heights on a ring one cell wider than the patch, for its normals.
  const RING = FAR_SIDE + 2;
  const h = new Float64Array(RING * RING);
  let v = 0, w = 0;
  for (let plate = 0; plate < FLAT_PLATES; plate++) {
    const c = flatPlateCentre(plate);
    const x0 = c.x - TERRAIN_HALF, y0 = c.y - TERRAIN_HALF;
    for (let j = 0; j < RING; j++) for (let i = 0; i < RING; i++) h[j * RING + i] = TERRAIN_BASE + ground(x0 + (i - 1) * step, y0 + (j - 1) * step);
    const first = v;
    let top = -Infinity;
    for (let j = 0; j < FAR_SIDE; j++) {
      for (let i = 0; i < FAR_SIDE; i++) {
        const y = h[(j + 1) * RING + i + 1]!;
        if (y > top) top = y;
        positions[v * 3] = x0 + i * step; positions[v * 3 + 1] = y; positions[v * 3 + 2] = -(y0 + j * step);
        // three's axes: x east, y up, z south.
        const nx = h[(j + 1) * RING + i]! - h[(j + 1) * RING + i + 2]!;
        const nz = h[(j + 2) * RING + i + 1]! - h[j * RING + i + 1]!;
        const ny = 2 * step;
        const len = Math.hypot(nx, ny, nz);
        normals[v * 3] = nx / len; normals[v * 3 + 1] = ny / len; normals[v * 3 + 2] = nz / len;
        steep[v] = Math.acos(Math.min(1, ny / len)) * (180 / Math.PI);
        v++;
      }
    }
    high[plate] = top;
    const corner = (i: number, j: number): number => first + j * FAR_SIDE + i;
    for (let j = 0; j < FAR_QUADS; j++) {
      for (let i = 0; i < FAR_QUADS; i++) {
        const p00 = corner(i, j), p10 = corner(i + 1, j), p01 = corner(i, j + 1), p11 = corner(i + 1, j + 1);
        // Counter-clockwise seen from above (east x north = up).
        all[w++] = p00; all[w++] = p10; all[w++] = p01;
        all[w++] = p10; all[w++] = p11; all[w++] = p01;
      }
    }
    // An edge on the world's own rim hangs no skirt: the slab's cut side stands there (`slabGeometry`).
    const onRim = [c.y - TERRAIN_HALF <= FLAT_WORLD.minY + 1e-6, c.y + TERRAIN_HALF >= FLAT_WORLD.maxY - 1e-6, c.x - TERRAIN_HALF <= FLAT_WORLD.minX + 1e-6, c.x + TERRAIN_HALF >= FLAT_WORLD.maxX - 1e-6];
    for (let e = 0; e < 4; e++) {
      const hung = v;
      for (let k = 0; k < FAR_SIDE; k++) {
        const t = e === 0 ? corner(k, 0) : e === 1 ? corner(k, FAR_QUADS) : e === 2 ? corner(0, k) : corner(FAR_QUADS, k);
        positions[v * 3] = positions[t * 3]!; positions[v * 3 + 1] = positions[t * 3 + 1]! - SKIRT; positions[v * 3 + 2] = positions[t * 3 + 2]!;
        normals[v * 3] = normals[t * 3]!; normals[v * 3 + 1] = normals[t * 3 + 1]!; normals[v * 3 + 2] = normals[t * 3 + 2]!;
        steep[v] = steep[t]!;
        v++;
      }
      for (let k = 0; k < FAR_QUADS; k++) {
        const t0 = e === 0 ? corner(k, 0) : e === 1 ? corner(k, FAR_QUADS) : e === 2 ? corner(0, k) : corner(FAR_QUADS, k);
        const t1 = e === 0 ? corner(k + 1, 0) : e === 1 ? corner(k + 1, FAR_QUADS) : e === 2 ? corner(0, k + 1) : corner(FAR_QUADS, k + 1);
        const h0 = hung + k, h1 = hung + k + 1;
        if (onRim[e]) { for (let q = 0; q < 12; q++) all[w++] = t0; continue; }
        // Both ways round: the skirt is seen from either side.
        all[w++] = t0; all[w++] = h0; all[w++] = t1;
        all[w++] = t1; all[w++] = h0; all[w++] = h1;
        all[w++] = t0; all[w++] = t1; all[w++] = h0;
        all[w++] = t1; all[w++] = h1; all[w++] = h0;
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('aSteep', new BufferAttribute(steep, 1));
  geometry.setIndex(new BufferAttribute(new Uint32Array(all.length), 1));
  geometry.computeBoundingSphere();
  return { geometry, all, high };
}
/** Writes into the far ground's index the patches of the plates not drawn in full; returns how many indices. */
export function farIndexInto(far: FlatFar, full: (plate: number) => boolean): number {
  const index = far.geometry.getIndex()!;
  const out = index.array as Uint32Array;
  let n = 0;
  for (let plate = 0; plate < FLAT_PLATES; plate++) {
    if (full(plate)) continue;
    out.set(far.all.subarray(plate * FAR_INDICES, (plate + 1) * FAR_INDICES), n);
    n += FAR_INDICES;
  }
  index.needsUpdate = true;
  index.clearUpdateRanges();
  index.addUpdateRange(0, n);
  far.geometry.setDrawRange(0, n);
  return n;
}

/**
 * The sea's own cut side where the world's rim crosses it: from the bed
 * (`groundAt`) up to sea level, every `TERRAIN_CELL` along the rim where the
 * sea stands (`seaAt`), facing out - so the sea seen from beside the slab is
 * water over its bed, not a sheet floating over a hole.
 */
function seaRimGeometry(groundAt: (x: number, y: number) => number, seaAt: (x: number, y: number) => boolean): BufferGeometry {
  const { minX, maxX, minY, maxY } = FLAT_WORLD;
  const sides: readonly (readonly [number, number, number, number, number, number])[] = [
    [minX, -maxY, maxX, -maxY, 0, -1], [maxX, -maxY, maxX, -minY, 1, 0], [maxX, -minY, minX, -minY, 0, 1], [minX, -minY, minX, -maxY, -1, 0],
  ];
  const positions: number[] = [], normals: number[] = [];
  for (const [x0, z0, x1, z1, nx, nz] of sides) {
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, z1 - z0) / TERRAIN_CELL));
    for (let k = 0; k < n; k++) {
      const ax = x0 + ((x1 - x0) * k) / n, az = z0 + ((z1 - z0) * k) / n;
      const bx = x0 + ((x1 - x0) * (k + 1)) / n, bz = z0 + ((z1 - z0) * (k + 1)) / n;
      const ga = groundAt(ax, -az), gb = groundAt(bx, -bz);
      if ((ga >= SEA_LEVEL && gb >= SEA_LEVEL) || !(seaAt(ax, -az) || seaAt(bx, -bz))) continue;
      const ta = SEA_LEVEL, tb = SEA_LEVEL, la = Math.min(ga, SEA_LEVEL), lb = Math.min(gb, SEA_LEVEL);
      // Wound so the face points out: (lower - upper) x (along) against the normal.
      const outward = (la - ta) * (bz - az) * nx - (la - ta) * (bx - ax) * nz;
      const quad: [number, number, number][] = [[ax, ta, az], [ax, la, az], [bx, tb, bz], [bx, lb, bz]];
      for (const o of outward > 0 ? [0, 1, 2, 2, 1, 3] : [0, 2, 1, 2, 3, 1]) { positions.push(...quad[o]!); normals.push(nx, 0, nz); }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

export function createFlatAtlas(anisotropy: number): TerrainSurface {
  const plates: Plate[] = Array.from({ length: FLAT_PLATES }, (_, index) => {
    const c = flatPlateCentre(index);
    return { index, cx: c.x, cy: c.y, source: new PlateSource(), surface: null, shown: false, used: -1, heights: null, mesh: null, asked: false, top: -Infinity };
  });
  const root = new Group();
  root.name = 'flat-world-ground';

  // The far ground: a surface of its own lends the terrain's material (no
  // rim, its light and ecology pooled), its geometry the whole flat Earth's.
  const farSurface = createTerrainSurface(anisotropy, { x: 0, y: 0 }, -1, FLAT_PLATES);
  const farMesh = farSurface.ground;
  farMesh.name = 'flat-world-far';
  farMesh.frustumCulled = false;
  farMesh.receiveShadow = true;
  farMesh.visible = false;
  root.add(farMesh);
  // The seas over every plate whose land goes under sea level (`flatOcean.ts`),
  // into the scene once its program is built, in parallel (`compileAhead`):
  // drawn first, it stopped a frame for as long as the driver took.
  const ocean = createFlatOcean(anisotropy);
  void compileAhead(ocean.mesh).then(() => { root.add(ocean.mesh); });
  // THE SLAB under the whole flat Earth (the old map's cut sides, all round
  // the world): its strata from the land down to the bedrock, and where the
  // rim cuts the sea, the water standing to sea level over its bed.
  const slab = new Mesh(new BufferGeometry(), wallMaterial(anisotropy));
  slab.name = 'flat-world-slab';
  slab.receiveShadow = true;
  slab.visible = false;
  root.add(slab);
  const curtainMaterial = new MeshStandardMaterial({ color: new Color(0x1d5f8c), roughness: 0.25, metalness: 0, transparent: true, opacity: 0.82, side: FrontSide });
  const curtain = new Mesh(new BufferGeometry(), curtainMaterial);
  curtain.name = 'flat-world-sea-rim';
  curtain.visible = false;
  root.add(curtain);
  let farRelief: ReliefVersion | null = null;
  /** Where the sea may stand (`flatSeaFor`), and the bed it reads: dry land where it may not. */
  let seaHere: (x: number, y: number) => boolean = () => false;
  let seaHold: (x: number, y: number, land: number) => number = () => 0;
  const seaBed = (x: number, y: number, h: number): number => (seaHere(x, y) ? h : Math.max(h, SEA_LEVEL + 1));
  let far: FlatFar | null = null;
  const buildFar = (relief: ReliefVersion): void => {
    if (relief === farRelief) return;
    farRelief = relief;
    const land = flatGroundFor(relief);
    seaHere = flatSeaFor(relief);
    seaHold = flatSeaHold(relief);
    far = buildFlatFar(land);
    slab.geometry.dispose();
    slab.geometry = slabGeometry(FLAT_WORLD.minX, FLAT_WORLD.maxX, FLAT_WORLD.minY, FLAT_WORLD.maxY, TERRAIN_CELL, (x, y) => TERRAIN_BASE + land(x, y));
    slab.visible = true;
    curtain.geometry.dispose();
    curtain.geometry = seaRimGeometry((x, y) => TERRAIN_BASE + land(x, y), seaHere);
    curtain.visible = true;
    ocean.build((x, y) => seaBed(x, y, TERRAIN_BASE + land(x, y)));
    farMesh.geometry.dispose();
    farMesh.geometry = far.geometry;
    farMesh.visible = true;
    farIndexInto(far, (i) => plates[i]!.shown);
  };

  let frame = 0;
  let content = new Set<number>();
  let near: number[] = [];
  const shownList: Plate[] = [];
  let partsShown: TerrainPart[] = [];
  let shownVersion = 0;
  let lastSun: { x: number; y: number; z: number } | null = null;
  const lastLook = { waves: NaN, foam: NaN, current: NaN, windX: NaN, windZ: NaN, windSpeed: NaN };
  let lookGiven = false;
  let lastGullies: { dabs: readonly GullyDab[]; auto: number } | null = null;
  let lastDoc: TerrainSource | null = null;
  let highest = 0;

  const gulliesFor = (p: Plate, dabs: readonly GullyDab[], auto: number): void => {
    const mine: GullyDab[] = [];
    for (const d of dabs) if (reaches(p, d.x, d.y, d.radius)) mine.push({ ...d, x: d.x - p.cx, y: d.y - p.cy });
    p.surface!.setGullies(mine, auto);
  };
  /**
   * The sea reads a plate's ground as drawn - shaped by the works too: a
   * causeway's or a pad's fill has its shore and its foam round it.
   */
  const seaReads = (p: Plate): void => {
    const s = p.surface!;
    ocean.setPlate(p.index, (x, y) => seaBed(x, y, s.renderedHeightAt(x - p.cx, y - p.cy)));
  };
  /** A plate's highest drawn corner, read once each time its ground moved (not every plate's 90 601 at every change of the set). */
  const measureTop = (p: Plate): void => {
    const heights = p.surface!.ground.geometry.getAttribute('position').array;
    let top = -Infinity;
    for (let i = 1; i < heights.length; i += 3) if (heights[i]! > top) top = heights[i]!;
    p.top = top;
  };
  const measureHighest = (): void => {
    highest = -Infinity;
    for (const p of shownList) if (p.top > highest) highest = p.top;
  };

  const ensure = (p: Plate): TerrainSurface => {
    if (p.surface) return p.surface;
    // Each step of a plate's making measured (F9 and the probes read hitch: measures).
    const t0 = performance.now();
    const s = createTerrainSurface(anisotropy, { x: p.cx, y: p.cy }, -1, p.index, p.mesh);
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
    if (lastGullies) gulliesFor(p, lastGullies.dabs, lastGullies.auto);
    measureTop(p);
    return s;
  };
  const show = (p: Plate, on: boolean): void => {
    if (p.shown === on) return;
    p.shown = on;
    const s = p.surface!;
    if (on) root.add(...s.meshes); else root.remove(...s.meshes);
  };
  const letGo = (p: Plate): void => {
    if (!p.surface) return;
    show(p, false);
    p.surface.dispose();
    p.surface = null;
    // Its corners go too (725 kB a plate): read again if it comes back.
    p.heights = null;
    p.mesh = null;
  };
  const home = flatPlateOf(0, 0);
  const refresh = (): void => {
    frame++;
    const wanted = new Set<number>([home, ...content]);
    for (const i of wanted) { const p = plates[i]!; ensure(p); p.used = frame; }
    for (const i of near) { const p = plates[i]!; ensure(p); p.used = frame; wanted.add(i); }
    shownList.length = 0;
    const cached: Plate[] = [];
    for (const p of plates) {
      if (!p.surface) continue;
      const want = wanted.has(p.index);
      show(p, want);
      if (want) shownList.push(p); else cached.push(p);
    }
    if (cached.length > CACHE) {
      cached.sort((a, b) => a.used - b.used);
      for (let k = 0; k < cached.length - CACHE; k++) letGo(cached[k]!);
    }
    if (shownList.length !== partsShown.length || shownList.some((p, k) => partsShown[k]!.surface !== p.surface)) shownVersion++;
    partsShown = shownList.map((p) => ({ surface: p.surface!, cx: p.cx, cy: p.cy }));
    if (far) farIndexInto(far, (i) => plates[i]!.shown);
    measureHighest();
  };

  let contentKey = '';
  const readContent = (doc: TerrainSource): boolean => {
    const d = doc as Partial<RoadDoc>;
    const key = [d.revision, d.buildings?.revision, d.lotRevision, d.utilityRevision, d.treeRevision, doc.terrainRevision, doc.paintRevision, lastGullies?.dabs.length ?? 0].join(':');
    if (key === contentKey) return false;
    contentKey = key;
    const next = new Set<number>();
    const mark = (x: number, y: number): void => { next.add(flatPlateOf(x, y)); };
    for (const n of d.nodes?.values() ?? []) mark(n.x, n.y);
    for (const b of d.buildings?.all() ?? []) mark(b.x, b.y);
    for (const l of d.lots ?? []) for (const c of l.corners) mark(c.x, c.y);
    for (const p of d.poles?.values() ?? []) mark(p.x, p.y);
    for (const item of d.landscape?.values() ?? []) mark(item.x, item.y);
    for (const tree of d.trees ?? []) mark(tree.x, tree.y);
    for (const barrier of d.barriers?.values() ?? []) for (const q of barrier.points) mark(q.x, q.y);
    for (const p of plates) if (p.source.terrainStamps.length || p.source.terrainPaint.length) next.add(p.index);
    const changed = next.size !== content.size || [...next].some((i) => !content.has(i));
    content = next;
    return changed;
  };

  // The document's stamps and dabs on each plate they reach, moved to its map (about its centre).
  const stampCopies = plates.map(() => new WeakMap<TerrainStamp, TerrainStamp | null>());
  const dabCopies = plates.map(() => new WeakMap<PaintDab, PaintDab | null>());
  const copyOn = <T extends { readonly x: number; readonly y: number; readonly radius: number; readonly ox?: number; readonly oy?: number }>(copies: WeakMap<T, T | null>, p: Plate, item: T): T | null => {
    let local = copies.get(item);
    if (local === undefined) {
      copies.set(item, local = reaches(p, item.x, item.y, item.radius)
        ? { ...item, x: item.x - p.cx, y: item.y - p.cy, ...(item.ox !== undefined && item.oy !== undefined ? { ox: item.ox - p.cx, oy: item.oy - p.cy } : {}) }
        : null);
    }
    return local;
  };
  let seenTerrain = -1;
  let seenRelief: ReliefVersion | null = null;
  let seenPaint = -1;
  let bare: (x: number, y: number) => number = flatGroundFor(RELIEF_EARTH);
  const sync = (doc: TerrainSource): void => {
    lastDoc = doc;
    for (const p of plates) {
      p.source.changes = doc.changes;
      p.source.natureRevision = doc.natureRevision;
      p.source.nature = doc.nature;
    }
    if (doc.terrainRevision !== seenTerrain) {
      seenTerrain = doc.terrainRevision;
      const reliefMoved = seenRelief !== doc.terrainRelief;
      seenRelief = doc.terrainRelief;
      if (reliefMoved) bare = flatGroundFor(doc.terrainRelief);
      buildFar(doc.terrainRelief);
      plates.forEach((p, i) => {
        const copies = stampCopies[i]!;
        const sources = doc.terrainStamps.filter((s) => copyOn(copies, p, s) !== null);
        p.source.terrainRelief = doc.terrainRelief;
        if (reliefMoved || !p.source.terrainGround) {
          if (reliefMoved) { p.heights = null; p.mesh = null; p.asked = false; }
          p.source.terrainGround = (lx, ly) => groundOn(p, lx, ly);
          if (doc.terrainRelief === RELIEF_EARTH) delete p.source.terrainSea;
          // Read over the plate's own corners (off the page), not the field again at each.
          else { const sea = flatSeaOver(doc.terrainRelief); p.source.terrainSea = (lx, ly) => sea(p.cx + lx, p.cy + ly, groundOn(p, lx, ly)); }
        }
        if (!reliefMoved && p.source.terrainRevision !== 0 && sameList(sources, p.source.stampSources)) return;
        p.source.stampSources = sources;
        p.source.terrainStamps = sources.map((s) => copies.get(s) as TerrainStamp);
        p.source.terrainRevision = doc.terrainRevision;
      });
    }
    if (doc.paintRevision !== seenPaint) {
      seenPaint = doc.paintRevision;
      plates.forEach((p, i) => {
        const copies = dabCopies[i]!;
        const sources = doc.terrainPaint.filter((d) => copyOn(copies, p, d) !== null);
        if (sameList(sources, p.source.paintSources)) return;
        p.source.paintSources = sources;
        p.source.terrainPaint = sources.map((d) => copies.get(d) as PaintDab);
        p.source.paintRevision = doc.paintRevision;
      });
    }
    if (readContent(doc)) refresh();
  };
  const bareAt = (p: Plate, lx: number, ly: number): number => TERRAIN_BASE + bare(p.cx + lx, p.cy + ly);
  /**
   * A plate's land at a point of its map: its corners as the workers read
   * them (the same numbers the field gives there, to the bit), bilinear
   * between them; the field itself off the plate or before they come.
   */
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
      key: p.index, relief, tile: -1, at: { x: p.cx, y: p.cy }, cx: p.cx, cy: p.cy, half: TERRAIN_HALF, cell: TERRAIN_CELL, side: SIDE, base: TERRAIN_BASE,
      done: (mesh) => {
        p.asked = false;
        // A plate made meanwhile keeps the field it was made on; a relief changed meanwhile, the new one.
        if (relief === seenRelief && !p.surface) { p.heights = mesh.heights; p.mesh = mesh; }
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
    const index = Math.floor(region[0] / REGION_STRIDE);
    const off = index * REGION_STRIDE;
    return { plate: plates[index]!, local: [region[0] - off, region[1] - off, region[2], region[3]] };
  };
  const encode = (p: Plate, region: TerrainRegion): TerrainRegion => {
    const off = p.index * REGION_STRIDE;
    return [region[0] + off, region[1] + off, region[2], region[3]];
  };
  /** A road field asked in a plate's own coordinates. */
  const shaperFor = (p: Plate, shape: TerrainShaper): TerrainShaper => ({
    shapeAt: (x, y, ground) => shape.shapeAt(x + p.cx, y + p.cy, ground),
    shapeBounds: () => shape.shapeBounds().map((b) => ({ minX: b.minX - p.cx, minY: b.minY - p.cy, maxX: b.maxX - p.cx, maxY: b.maxY - p.cy })),
  });

  let lastPlate: Plate | null = null;
  const geologyChanges = new GroundChanges();
  const geologySeen = new Map<Plate, number>();
  const sum = (read: (s: TerrainSurface) => number): number => {
    let total = 0;
    for (const p of shownList) total += read(p.surface!);
    return total;
  };
  const ask = <T>(x: number, y: number, read: (s: TerrainSurface, lx: number, ly: number) => T, bareRead: (p: Plate, lx: number, ly: number) => T): T => {
    const p = plates[flatPlateOf(x, y)]!;
    return p.surface ? read(p.surface, x - p.cx, y - p.cy) : bareRead(p, x - p.cx, y - p.cy);
  };

  const first = plates[home]!;
  ensure(first);
  refresh();
  const firstSurface = first.surface!;
  return {
    meshes: [root],
    highest: () => highest,
    seaHold: (x, y, land) => seaHold(x, y, land),
    ground: firstSurface.ground,
    get parts() { return partsShown; },
    focus(x, y, reach) {
      // In full within some times the ground the view takes in (Proland's
      // split rule), none from far out: the far mesh alone. Worked out again
      // only when the view moved to another plate or reach; a plate comes in
      // once its corners are read off the page, one a frame at most - the far
      // patch stands in meanwhile, never a frame stopped for it.
      setFlatGroundFocus(x, y);
      const radius = reach < NEAR_VIEW ? Math.max(TERRAIN_HALF, reach * 1.6) + TERRAIN_HALF : -1;
      const key = `${flatPlateOf(x, y)}:${Math.round(radius / TERRAIN_HALF)}`;
      if (key !== focusKey) {
        focusKey = key;
        wantedNear.length = 0;
        if (radius > 0) {
          for (const p of plates) if (Math.abs(p.cx - x) <= radius && Math.abs(p.cy - y) <= radius) wantedNear.push(p);
          wantedNear.sort((a, b) => Math.hypot(a.cx - x, a.cy - y) - Math.hypot(b.cx - x, b.cy - y));
          if (wantedNear.length > NEAR_MOST) wantedNear.length = NEAR_MOST;
        }
        for (const p of plates) if (p.asked && !wantedNear.includes(p) && !content.has(p.index)) { cancelFlatGround(p.index); p.asked = false; }
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
      for (const p of wantedNear) if (p.surface) nextNear.push(p.index);
      if (nextNear.length === near.length && nextNear.every((v, k) => v === near[k]) && nextNear.every((i) => plates[i]!.shown)) return;
      near = nextNear.slice();
      refresh();
    },
    setSun(direction) {
      lastSun = direction;
      for (const p of shownList) p.surface!.setSun(direction);
      farSurface.setSun(direction);
    },
    bakeRelief(renderer: WebGLRenderer, focus) {
      const at = focus ? plates[flatPlateOf(focus.x, -focus.z)]! : null;
      for (const p of shownList) p.surface!.bakeRelief(renderer, p === at && focus ? { x: focus.x - p.cx, z: focus.z + p.cy } : null);
    },
    setWaterLook(look: WaterLook) {
      const was = lastLook;
      if (was.waves === look.waves && was.foam === look.foam && was.current === look.current
        && was.windX === look.windX && was.windZ === look.windZ && was.windSpeed === look.windSpeed) return;
      Object.assign(was, look);
      lookGiven = true;
      for (const p of plates) p.surface?.setWaterLook(look);
      ocean.setLook(look);
    },
    setGullies(dabs: readonly GullyDab[], auto) {
      lastGullies = { dabs, auto };
      for (const p of plates) if (p.surface) gulliesFor(p, dabs, auto);
      if (lastDoc && readContent(lastDoc)) refresh();
    },
    vergeMaterial: firstSurface.vergeMaterial,
    heightAt: (x, y) => ask(x, y, (s, lx, ly) => s.heightAt(lx, ly), bareAt),
    naturalRenderedHeightAt: (x, y) => ask(x, y, (s, lx, ly) => s.naturalRenderedHeightAt(lx, ly), bareAt),
    renderedHeightAt: (x, y) => ask(x, y, (s, lx, ly) => s.renderedHeightAt(lx, ly), bareAt),
    wetAt: (x, y) => ask(x, y, (s, lx, ly) => s.wetAt(lx, ly), () => false),
    digest(minX, minY, maxX, maxY) {
      const p = plates[flatPlateOf((minX + maxX) / 2, (minY + maxY) / 2)]!;
      if (!p.surface) return p.index * 7919 + (seenRelief ?? 0) * 31 + 1;
      return p.surface.digest(minX - p.cx, minY - p.cy, maxX - p.cx, maxY - p.cy) + p.index;
    },
    update(doc, stroking) {
      sync(doc);
      let moved = false;
      for (const p of shownList) {
        if (!p.surface!.update(p.source, stroking)) continue;
        moved = true;
        lastPlate = p;
        measureTop(p);
        // The sea reads the plate's land again: a raised island has its shore, a dug channel its depth.
        seaReads(p);
      }
      if (moved) { measureHighest(); ocean.commit(); }
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
    ecologyTexture: firstSurface.ecologyTexture,
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
        for (const p of shownList) if (p.surface!.shapeToRoads(shape && shaperFor(p, shape), null)) { moved = true; measureTop(p); seaReads(p); }
        if (moved) { measureHighest(); ocean.commit(); }
        return moved;
      }
      const byPlate = new Map<Plate, TerrainRegion[]>();
      for (const r of list) {
        const { plate, local } = decode(r);
        let mine = byPlate.get(plate);
        if (!mine) byPlate.set(plate, mine = []);
        mine.push(local);
      }
      for (const [p, regions] of byPlate) if (ensure(p).shapeToRoads(shape && shaperFor(p, shape), regions)) { moved = true; measureTop(p); seaReads(p); }
      if (moved) { measureHighest(); ocean.commit(); }
      return moved;
    },
    regionOf(box) {
      const p = plates[flatPlateOf((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)]!;
      return encode(p, ensure(p).regionOf([box[0] - p.cx, box[1] - p.cy, box[2] - p.cx, box[3] - p.cy]));
    },
    rectOf(region) {
      const { plate, local } = decode(region);
      const r = ensure(plate).rectOf(local);
      return [r[0] + plate.cx, r[1] + plate.cy, r[2] + plate.cx, r[3] + plate.cy];
    },
    dispose() {
      for (const p of plates) p.surface?.dispose();
      farSurface.dispose();
      ocean.dispose();
      slab.geometry.dispose();
      (slab.material as MeshStandardMaterial).map?.dispose();
      (slab.material as MeshStandardMaterial).dispose();
      curtain.geometry.dispose();
      curtainMaterial.dispose();
    },
  };
}

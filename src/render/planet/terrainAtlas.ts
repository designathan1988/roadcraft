import { chartShaper } from './chartShaper';
import { PLANET_RADIUS, type Vec3 } from '@core/cubeSphere';
import { TILES, TILE_COUNT, TILE_HALF, onTile, sphereToTileInto, tileToSphereInto } from '@core/planetTiles';
import type { CoverKind, GeologyKind } from '@world/terrainPaint';
import type { PaintDab } from '@world/terrainPaint';
import type { TerrainStamp } from '@world/terrain';
import { RELIEF_EARTH, RELIEF_FLAT, type ReliefVersion } from '@world/terrain';
import type { GullyDab } from '@world/gullies';
import type { RoadDoc } from '@world/doc';
import { TILE_PLATE_HALF, TILE_REACH, atlasToTileInto, tileCellOf, tileCentre, type TileLocal } from '@world/planet/atlas';
import { atlasToSphereInto, chartAt, chartsReaching, ownerOfChartPointInto } from '@world/planet/charts';
import { tileGround } from '@world/planet/relief';
import { Group, type Material, type WebGLRenderer } from 'three';
import { planetSunOnPlanet, setPlanetGroundFloor, type PlanetCap } from './bend';
import { setLightFocus } from '../terrainLightPool';
import { setEcologyFocus } from '../ecologyPool';
import { GroundChanges } from '../groundChanges';
import type { WaterLook } from '../water';
import {
  PLANET_ACTIVE_TILES,
  TERRAIN_BASE,
  TERRAIN_CELL,
  TERRAIN_HALF,
  createTerrainSurface,
  type TerrainPart,
  type TerrainRegion,
  type TerrainShaper,
  type TerrainSource,
  type TerrainSurface,
} from '../terrain';
import { buildGlobeGround } from './globeGround';
import { createPlanetOcean, type PlanetOcean } from './ocean';
import { compileAhead } from '../uploads';
import { cancelFlatGround, flatGroundOffPage, readFlatGround, setFlatGroundFocus } from '../flatGroundPool';
import type { PlateMesh } from '../plateMesh';
import { m } from '@world/units';

/**
 * THE PLANET'S GROUND: the far globe at low detail in one draw
 * (`globeGround.ts`), and a full terrain plate - the flat map's own surface
 * (`terrain.ts`), handed its piece's share of the document in the piece's
 * own coordinates (`FaceSource`) - only for the pieces that need one.
 *
 * Each of the 864 pieces used to be a full surface from the boot: its mesh,
 * material and data textures, its ecosystem and light, and every per-frame
 * loop ran over all of them - the planet's memory, its opening and its frame
 * went on ground nobody was looking at. As planet renderers page their
 * terrain (Proland's tile cache: the fine level produced where the view
 * needs it, the coarse level drawn where it is missing; Cesium's quadtree the
 * same), a piece is kept in full while
 *  - something of the document lies on or reaches it (roads, buildings,
 *    lots, a stamp, a painted dab...): its ground must be the one they were
 *    built on, and it is never let go;
 *  - or it is near the ground the view takes in (Proland's split rule: a
 *    piece within some times its size of what the view looks at);
 * and piece 0 always (its surface lends the atlas its shared parts). A piece
 * no longer wanted stays cached (`CACHE`) and is let go the least recently
 * used first. Asked about a piece with no surface, the atlas answers from the
 * land itself (`planet/relief.ts`), as that piece's surface would.
 *
 * A stamp (or a painted dab) belongs to every piece its disc reaches on the
 * sphere, each given it on its own map (carried there through the sphere, not
 * by an offset), so a hill on a border rises the same on both sides.
 */

/** Grid regions of several plates in one number line: a plate's corners are offset by its index times this. */
const REGION_STRIDE = 1000;
/** Pieces kept in full though no longer wanted, before the least recently used is let go. */
const CACHE = 8;
/**
 * The most pieces kept in full for the view, the nearest first, and how far
 * from what it looks at (an arc, world units): past that the far globe is
 * the ground, as a coarser level takes over from a finer one. Wider, the
 * view's middle altitude brought a hundred pieces in and out at every turn.
 */
const NEAR_MOST = 24;
/** About two pieces round the one looked at. */
const NEAR_RADIUS = TILE_HALF * 4.5;
/** Milliseconds a frame for bringing near pieces in full (the ones with something on them come at once). */
const NEAR_BUDGET_MS = 8;
/**
 * The view keeps pieces in full while the ground it takes in is under this
 * (the screen's half height: 960 m); farther out, only the far globe
 * and the pieces with something on them.
 */
const NEAR_VIEW = m(960);

/** One face's share of the document, in the face's coordinates (what `TerrainSurface.update` reads). */
class FaceSource implements TerrainSource {
  changes!: RoadDoc['changes'];
  terrainRevision = 0;
  terrainStamps: TerrainStamp[] = [];
  terrainRelief!: RoadDoc['terrainRelief'];
  natureRevision = 0;
  nature: RoadDoc['nature'] = null;
  paintRevision = 0;
  terrainPaint: PaintDab[] = [];
  /** The document's own stamps and dabs this face's were made from, in order. */
  stampSources: readonly TerrainStamp[] = [];
  paintSources: readonly PaintDab[] = [];
  /** The face's land, read at the sphere so neighbours meet at the same height (`planet/relief.ts`). */
  terrainGround?: (x: number, y: number) => number;
}

interface Tile {
  readonly face: number;
  readonly cx: number;
  readonly cy: number;
  readonly source: FaceSource;
  /** Its full surface, while it has one. */
  surface: TerrainSurface | null;
  /** Whether its surface is drawn and kept up to date this frame. */
  shown: boolean;
  /** The frame it was last wanted (the cache lets the oldest go first). */
  used: number;
  /** Its land at the plate's grid corners (the base level added), read off the page (`flatGroundPool.ts`); null until then. */
  heights: Float64Array | null;
  /** Its first build made off the page, until the plate is made from it (`plateMesh.ts`). */
  mesh: PlateMesh | null;
  /** Whether its corners were asked of the workers (and not yet come back). */
  asked: boolean;
}

const where: TileLocal = { tile: 0, x: 0, y: 0 };
const onSphere: Vec3 = { x: 0, y: 0, z: 0 };
const there = { x: 0, y: 0 };
/** How far from a piece's centre (an arc, world units) anything of it can lie, with its reach. */
const PIECE_REACH = TILE_HALF * Math.SQRT2 + TILE_REACH;

/**
 * A disc of the atlas (its centre in its own piece's cell) on another piece's
 * map: its centre carried through the sphere, or null when it cannot reach
 * that piece.
 */
const placeOn = (tile: Tile, x: number, y: number, radius: number): { x: number; y: number } | null => {
  atlasToTileInto(x, y, where);
  if (where.tile === tile.face) return { x: where.x, y: where.y };
  tileToSphereInto(where.tile, where.x, where.y, onSphere);
  const c = TILES[tile.face]!.centre;
  const arc = Math.acos(Math.min(1, onSphere.x * c.x + onSphere.y * c.y + onSphere.z * c.z)) * PLANET_RADIUS;
  if (arc > PIECE_REACH + radius) return null;
  sphereToTileInto(tile.face, onSphere, there);
  return { x: there.x, y: there.y };
};

/** The sun on one plate's map (`setSun`). */
const sunOnPlate = { x: 0, y: 0, z: 0 };

const sameList = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export function createTerrainAtlas(anisotropy: number): TerrainSurface {
  const tiles: Tile[] = Array.from({ length: TILE_COUNT }, (_, face) => {
    const c = tileCentre(face);
    return { face, cx: c.x, cy: c.y, source: new FaceSource(), surface: null, shown: false, used: -1, heights: null, mesh: null, asked: false };
  });
  const root = new Group();
  root.name = 'planet-ground';
  const activeBits = PLANET_ACTIVE_TILES.value;

  // The far globe: a surface of its own lends the terrain's material; its
  // geometry is the globe's (built once the document's relief is known).
  const globeSurface = createTerrainSurface(anisotropy, { x: 0, y: 0 }, 0);
  const globe = globeSurface.ground;
  globe.name = 'planet-globe-ground';
  // -2: the far globe (the terrain shader draws it only where no piece is in full, `PLANET_ACTIVE_TILES`).
  ((globe.material as Material).userData['terrainUniforms'] as { uPlanetTile: { value: number } }).uPlanetTile.value = -2;
  globe.frustumCulled = false;
  globe.receiveShadow = true;
  globe.visible = false;
  root.add(globe);
  let globeRelief: ReliefVersion | null = null;
  /** Each piece's lowest and highest ground on the far globe (`globeGround.ts`), for the horizon. */
  let globeLow: Float32Array = new Float32Array(TILE_COUNT), globeHigh: Float32Array = new Float32Array(TILE_COUNT);
  const buildGlobe = (relief: ReliefVersion): void => {
    if (relief === globeRelief) return;
    globeRelief = relief;
    const built = buildGlobeGround(relief, TERRAIN_BASE);
    globe.geometry.dispose();
    globe.geometry = built.geometry;
    globeLow = built.low;
    globeHigh = built.high;
    globe.visible = true;
    for (const t of tiles) if (!t.surface) measured.add(t);
    measure();
    // The Earth's seas (`ocean.ts`): laid a few pieces a frame (`layOcean`),
    // the nearest the view first, as the globe's woods are.
    if (ocean) { root.remove(ocean.mesh); ocean.dispose(); ocean = null; }
    oceanQueue.length = 0;
    if (relief === RELIEF_EARTH) {
      const made = ocean = createPlanetOcean(anisotropy);
      if (lookGiven) made.setLook(lastLook);
      // Into the scene once its program is built, in parallel (`compileAhead`):
      // drawn first, it stopped a frame for as long as the driver took.
      void compileAhead(made.mesh).then(() => { if (ocean === made) root.add(made.mesh); });
      for (let i = 0; i < TILE_COUNT; i++) oceanQueue.push(i);
    }
  };
  let ocean: PlanetOcean | null = null;
  /** The pieces whose sea is still to be read (`layOcean`). */
  const oceanQueue: number[] = [];
  /** Within the ocean's budget a frame, the pieces nearest the view read into the sea. */
  const OCEAN_BUDGET_MS = 3;
  const layOcean = (dir: Vec3): void => {
    if (!ocean || !oceanQueue.length) return;
    const near = (i: number): number => { const c = TILES[i]!.centre; return c.x * dir.x + c.y * dir.y + c.z * dir.z; };
    oceanQueue.sort((a, b) => near(a) - near(b));
    const started = performance.now();
    while (oceanQueue.length && performance.now() - started < OCEAN_BUDGET_MS) {
      const t = tiles[oceanQueue.pop()!]!;
      ocean.setPiece(t.face, (x, y) => (t.surface ? t.surface.heightAt(x, y) : bareAt(t, x, y)));
    }
    ocean.commit();
  };

  /**
   * Each plate's ground as the horizon sees it (`bend.ts` `PlanetCap`): its
   * piece's centre, its corners' arc, the highest its ground stands; and the
   * lowest ground of all, the sphere that hides (`setPlanetGroundFloor`).
   * Measured again for a plate only when its ground moved.
   */
  const caps: PlanetCap[] = tiles.map((t) => ({ dir: TILES[t.face]!.centre, reach: TILE_PLATE_HALF * Math.SQRT2, top: 0 }));
  const lows = new Float64Array(TILE_COUNT);
  const measured = new Set<Tile>();
  /** The highest corner of all the plates (`highest`), measured with the caps. */
  let highest = 0;
  const measure = (): void => {
    if (measured.size === 0) return;
    for (const t of measured) {
      if (t.surface) {
        const heights = t.surface.ground.geometry.getAttribute('position').array;
        let low = Infinity, high = -Infinity;
        for (let i = 1; i < heights.length; i += 3) {
          const h = heights[i]!;
          if (h < low) low = h;
          if (h > high) high = h;
        }
        caps[t.face]!.top = high;
        lows[t.face] = low;
      } else {
        caps[t.face]!.top = globeHigh[t.face]!;
        lows[t.face] = globeLow[t.face]!;
      }
    }
    measured.clear();
    let floor = Infinity;
    highest = -Infinity;
    for (let i = 0; i < TILE_COUNT; i++) {
      floor = Math.min(floor, lows[i]!);
      highest = Math.max(highest, caps[i]!.top);
    }
    setPlanetGroundFloor(floor);
  };
  const tileAt = (x: number, y: number): Tile => tiles[tileCellOf(x, y)] as Tile;

  // ---------------------------------------------------------------- the cache

  let frame = 0;
  /** The pieces something of the document lies on or reaches (kept in full, never let go). */
  let content = new Set<number>();
  /** The pieces near the ground the view takes in. */
  let near: number[] = [];
  const shownList: Tile[] = [];
  /** The parts drawn in full (`parts`), as the renderer's sweeps read them. */
  let partsShown: TerrainPart[] = [];
  /** Moves on whenever the pieces shown change: part of the revisions summed over them. */
  let shownVersion = 0;
  /** What a piece brought in is handed: the state the shown ones already have. */
  let lastSun: { x: number; y: number; z: number } | null = null;
  const lastLook = { waves: NaN, foam: NaN, current: NaN, windX: NaN, windZ: NaN, windSpeed: NaN };
  let lookGiven = false;
  let lastGullies: { dabs: readonly GullyDab[]; auto: number } | null = null;
  let lastDoc: TerrainSource | null = null;

  const sunFor = (t: Tile, sunOnPlanet: Readonly<Vec3>): void => {
    const f = TILES[t.face]!;
    sunOnPlate.x = sunOnPlanet.x * f.east.x + sunOnPlanet.y * f.east.y + sunOnPlanet.z * f.east.z;
    sunOnPlate.y = sunOnPlanet.x * f.centre.x + sunOnPlanet.y * f.centre.y + sunOnPlanet.z * f.centre.z;
    sunOnPlate.z = -(sunOnPlanet.x * f.north.x + sunOnPlanet.y * f.north.y + sunOnPlanet.z * f.north.z);
    t.surface!.setSun(sunOnPlate);
  };
  const gulliesFor = (t: Tile, dabs: readonly GullyDab[], auto: number): void => {
    const mine: GullyDab[] = [];
    for (const d of dabs) {
      const at = placeOn(t, d.x, d.y, d.radius);
      if (at) mine.push({ ...d, x: at.x, y: at.y });
    }
    t.surface!.setGullies(mine, auto);
  };

  /** A piece's full surface, made now if it has none, up to the document. */
  const ensure = (t: Tile): TerrainSurface => {
    if (t.surface) return t.surface;
    // Its first build off the page when the workers made it (`plateMesh.ts`); the surface keeps what it copied.
    const s = createTerrainSurface(anisotropy, { x: t.cx, y: t.cy }, t.face, t.face, t.mesh);
    t.mesh = null;
    t.surface = s;
    // The pieces meet: a plate with a piece has no backdrop round it, no cut sides (`createTerrainSurface`).
    s.ground.userData['planetCap'] = caps[t.face];
    if (lastDoc) {
      s.update(t.source, false);
      s.updatePaint(t.source, true);
    }
    if (lastSun) sunFor(t, planetSunOnPlanet());
    if (lookGiven) s.setWaterLook(lastLook);
    if (lastGullies) gulliesFor(t, lastGullies.dabs, lastGullies.auto);
    measured.add(t);
    return s;
  };
  const show = (t: Tile, on: boolean): void => {
    if (t.shown === on) return;
    t.shown = on;
    const s = t.surface!;
    if (on) root.add(...s.meshes); else root.remove(...s.meshes);
    // The piece's bit in its word (`PLANET_ACTIVE_TILES`: 24 to a float).
    const word = Math.floor(t.face / 24), bit = 2 ** (t.face % 24);
    const has = Math.floor(activeBits[word]! / bit) % 2 === 1;
    if (on && !has) activeBits[word] = activeBits[word]! + bit;
    else if (!on && has) activeBits[word] = activeBits[word]! - bit;
  };
  const letGo = (t: Tile): void => {
    if (!t.surface) return;
    show(t, false);
    t.surface.dispose();
    t.surface = null;
    // Its corners go too: read again off the page if it comes back.
    t.heights = null;
    t.mesh = null;
    measured.add(t);
  };

  /** The pieces wanted, brought in and shown; the others hidden and the oldest let go. */
  const refresh = (): void => {
    frame++;
    const wanted = new Set<number>([0, ...content]);
    // Those with something on them come at once: their ground is the one it was built on.
    for (const i of wanted) { const t = tiles[i]!; ensure(t); t.used = frame; }
    const started = performance.now();
    for (const i of near) {
      const t = tiles[i]!;
      if (!t.surface && performance.now() - started > NEAR_BUDGET_MS) continue;
      ensure(t);
      t.used = frame;
      wanted.add(i);
    }
    shownList.length = 0;
    const cached: Tile[] = [];
    for (const t of tiles) {
      if (!t.surface) continue;
      const want = wanted.has(t.face);
      show(t, want);
      if (want) shownList.push(t); else cached.push(t);
    }
    if (cached.length > CACHE) {
      cached.sort((a, b) => a.used - b.used);
      for (let k = 0; k < cached.length - CACHE; k++) letGo(cached[k]!);
    }
    if (shownList.length !== partsShown.length || shownList.some((t, k) => partsShown[k]!.surface !== t.surface)) shownVersion++;
    partsShown = shownList.map((t) => ({ surface: t.surface!, cx: t.cx, cy: t.cy }));
    measure();
  };

  /** What of the document lies on the planet, by piece: read again when it changed. */
  let contentKey = '';
  const readContent = (doc: TerrainSource): boolean => {
    const d = doc as Partial<RoadDoc>;
    const key = [d.revision, d.buildings?.revision, d.lotRevision, d.utilityRevision, d.treeRevision, doc.terrainRevision, doc.paintRevision, lastGullies?.dabs.length ?? 0].join(':');
    if (key === contentKey) return false;
    contentKey = key;
    const next = new Set<number>();
    const mark = (x: number, y: number): void => { for (const c of chartsReaching(chartAt(x, y), x, y, x, y)) next.add(c); };
    for (const n of d.nodes?.values() ?? []) mark(n.x, n.y);
    for (const b of d.buildings?.all() ?? []) mark(b.x, b.y);
    for (const l of d.lots ?? []) for (const c of l.corners) mark(c.x, c.y);
    for (const p of d.poles?.values() ?? []) mark(p.x, p.y);
    for (const item of d.landscape?.values() ?? []) mark(item.x, item.y);
    for (const tree of d.trees ?? []) mark(tree.x, tree.y);
    for (const barrier of d.barriers?.values() ?? []) for (const p of barrier.points) mark(p.x, p.y);
    tiles.forEach((t) => {
      if (t.source.terrainStamps.length || t.source.terrainPaint.length) next.add(t.face);
    });
    if (lastGullies) for (const g of lastGullies.dabs) mark(g.x, g.y);
    const changed = next.size !== content.size || [...next].some((i) => !content.has(i));
    content = next;
    return changed;
  };

  // ------------------------------------------------------- the document's share

  /**
   * The local copies made, by piece (null: it does not reach that piece), so
   * an unchanged stamp keeps its copy - the surface compares them by identity.
   */
  const stampCopies = tiles.map(() => new WeakMap<TerrainStamp, TerrainStamp | null>());
  const dabCopies = tiles.map(() => new WeakMap<PaintDab, PaintDab | null>());
  const copyOn = <T extends { readonly x: number; readonly y: number; readonly radius: number; readonly ox?: number; readonly oy?: number }>(copies: WeakMap<T, T | null>, tile: Tile, item: T): T | null => {
    let local = copies.get(item);
    if (local === undefined) {
      const at = placeOn(tile, item.x, item.y, item.radius);
      // A rough dab's noise origin goes to this piece's map with it
      // (`TerrainStamp.ox`): measured from the origin as the dab's own piece
      // has it, the two pieces at a border raise the same hill.
      const origin = at && item.ox !== undefined && item.oy !== undefined ? placeOn(tile, item.ox, item.oy, Infinity) : null;
      copies.set(item, local = at ? { ...item, x: at.x, y: at.y, ...(origin ? { ox: origin.x, oy: origin.y } : {}) } : null);
    }
    return local;
  };

  let seenTerrain = -1;
  let seenRelief: RoadDoc['terrainRelief'] | null = null;
  let seenPaint = -1;
  /** Each piece's land with nothing on it, by relief (`heightAt` of a piece with no surface). */
  const bare: ((x: number, y: number) => number)[] = [];
  /** Brings every face's share up to the document. */
  const sync = (doc: TerrainSource): void => {
    lastDoc = doc;
    for (const tile of tiles) {
      tile.source.changes = doc.changes;
      tile.source.natureRevision = doc.natureRevision;
      tile.source.nature = doc.nature;
    }
    if (doc.terrainRevision !== seenTerrain) {
      seenTerrain = doc.terrainRevision;
      const reliefMoved = seenRelief !== null && seenRelief !== doc.terrainRelief;
      if (reliefMoved || seenRelief === null) bare.length = 0;
      seenRelief = doc.terrainRelief;
      buildGlobe(doc.terrainRelief);
      tiles.forEach((tile, i) => {
        const copies = stampCopies[i] as WeakMap<TerrainStamp, TerrainStamp | null>;
        const sources = doc.terrainStamps.filter((s) => copyOn(copies, tile, s) !== null);
        tile.source.terrainRelief = doc.terrainRelief;
        if (reliefMoved || !tile.source.terrainGround) {
          if (reliefMoved) { tile.heights = null; tile.mesh = null; tile.asked = false; }
          tile.source.terrainGround = (lx, ly) => groundOn(tile, lx, ly);
        }
        if (!reliefMoved && tile.source.terrainRevision !== 0 && sameList(sources, tile.source.stampSources)) return;
        tile.source.stampSources = sources;
        tile.source.terrainStamps = sources.map((s) => copies.get(s) as TerrainStamp);
        tile.source.terrainRevision = doc.terrainRevision;
        // Its sea read again over the ground as edited.
        if (ocean && !oceanQueue.includes(tile.face)) oceanQueue.push(tile.face);
      });
    }
    if (doc.paintRevision !== seenPaint) {
      seenPaint = doc.paintRevision;
      tiles.forEach((tile, i) => {
        const copies = dabCopies[i] as WeakMap<PaintDab, PaintDab | null>;
        const sources = doc.terrainPaint.filter((d) => copyOn(copies, tile, d) !== null);
        if (sameList(sources, tile.source.paintSources)) return;
        tile.source.paintSources = sources;
        tile.source.terrainPaint = sources.map((d) => copies.get(d) as PaintDab);
        tile.source.paintRevision = doc.paintRevision;
      });
    }
    if (readContent(doc)) refresh();
  };
  /** The land of a piece with nothing on it, as its surface would carry it (`TERRAIN_BASE` and the planet's relief). */
  const bareAt = (t: Tile, lx: number, ly: number): number => {
    const relief = seenRelief ?? RELIEF_FLAT;
    const ground = bare[t.face] ??= tileGround(t.face, relief);
    return TERRAIN_BASE + ground(lx, ly);
  };
  /** Corners along a plate's side (the terrain's grid). */
  const SIDE = Math.round((2 * TERRAIN_HALF) / TERRAIN_CELL) + 1;
  /**
   * A piece's land at a point of its map: its corners as the workers read
   * them (the same numbers the field gives there), bilinear between them;
   * the field itself off the plate or before they come.
   */
  function groundOn(t: Tile, lx: number, ly: number): number {
    const h = t.heights;
    if (h) {
      const gx = (lx + TERRAIN_HALF) / TERRAIN_CELL, gy = (TERRAIN_HALF - ly) / TERRAIN_CELL;
      if (gx >= 0 && gy >= 0 && gx <= SIDE - 1 && gy <= SIDE - 1) {
        const i = Math.min(SIDE - 2, Math.floor(gx)), j = Math.min(SIDE - 2, Math.floor(gy));
        const u = gx - i, v = gy - j, k = j * SIDE + i;
        const a = h[k]!, b = h[k + 1]!, c = h[k + SIDE]!, d = h[k + SIDE + 1]!;
        return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v - TERRAIN_BASE;
      }
    }
    const relief = seenRelief ?? RELIEF_EARTH;
    const ground = bare[t.face] ??= tileGround(t.face, relief);
    return ground(lx, ly);
  }
  let failedOffPage = false;
  let focusKey = '';
  /** The pieces the view wants in full, nearest first, and those of them made (reused: no allocation a frame). */
  const wantedNear: Tile[] = [];
  const nextNear: number[] = [];
  /**
   * Asks the workers for a piece's corners and first build, the nearest the
   * view first: the far globe stands in meanwhile (Proland's asynchronous
   * producers, "the first ancestor tile that is ready").
   */
  const askCorners = (t: Tile): void => {
    if (t.asked || t.mesh || t.surface || seenRelief === null) return;
    t.asked = true;
    const relief = seenRelief;
    readFlatGround({
      key: t.face, relief, tile: t.face, at: { x: t.cx, y: t.cy }, cx: 0, cy: 0, half: TERRAIN_HALF, cell: TERRAIN_CELL, side: SIDE, base: TERRAIN_BASE,
      done: (mesh) => {
        t.asked = false;
        // A piece made meanwhile keeps the field it was made on; a relief changed meanwhile, the new one.
        if (relief === seenRelief && !t.surface) { t.heights = mesh.heights; t.mesh = mesh; }
        focusKey = '';
      },
      failed: () => { t.asked = false; t.heights = null; t.mesh = null; failedOffPage = true; focusKey = ''; },
    });
  };

  /** A region of the atlas's number line: its plate, and the plate's own corners. */
  const decode = (region: TerrainRegion): { tile: Tile; local: TerrainRegion } => {
    const index = Math.floor(region[0] / REGION_STRIDE);
    const off = index * REGION_STRIDE;
    return { tile: tiles[index] as Tile, local: [region[0] - off, region[1] - off, region[2], region[3]] };
  };
  const encode = (tile: Tile, region: TerrainRegion): TerrainRegion => {
    const off = tile.face * REGION_STRIDE;
    return [region[0] + off, region[1] + off, region[2], region[3]];
  };
  /** A road field asked in a face's coordinates, the neighbours' roads and sites too (`chartShaper.ts`). */
  const shaperFor = (tile: Tile, shape: TerrainShaper): TerrainShaper => chartShaper(tile.face, tile.cx, tile.cy, shape);

  let lastTile: Tile | null = null;
  const geologyChanges = new GroundChanges();
  const geologySeen = new Map<Tile, number>();
  const sum = (read: (s: TerrainSurface) => number): number => {
    let total = 0;
    for (const t of shownList) total += read(t.surface!);
    return total;
  };

  /**
   * A question asked in the atlas's coordinates: the piece's surface, or the
   * land itself where it has none - always the piece that OWNS that ground.
   * A point written on a chart past its own piece (a junction's plate, a
   * blast's debris, a torn wire, the camera's eye, all worked out on one
   * chart) lies over the neighbour's ground: each plate draws only its own
   * piece, and read off the chart's plate it got that plate's edge, or the
   * land of another piece altogether (a torn wire stood up over the
   * buildings). As terrain tiles are sampled by the tile that holds the
   * point (Unity `TerrainMap`), it is carried to its owner first.
   */
  const owned = { x: 0, y: 0 };
  const ask = <T>(x: number, y: number, read: (s: TerrainSurface, lx: number, ly: number) => T, bareRead: (t: Tile, lx: number, ly: number) => T): T => {
    let tile = tileAt(x, y);
    if (!onTile(tile.face, x - tile.cx, y - tile.cy)) {
      ownerOfChartPointInto(tile.face, x, y, owned);
      x = owned.x;
      y = owned.y;
      tile = tileAt(x, y);
    }
    return tile.surface ? read(tile.surface, x - tile.cx, y - tile.cy) : bareRead(tile, x - tile.cx, y - tile.cy);
  };

  /**
   * The ecosystem a few plates a frame (`settleEcology`), the nearest the
   * view first, within `ECOLOGY_BUDGET_MS`; the revision the atlas shows
   * moves on only when no plate waits, so the trees are swept once.
   */
  const ECOLOGY_BUDGET_MS = 8;
  let focusFace = 0;
  let ecologyShown = 0;
  let ecologyWaiting = false;
  const waiting: Tile[] = [];
  const settleEcology = (): void => {
    waiting.length = 0;
    for (const t of shownList) if (t.surface!.ecologyPending) waiting.push(t);
    ecologyWaiting = waiting.length > 0;
    if (!ecologyWaiting) return;
    const f = TILES[focusFace]!.centre;
    const nearness = (t: Tile): number => { const c = TILES[t.face]!.centre; return c.x * f.x + c.y * f.y + c.z * f.z; };
    waiting.sort((a, b) => nearness(b) - nearness(a));
    const started = performance.now();
    let done = 0;
    for (const t of waiting) {
      t.surface!.settleEcology?.();
      done++;
      if (performance.now() - started > ECOLOGY_BUDGET_MS) break;
    }
    ecologyWaiting = done < waiting.length;
  };

  const first = tiles[0] as Tile;
  ensure(first);
  refresh();
  const firstSurface = first.surface!;
  const focusDir: Vec3 = { x: 0, y: 0, z: 0 };
  return {
    meshes: [root],
    highest: () => highest,
    // The Earth's sea holds the roads up wherever the land is the Earth's.
    seaHold: () => (globeRelief === RELIEF_EARTH ? 1 : 0),
    ground: firstSurface.ground,
    get parts() { return partsShown; },
    focus(x, y, reach) {
      // Proland's split rule on the pieces: in full within some times the
      // ground the view takes in of what it looks at, none from far out.
      // Worked out again only when the view moved to another piece or reach;
      // a piece comes in once its corners and first build are made off the
      // page, one a frame at most - the far globe stands in meanwhile.
      const wantNear = reach < NEAR_VIEW;
      // The pieces whose ground the view takes in, and a piece's half round them.
      const radius = Math.min(NEAR_RADIUS, Math.max(TILE_HALF * 1.5, reach * 1.6) + TILE_HALF * 1.5);
      atlasToSphereInto(x, y, focusDir);
      layOcean(focusDir);
      setFlatGroundFocus(x, y);
      const key = `${tileCellOf(x, y)}:${wantNear ? Math.round(radius / (TILE_HALF * 0.5)) : -1}`;
      if (key !== focusKey) {
        focusKey = key;
        wantedNear.length = 0;
        if (wantNear) {
          const cos = Math.cos(radius / PLANET_RADIUS);
          for (let i = 0; i < TILE_COUNT; i++) {
            const c = TILES[i]!.centre;
            if (c.x * focusDir.x + c.y * focusDir.y + c.z * focusDir.z >= cos) wantedNear.push(tiles[i]!);
          }
          const near = (t: Tile): number => { const c = TILES[t.face]!.centre; return c.x * focusDir.x + c.y * focusDir.y + c.z * focusDir.z; };
          wantedNear.sort((a, b) => near(b) - near(a));
          if (wantedNear.length > NEAR_MOST) wantedNear.length = NEAR_MOST;
        }
        for (const t of tiles) if (t.asked && !wantedNear.includes(t) && !content.has(t.face)) { cancelFlatGround(t.face); t.asked = false; }
      }
      // One piece made this frame: the nearest whose first build is in (or, with no workers, the nearest at all).
      const offPage = !failedOffPage && flatGroundOffPage();
      let made = false;
      for (const t of wantedNear) {
        if (t.surface) continue;
        if (offPage && !t.mesh) { askCorners(t); continue; }
        if (made) continue;
        ensure(t);
        made = true;
      }
      nextNear.length = 0;
      for (const t of wantedNear) if (t.surface) nextNear.push(t.face);
      const pending = nextNear.some((i) => !tiles[i]!.shown);
      if (!pending && nextNear.length === near.length && nextNear.every((v, k) => v === near[k])) return;
      near = nextNear.slice();
      refresh();
    },
    // Each plate is its piece's flat map (east x, up y, north -z at its
    // centre, `bend.ts`), and its land's light is baked for the sun ON THAT
    // MAP: the sun fixed over the planet, it turns only with the hour.
    setSun(direction) {
      lastSun = direction;
      const sunOnPlanet = planetSunOnPlanet();
      for (const t of shownList) sunFor(t, sunOnPlanet);
    },
    bakeRelief(renderer: WebGLRenderer, focus) {
      // The close window only where the view is; every plate its own map-wide level.
      const at = focus ? tileAt(focus.x, -focus.z) : null;
      if (at) focusFace = at.face;
      // The plates nearest the view are lit first (terrainLightPool.ts).
      if (at) { setLightFocus(at.face); setEcologyFocus(at.face); }
      for (const t of shownList) t.surface!.bakeRelief(renderer, t === at && focus ? { x: focus.x - t.cx, z: focus.z + t.cy } : null);
    },
    // Asked every frame; passed to the plates only when the weather changed it.
    setWaterLook(look: WaterLook) {
      const was = lastLook;
      if (was.waves === look.waves && was.foam === look.foam && was.current === look.current
        && was.windX === look.windX && was.windZ === look.windZ && was.windSpeed === look.windSpeed) return;
      Object.assign(was, look);
      lookGiven = true;
      for (const t of tiles) t.surface?.setWaterLook(look);
      ocean?.setLook(look);
    },
    setGullies(dabs: readonly GullyDab[], auto) {
      lastGullies = { dabs, auto };
      for (const t of tiles) if (t.surface) gulliesFor(t, dabs, auto);
      if (lastDoc && readContent(lastDoc)) refresh();
    },
    vergeMaterial: firstSurface.vergeMaterial,
    heightAt: (x, y) => ask(x, y, (s, lx, ly) => s.heightAt(lx, ly), bareAt),
    naturalRenderedHeightAt: (x, y) => ask(x, y, (s, lx, ly) => s.naturalRenderedHeightAt(lx, ly), bareAt),
    renderedHeightAt: (x, y) => ask(x, y, (s, lx, ly) => s.renderedHeightAt(lx, ly), bareAt),
    wetAt: (x, y) => ask(x, y, (s, lx, ly) => s.wetAt(lx, ly), () => false),
    digest(minX, minY, maxX, maxY) {
      const tile = tileAt((minX + maxX) / 2, (minY + maxY) / 2);
      if (!tile.surface) return tile.face * 7919 + (seenRelief ?? 0) * 31 + 1;
      return tile.surface.digest(minX - tile.cx, minY - tile.cy, maxX - tile.cx, maxY - tile.cy) + tile.face;
    },
    update(doc, stroking) {
      sync(doc);
      let moved = false;
      for (const t of shownList) {
        if (t.surface!.update(t.source, stroking)) { moved = true; lastTile = t; measured.add(t); }
      }
      measure();
      return moved;
    },
    updatePaint(doc) {
      sync(doc);
      for (const t of shownList) {
        t.surface!.updatePaint(t.source, true);
        const v = t.surface!.geologyChanges.version;
        if (v !== geologySeen.get(t)) { geologySeen.set(t, v); geologyChanges.mark(null); }
      }
      settleEcology();
    },
    forestAt: (x, y) => ask(x, y, (s, lx, ly) => s.forestAt(lx, ly), () => 0),
    coverAt: (kind: CoverKind, x, y) => ask(x, y, (s, lx, ly) => s.coverAt(kind, lx, ly), () => 0),
    get forestRevision() { return sum((s) => s.forestRevision) + shownVersion * 1_000_003; },
    geologyAt: (x, y) => ask(x, y, (s, lx, ly) => s.geologyAt(lx, ly), (): GeologyKind => firstSurface.geologyAt(0, 0)),
    ecology: () => firstSurface.ecology(),
    get ecologyRevision() {
      if (!ecologyWaiting) ecologyShown = sum((s) => s.ecologyRevision) + shownVersion * 1_000_003;
      return ecologyShown;
    },
    ecologyTexture: firstSurface.ecologyTexture,
    geologyChanges,
    shoreLevelAt: (x, y) => ask(x, y, (s, lx, ly) => s.shoreLevelAt(lx, ly), () => null),
    waterArea() {
      let box: { minX: number; maxX: number; minY: number; maxY: number } | null = null;
      for (const t of shownList) {
        const w = t.surface!.waterArea();
        if (!w) continue;
        const b = { minX: w.minX + t.cx, maxX: w.maxX + t.cx, minY: w.minY + t.cy, maxY: w.maxY + t.cy };
        box = box ? { minX: Math.min(box.minX, b.minX), maxX: Math.max(box.maxX, b.maxX), minY: Math.min(box.minY, b.minY), maxY: Math.max(box.maxY, b.maxY) } : b;
      }
      return box;
    },
    get waterRevision() { return sum((s) => s.waterRevision); },
    get lastRegion() {
      const region = lastTile?.surface?.lastRegion ?? null;
      return region && lastTile ? encode(lastTile, region) : null;
    },
    settle() { for (const t of shownList) t.surface!.settle(); },
    shapeToRoads(shape, region = null) {
      const list: readonly TerrainRegion[] | null = region === null ? null
        : typeof region[0] === 'number' ? [region as TerrainRegion] : region as readonly TerrainRegion[];
      let moved = false;
      if (list === null) {
        for (const t of shownList) if (t.surface!.shapeToRoads(shape && shaperFor(t, shape), null)) { moved = true; measured.add(t); }
        measure();
        return moved;
      }
      const byTile = new Map<Tile, TerrainRegion[]>();
      for (const r of list) {
        const { tile, local } = decode(r);
        let mine = byTile.get(tile);
        if (!mine) byTile.set(tile, mine = []);
        mine.push(local);
      }
      for (const [t, regions] of byTile) if (ensure(t).shapeToRoads(shape && shaperFor(t, shape), regions)) { moved = true; measured.add(t); }
      measure();
      return moved;
    },
    regionOf(box) {
      const tile = tileAt((box[0] + box[2]) / 2, (box[1] + box[3]) / 2);
      return encode(tile, ensure(tile).regionOf([box[0] - tile.cx, box[1] - tile.cy, box[2] - tile.cx, box[3] - tile.cy]));
    },
    rectOf(region) {
      const { tile, local } = decode(region);
      const r = ensure(tile).rectOf(local);
      return [r[0] + tile.cx, r[1] + tile.cy, r[2] + tile.cx, r[3] + tile.cy];
    },
    dispose() {
      for (const t of tiles) t.surface?.dispose();
      globeSurface.dispose();
      ocean?.dispose();
    },
  };
}

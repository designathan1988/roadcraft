import { Box3, BufferAttribute, BufferGeometry, Group, Mesh, Sphere, Vector3 } from 'three';
import { gpuOnly } from '../mesh/gpuOnly';
import { cancelWarm, warmLooseAhead } from '../uploads';
import { m } from '@world/units';
import type { CellMass } from './cellArrays';
import type { BuildingKit } from './kit';
import { FLAT_DEPTH } from './buildingMesh';
import { cellIndex, levelCells, plateOf, TILE_CELLS, tileOf } from './massLevels';
import { PLATE_DETAIL, TILE_DETAIL } from './massing';

/** THE BUILDINGS' FAR LEVEL, cell by cell: each cell of the buildings' grid */
/** Above the cells, a tile (L2, 16 cells) and a plate (L3, 64 cells) of masses, one mesh each, chosen as Cesium's HLOD does (`massLevels.ts`) */
/** Only the buildings of the page's document (the tiles loaded): the other tiles' are baked in workers from the tile store (`farLevels.ts`) */

/** The largest thing the far level leaves out, m: a balcony's slab (1.3 m) or a sill and its frame stand out of the wall */
export const FAR_ERROR = m(1.5);
/** The largest thing the facade level (L1, `emitChunk` `far`) leaves out, m: the deepest reveal it lays flat. */
const FACADE_ERROR = FLAT_DEPTH;
/** The detail is drawn while what the far level leaves out spans this many pixels or more. */
const NEAR_PIXELS = 2;
/** A cell drawn near stays near down to this share of `NEAR_PIXELS`. */
export const HYSTERESIS = 0.85;
/** STREET-LEVEL HORIZON VIEWS: with the eye near the ground and looking along the streets */
const STREET_EYE = m(40);
const HORIZON_HALF = m(150);

/** A cell's key from its column and row (`layer.ts` `cellOf`). */
const keyOf = (i: number, j: number): string => `${i},${j}`;

interface Cell {
  mesh: Mesh | null;
  /** Its buildings have no mass (lots only): drawn by its detail alone, always near. */
  massless: boolean;
  readonly i: number;
  readonly j: number;
  /** Its box in the plan (map x/y) and its highest point, for the distance to the eye. */
  x0: number; y0: number; x1: number; y1: number; top: number;
  near: boolean;
  /** Drawn near and at full detail (L0); near and not fine: its facade level (L1). */
  fine: boolean;
  /** Its tile or its plate is drawn in its place: far, its mass hidden. */
  covered: boolean;
}

/** A tile or a plate: one mesh of its cells' masses, simplified as far as its `error` says (`massing.ts` `MassDetail`). */
interface Level {
  readonly key: string;
  mesh: Mesh | null;
  readonly i0: number;
  readonly j0: number;
  readonly n: number;
  x0: number; y0: number; x1: number; y1: number; top: number;
  /** What it leaves out of the detail, m: the cells' far level's and what it left out on top. */
  error: number;
  /** Drawn in place of its children (Cesium's replacement refinement). */
  coarse: boolean;
  /** A plate's four tiles' keys (none for a tile). */
  readonly tiles: readonly string[];
  /** What its level may leave out before its masses come (`massing.ts` `TILE_DETAIL`, `PLATE_DETAIL`): the error the view is judged by meanwhile. */
  readonly bound: number;
  /** Its masses came and none of its buildings has any: its children stand for it. */
  empty: boolean;
  /** A tile: wanted by the view (its plate refined), so asked of the workers (`massLevels.ts` `wanted`); a plate always is. */
  wanted: boolean;
  /** A tile refined too: its cells drawn one by one, each cell's masses wanted (`exposedCells`). */
  exposed: boolean;
}

export interface MassCells {
  readonly group: Group;
  /** A cell whose masses are asked (new, or its buildings changed): kept as it stands until they come (`land`) */
  plan(key: string): void;
  /** A cell's masses come: its mesh made of them (null: its buildings have no mass, the cell always near). */
  land(key: string, mass: CellMass | null): void;
  /** A cell with no building left: gone. */
  remove(key: string): void;
  /** A tile's or a plate's masses come (`massLevels.ts`; null: none of its buildings has any): the old ones stood until now. */
  landLevel(key: string, mass: CellMass | null): void;
  /** A tile or a plate with no building left: gone. */
  removeLevel(key: string): void;
  /** A tile or a plate that has buildings, its masses asked or not yet (`massLevels.ts` `plan`). */
  planLevel(key: string): void;
  /** Whether the view wants a tile's masses (its plate refined); a plate's always. */
  wanted(key: string): boolean;
  /** The cells drawn one by one now (their tile refined, `choose`): the only cells whose own masses are asked (`layer.ts`). */
  exposedCells(): Iterable<string>;
  /** Levels the view would draw and whose masses have not come: the town is not shown whole before they do (`layer.ts` `pending`). */
  readonly waiting: number;
  /** Whether a tile or a plate is drawn in place of its cells. */
  coarse(key: string): boolean;
  /** Every cell there is (the whole town filed again, `layer.ts`). */
  keys(): IterableIterator<string>;
  /** Which cells are drawn near (their detail) and which far (their masses), from the eye (map x/y, height) and the screen */
  choose(eyeX: number, eyeY: number, eyeZ: number, pxAtMetre: number, orthoPx: number | null, allNear: boolean | ReadonlySet<string>, reach?: number): void;
  /** Whether a cell is drawn near; a cell with no mass (lawns only), or none known, always is. */
  near(key: string): boolean;
  /** Whether a cell is drawn at full detail (L0) rather than its facade level (L1); a cell not near is not. */
  fine(key: string): boolean;
  /** The cells drawn near now (what the streaming of the detail reads, `layer.ts` `landCells`). */
  nearKeys(): Iterable<string>;
  /** Whether a cell's detail is shown (`layer.ts` streaming): a near cell keeps its mass shown until its detail lands */
  setDetailed(key: string, detailed: boolean): void;
  /** The highest point of any cell's masses (the shadow's reach over the view, `renderer.ts`); -Infinity with none. */
  top(): number;
  dispose(): void;
}

const boxOf = (b: Float64Array): Box3 => new Box3(new Vector3(b[0], b[1], b[2]), new Vector3(b[3], b[4], b[5]));
const sphereOf = (b: Float64Array): Sphere => new Sphere(new Vector3(b[6], b[7], b[8]), b[9]);

/** What the eye reads of a box (`measureSeen`): a metre's pixels there, the pixels allowed, its distance across the plan. */
export interface Seen { perMetre: number; allowed: number; across: number }

/** What the eye reads of a box (plan x/y, top), as Cesium measures to a tile's bounding volume; the eye low, the farther the box the more error it may make (`HORIZON_HALF`). */
export function measureSeen(seen: Seen, eyeX: number, eyeY: number, eyeZ: number, pxAtMetre: number, orthoPx: number | null, x0: number, y0: number, x1: number, y1: number, top: number): void {
  const dx = Math.max(x0 - eyeX, 0, eyeX - x1);
  const dy = Math.max(y0 - eyeY, 0, eyeY - y1);
  seen.across = Math.hypot(dx, dy);
  seen.allowed = NEAR_PIXELS;
  if (orthoPx !== null) { seen.perMetre = orthoPx; return; }
  const d = Math.max(Math.hypot(dx, dy, Math.max(eyeZ - top, 0)), 1);
  seen.perMetre = pxAtMetre / d;
  const street = Math.max(0, 1 - eyeZ / STREET_EYE);
  seen.allowed = NEAR_PIXELS * (1 + (street * d) / HORIZON_HALF);
}

/** A cell's mesh from its masses' arrays, taken as they came */
export function cellMesh(mass: CellMass, kit: BuildingKit, name = 'building-massing'): Mesh {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(mass.position, 3));
  g.setAttribute('normal', new BufferAttribute(mass.normal, 4, true));
  g.setAttribute('color', new BufferAttribute(mass.color, 3));
  g.setAttribute('facade', new BufferAttribute(mass.facade, 4));
  g.setAttribute('glazing', new BufferAttribute(mass.glazing, 2));
  g.setIndex(new BufferAttribute(mass.index, 1));
  g.boundingBox = boxOf(mass.bounds);
  g.boundingSphere = sphereOf(mass.bounds);
  const mesh = new Mesh(g, kit.massing);
  gpuOnly(mesh, () => ({}));
  mesh.name = name;
  mesh.matrixAutoUpdate = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function createMassCells(kit: BuildingKit, cellSize: number): MassCells {
  const group = new Group();
  group.name = 'buildings-far';
  group.matrixAutoUpdate = false;
  /** The tiles' and plates' meshes, beside the cells'. */
  const levelGroup = new Group();
  levelGroup.name = 'buildings-far-levels';
  levelGroup.matrixAutoUpdate = false;
  group.add(levelGroup);
  const cells = new Map<string, Cell>();
  const tiles = new Map<string, Level>();
  const plates = new Map<string, Level>();
  /** DO NOT walk every cell of the town each frame to choose */
  const nearKeys = new Set<string>();
  const detailed = new Set<string>();
  /** How far a cell's box reaches past its square (a building over its edge), the most of any: the eye's search is grown by it. */
  let overhang = 0;
  /** DO NOT walk the cells' meshes for it (`Box3.setFromObject` at every cell landed): the highest cell top, walked again only when that cell went or fell. */
  let highest = -Infinity;
  let highestStale = false;
  const lowered = (top: number): void => { if (top >= highest) highestStale = true; };
  /** Whether a cell's tile or plate stands in its place now. */
  const coveredAt = (i: number, j: number): boolean => (tiles.get(tileOf(i, j))?.coarse ?? false) || (plates.get(plateOf(i, j))?.coarse ?? false);
  /** A cell's mass shown: far, or near with no detail to stand in for it; never under its tile or plate. */
  const showMass = (key: string, cell: Cell): void => {
    if (cell.mesh) cell.mesh.visible = !cell.covered && (!cell.near || !detailed.has(key));
  };
  const setNear = (key: string, cell: Cell, near: boolean, fine = near): void => {
    cell.near = near;
    cell.fine = near && fine;
    if (near) nearKeys.add(key); else nearKeys.delete(key);
    showMass(key, cell);
  };
  /** A cell under a tile or plate drawn in its place: far (its detail let go by the layer), its mass hidden; one with no mass stays near. */
  const cover = (key: string, cell: Cell, covered: boolean): void => {
    cell.covered = covered;
    if (covered && !cell.massless) setNear(key, cell, false);
    else showMass(key, cell);
  };
  const dropMesh = (mesh: Mesh): void => {
    cancelWarm([mesh]);
    mesh.parent?.remove(mesh);
    mesh.geometry.dispose();
  };
  const drop = (cell: Cell): void => {
    if (!cell.mesh) return;
    cancelWarm([cell.mesh]);
    group.remove(cell.mesh);
    cell.mesh.geometry.dispose();
    cell.mesh = null;
  };
  /** A cell's square on the map. */
  const square = (i: number, j: number): { x0: number; y0: number; x1: number; y1: number } =>
    ({ x0: i * cellSize, y0: j * cellSize, x1: (i + 1) * cellSize, y1: (j + 1) * cellSize });
  /** A level drawn in place of its cells or not: its mesh shown, its cells covered or uncovered (16 or 64 looked up, on a change only). */
  const setCoarse = (level: Level, coarse: boolean): void => {
    if (level.coarse === coarse) return;
    level.coarse = coarse;
    if (level.mesh) level.mesh.visible = coarse;
    for (let i = level.i0; i < level.i0 + level.n; i++) {
      for (let j = level.j0; j < level.j0 + level.n; j++) {
        const key = keyOf(i, j);
        const cell = cells.get(key);
        if (!cell) continue;
        const covered = coveredAt(i, j);
        if (covered !== cell.covered) cover(key, cell, covered);
      }
    }
  };
  const levelsOf = (key: string): Map<string, Level> => (key[0] === 't' ? tiles : plates);
  /** The tiles refined to their cells now (`choose`). */
  const exposedTiles = new Set<string>();
  let waiting = 0;
  /** A plate is kept while it has a mesh or a tile of its own: its tiles are found through it (`choose`), so a tile makes its plate. */
  const ensure = (key: string): Level => {
    const map = levelsOf(key);
    let level = map.get(key);
    if (level) return level;
    const { i0, j0, n } = levelCells(key);
    const children: string[] = [];
    if (key[0] === 'p') for (let i = i0; i < i0 + n; i += TILE_CELLS) for (let j = j0; j < j0 + n; j += TILE_CELLS) children.push(tileOf(i, j));
    const bound = Math.max(FAR_ERROR, (key[0] === 't' ? TILE_DETAIL : PLATE_DETAIL).drop);
    level = {
      key, mesh: null, i0, j0, n, x0: i0 * cellSize, y0: j0 * cellSize, x1: (i0 + n) * cellSize, y1: (j0 + n) * cellSize, top: 0, error: Infinity, coarse: false,
      tiles: children, bound, empty: false, wanted: key[0] === 'p', exposed: false,
    };
    map.set(key, level);
    if (key[0] === 't') ensure(plateOf(i0, j0));
    return level;
  };
  const forget = (level: Level): void => {
    setCoarse(level, false);
    if (level.mesh) { dropMesh(level.mesh); level.mesh = null; }
    const plate = level.key[0] === 't' ? plates.get(plateOf(level.i0, level.j0)) : level;
    if (level !== plate) { tiles.delete(level.key); exposedTiles.delete(level.key); }
    if (plate && !plate.mesh && !plate.tiles.some((k) => tiles.has(k))) plates.delete(plate.key);
  };
  /** The tiles and plates holding a cell held near (`choose`'s `allNear`): never drawn in its place. */
  const forcedLevels = new Set<string>();
  /** What the eye reads of a box, one object for every box measured (`measureSeen`). */
  const seen: Seen = { perMetre: 0, allowed: NEAR_PIXELS, across: 0 };
  const measure = (eyeX: number, eyeY: number, eyeZ: number, pxAtMetre: number, orthoPx: number | null, x0: number, y0: number, x1: number, y1: number, top: number): void =>
    measureSeen(seen, eyeX, eyeY, eyeZ, pxAtMetre, orthoPx, x0, y0, x1, y1, top);
  return {
    group,
    plan(key) {
      if (cells.has(key)) return;
      const [i, j] = cellIndex(key);
      // Near until the eye says otherwise (`choose`), as a cell made before the eye is known; far under a tile or plate drawn.
      const covered = coveredAt(i, j);
      const cell: Cell = { mesh: null, massless: false, i, j, ...square(i, j), top: 0, near: !covered, fine: !covered, covered };
      cells.set(key, cell);
      setNear(key, cell, !covered);
    },
    land(key, mass) {
      const known = cells.get(key);
      if (known) drop(known);
      const [i, j] = cellIndex(key);
      const covered = coveredAt(i, j);
      const cell: Cell = { mesh: null, massless: mass === null, i, j, ...square(i, j), top: 0, near: known?.near ?? !covered, fine: known?.fine ?? !covered, covered };
      if (known) lowered(known.top);
      if (mass) {
        const mesh = cellMesh(mass, kit);
        const box = mesh.geometry.boundingBox!;
        cell.mesh = mesh;
        cell.top = mass.top;
        // At least the old highest: the highest of all, whatever went before it.
        if (cell.top >= highest) { highest = cell.top; highestStale = false; }
        // A building reaching past its cell's edge: the cell's box is its masses'.
        const { x0, y0, x1, y1 } = cell;
        cell.x0 = Math.min(x0, box.min.x); cell.x1 = Math.max(x1, box.max.x); cell.y0 = Math.min(y0, -box.max.z); cell.y1 = Math.max(y1, -box.min.z);
        overhang = Math.max(overhang, x0 - cell.x0, cell.x1 - x1, y0 - cell.y0, cell.y1 - y1);
        group.add(mesh);
        // DO NOT wait for the camera to frame it: a cell of masses out of view was never uploaded and kept its copy on the CPU
        void warmLooseAhead([mesh]);
      }
      cells.set(key, cell);
      // A cell with no mass is always near (its detail is all it has); one under its tile or plate far.
      const near = cell.massless || (!covered && cell.near);
      setNear(key, cell, near, cell.massless || cell.fine);
    },
    remove(key) {
      const cell = cells.get(key);
      if (!cell) return;
      drop(cell);
      cells.delete(key);
      nearKeys.delete(key);
      lowered(cell.top);
    },
    landLevel(key, mass) {
      const level = ensure(key);
      if (level.mesh) { dropMesh(level.mesh); level.mesh = null; }
      const { i0, j0, n } = level;
      Object.assign(level, { x0: i0 * cellSize, y0: j0 * cellSize, x1: (i0 + n) * cellSize, y1: (j0 + n) * cellSize, top: 0, error: Infinity });
      // None of its buildings has a mass: its cells stand for it, whatever the eye says.
      level.empty = !mass;
      if (!mass) { setCoarse(level, false); return; }
      const mesh = cellMesh(mass, kit, key[0] === 't' ? 'building-massing-tile' : 'building-massing-plate');
      const box = mesh.geometry.boundingBox!;
      level.mesh = mesh;
      level.top = mass.top;
      // What it leaves out of the detail: the cells' far level's, and what its own level left out on top (`massing.ts` `leaves`).
      level.error = Math.max(FAR_ERROR, mass.error);
      level.x0 = Math.min(level.x0, box.min.x); level.x1 = Math.max(level.x1, box.max.x); level.y0 = Math.min(level.y0, -box.max.z); level.y1 = Math.max(level.y1, -box.min.z);
      mesh.visible = level.coarse;
      levelGroup.add(mesh);
      // Sent ahead as the cells' are: shown from far off the first time the eye pulls back, never uploaded mid-frame.
      void warmLooseAhead([mesh]);
    },
    removeLevel(key) {
      const level = levelsOf(key).get(key);
      if (level) forget(level);
    },
    planLevel(key) {
      ensure(key);
    },
    wanted(key) {
      return key[0] === 'p' || (tiles.get(key)?.wanted ?? false);
    },
    *exposedCells() {
      for (const key of exposedTiles) {
        const tile = tiles.get(key);
        if (!tile) continue;
        for (let i = tile.i0; i < tile.i0 + tile.n; i++) for (let j = tile.j0; j < tile.j0 + tile.n; j++) { const cell = keyOf(i, j); if (cells.has(cell)) yield cell; }
      }
    },
    get waiting() {
      return waiting;
    },
    coarse(key) {
      return levelsOf(key).get(key)?.coarse ?? false;
    },
    keys() {
      return cells.keys();
    },
    choose(eyeX, eyeY, eyeZ, pxAtMetre, orthoPx, allNear, reach = Infinity) {
      // THE LEVELS FIRST, from the plates down (Cesium `selectTiles`): a level is drawn in place of its children while what it leaves out spans under the pixels the cells' masses are drawn for
      forcedLevels.clear();
      if (allNear !== true && allNear !== false) for (const key of allNear) { const [i, j] = cellIndex(key); forcedLevels.add(tileOf(i, j)); forcedLevels.add(plateOf(i, j)); }
      /** Whether the view wants a level drawn in place of its children: judged by its error once its masses came, by what its level may leave out before. */
      const coarseWanted = (level: Level): boolean => {
        if (level.empty || allNear === true || forcedLevels.has(level.key)) return false;
        measure(eyeX, eyeY, eyeZ, pxAtMetre, orthoPx, level.x0, level.y0, level.x1, level.y1, level.top);
        // Refined while its error spans the pixels, down to `HYSTERESIS` of them once refined (as a cell near stays near).
        return (level.mesh ? level.error : level.bound) * seen.perMetre < seen.allowed * (level.coarse ? 1 : HYSTERESIS);
      };
      // DO NOT ask what a coarser level stands for (Cesium's selection, top down): a plate wanted whole needs neither its tiles nor its cells.
      waiting = 0;
      for (const plate of plates.values()) {
        const plateWhole = coarseWanted(plate);
        setCoarse(plate, plateWhole && plate.mesh !== null);
        if (plateWhole && !plate.mesh) waiting++;
        for (const key of plate.tiles) {
          const tile = tiles.get(key);
          if (!tile) continue;
          tile.wanted = !plateWhole;
          const tileWhole = !plateWhole && coarseWanted(tile);
          setCoarse(tile, tileWhole && tile.mesh !== null);
          if (tileWhole && !tile.mesh) waiting++;
          tile.exposed = !plateWhole && !tileWhole;
          if (tile.exposed) exposedTiles.add(key); else exposedTiles.delete(key);
        }
      }
      const decide = (key: string, cell: Cell): void => {
        let near: boolean, fine = true;
        const forced = allNear === true || (allNear !== false && allNear.has(key));
        if (forced || cell.massless) near = true;
        else if (cell.covered) near = false;
        else {
          measure(eyeX, eyeY, eyeZ, pxAtMetre, orthoPx, cell.x0, cell.y0, cell.x1, cell.y1, cell.top);
          const { perMetre, allowed, across } = seen;
          // Within reach, with a margin for a cell already near (hysteresis).
          near = FAR_ERROR * perMetre >= allowed * (cell.near ? HYSTERESIS : 1) && across <= reach * (cell.near ? 1.25 : 1);
          // Its facade level once what that leaves out is under the pixels the detail is drawn for.
          fine = FACADE_ERROR * perMetre >= allowed * (cell.fine ? HYSTERESIS : 1);
        }
        if (near !== cell.near || (near && fine) !== cell.fine) setNear(key, cell, near, fine);
      };
      // Those near now may go far; those named stay near.
      for (const key of [...nearKeys]) decide(key, cells.get(key)!);
      if (allNear !== true && allNear !== false) for (const key of allNear) { const cell = cells.get(key); if (cell && !cell.near) decide(key, cell); }
      // A far cell comes near only within the farthest a near cell may be on the map
      const within = allNear === true ? Infinity
        : orthoPx !== null ? (FAR_ERROR * orthoPx >= NEAR_PIXELS ? reach : 0)
          : Math.min(reach, (FAR_ERROR * pxAtMetre) / NEAR_PIXELS);
      if (within <= 0) return;
      const r = within + overhang;
      const i0 = Math.floor((eyeX - r) / cellSize), i1 = Math.floor((eyeX + r) / cellSize);
      const j0 = Math.floor((eyeY - r) / cellSize), j1 = Math.floor((eyeY + r) / cellSize);
      const span = (i1 - i0 + 1) * (j1 - j0 + 1);
      // Past the town's own cells (a view of the whole map): its cells, no more.
      if (!Number.isFinite(span) || span > cells.size) {
        for (const [key, cell] of cells) if (!cell.near) decide(key, cell);
        return;
      }
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const key = keyOf(i, j);
          const cell = cells.get(key);
          if (cell && !cell.near) decide(key, cell);
        }
      }
    },
    near(key) {
      return cells.get(key)?.near ?? true;
    },
    fine(key) {
      return cells.get(key)?.fine ?? true;
    },
    nearKeys() {
      return nearKeys;
    },
    setDetailed(key, on) {
      if (on) detailed.add(key); else detailed.delete(key);
      const cell = cells.get(key);
      if (cell) showMass(key, cell);
    },
    top() {
      if (highestStale) {
        highestStale = false;
        highest = -Infinity;
        for (const cell of cells.values()) if (cell.mesh && cell.top > highest) highest = cell.top;
      }
      return highest;
    },
    dispose() {
      for (const cell of cells.values()) drop(cell);
      cells.clear();
      for (const map of [tiles, plates]) {
        for (const level of map.values()) if (level.mesh) dropMesh(level.mesh);
        map.clear();
      }
      exposedTiles.clear();
      waiting = 0;
      highest = -Infinity;
      highestStale = false;
      nearKeys.clear();
      detailed.clear();
    },
  };
}

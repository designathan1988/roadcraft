import { Box3, type BufferAttribute, type BufferGeometry, type Frustum, type Mesh } from 'three';
import { geometryCost } from '../gpuLedger';
import { fillArrays } from './gpuOnly';
import { type BlockLevels, levelsOf } from './roadLod';
import { restoreFarLevel } from './surfaceTiles';
import { cancelWarm, warmLooseAhead } from '../uploads';

/** DO NOT keep a far block's full mesh: no pixel of it is resolved from there. */

/** A block goes far when it is this much farther than `reach`, so one near the line is not asked twice. */
export const FAR_MARGIN = 1.25;
/** Blocks brought near in one look: each is made again from its tiles, a few milliseconds. */
const BRING_PER_LOOK = 3;

/** The block's distance to the camera in the ground plane, scene units (x, z = -y). */
const distance = (levels: BlockLevels, focusX: number, focusY: number): number => {
  let d = Math.hypot(levels.x - focusX, levels.z + focusY);
  for (const [x, z] of levels.also ?? []) d = Math.min(d, Math.hypot(x - focusX, z + focusY));
  return d;
};

/** The arrays of a mesh's attributes and index let go (made again by `refillArrays`). */
function giveBackArrays(mesh: Mesh): void {
  const geometry = mesh.geometry as BufferGeometry;
  // Its size forgotten with it (`gpuOnly.ts` keptBytes): the geometry is disposed below, nothing of it stays on the GPU. DO NOT keep it: the memory counters and the ledger counted every far block's full level as held (`memoryCounters.ts`).
  const letGo = (attribute: BufferAttribute): void => {
    const own = attribute as unknown as { array: ArrayLike<number> | null; keptBytes?: number };
    own.array = null;
    delete own.keptBytes;
  };
  for (const attribute of Object.values(geometry.attributes)) letGo(attribute as BufferAttribute);
  if (geometry.index) letGo(geometry.index);
}

/** The block's far level shown, its full mesh's buffers given back. */
export function makeFar(mesh: Mesh): void {
  const levels = levelsOf(mesh);
  if (!levels?.coarse || !levels.full) return;
  levels.full = false;
  mesh.visible = false;
  levels.coarse.visible = true;
  // Its arrays may still be here (never drawn, so never uploaded): none is kept for a block nobody sees.
  giveBackArrays(mesh);
  mesh.geometry.dispose();
}

/** The block's full mesh shown, the coarse one hidden. */
function showFull(mesh: Mesh, levels: BlockLevels): void {
  levels.full = true;
  mesh.visible = true;
  levels.coarse!.visible = false;
}

/** The block's full mesh made again on the page from its tiles' rings (`refillArrays`) and shown. */
function refillNow(mesh: Mesh, levels: BlockLevels): void {
  const refill = mesh.userData.refillArrays as (() => void) | undefined;
  if (!refill) return;
  refill();
  showFull(mesh, levels);
}

/** The block's full mesh brought back and shown; the coarse one is hidden. */
export function makeNear(mesh: Mesh): void {
  const levels = levelsOf(mesh);
  if (!levels?.coarse || levels.full || levels.bringing) return;
  const bring = levels.bring;
  if (!bring) { refillNow(mesh, levels); return; }
  // DO NOT cut and triangulate the block's tiles on the page again (3 blocks every 6 frames while the camera moves): its arrays come from the kept tiles, shown when they land.
  levels.bringing = true;
  void bring().then((arrays) => {
    levels.bringing = false;
    // Made near by hand or let go meanwhile (`disposeMesh` drops the far level): nothing to show.
    if (levels.full || !levels.coarse) return;
    if (arrays && fillArrays(mesh, arrays)) showFull(mesh, levels);
    else refillNow(mesh, levels);
  }, () => { levels.bringing = false; });
}

/**
 * THE ROADS' LEVELS UNDER BUDGETS (`quality.ts` GEOMETRY_BUDGETS roadsNearMB, roadsFarMB), REFINED BY REPLACEMENT (3D Tiles `REPLACE`):
 * the network's far level (`networkFarRoads.ts`, made from the network for the whole map, a few MB) stands for every road cell for good;
 * a cell's blocks' far levels (`attachFarLevel`, 0.12 m off the full one) replace it where the far budget holds them, and a block's full
 * level replaces its far one where it is wanted and the near budget holds it.
 *
 * Near: wanted within the reach and meeting the view's frustum (Cesium's traversal visits only the tiles in the frustum); past the
 * budget, the near blocks out of the view go first, the least recently seen first (3DTilesRendererJS `lruCache`), then the farthest in
 * it - never a hole, its far level stands. A block is brought near only where its bytes fit (as last measured, or its far level's times
 * `NEAR_PER_FAR` before it ever was near).
 *
 * Far: the cells ranked as the near blocks are (in the view first, the nearest first; then the most recently seen), the ones the budget
 * holds keep their blocks' far levels, the rest are let go a cell at a time (`dropCell`: every block of the cell, so the network's level
 * never lies under a block's) and the network's level shown there; a cell let go that the budget holds again is made again off the page
 * (`BlockLevels.remake`) and the network's level hidden only once every block of it is back (`restoreCell`). A cell with a block near,
 * coming near or whose far level is being made, or that the network's level does not cover, keeps its levels (Cesium's
 * `maximumCacheOverflowBytes`: what the view needs is never let go for the budget).
 */
export interface RoadResidency {
  /** The view's frustum (three's axes); null: every block is in view. */
  view?: Frustum | null;
  /** The most the full levels may hold, bytes. */
  budget?: number;
  /** The most the blocks' far levels may hold, bytes; none: every far level kept. */
  farBudget?: number;
  /** What draws a cell whose blocks' far levels were let go (the network's far level); none: none is let go. */
  network?: CellCover | null;
  /** The looks so far (`updateRoadLevels`): when each block last met the view (`BlockLevels.seenAt`). */
  looks?: number;
  /** The cells let go, the network's far level drawing them. */
  dropped?: Set<string>;
  /** The cells being made again (`restoreCell`). */
  restoring?: Set<string>;
  /** Each cell's far levels' bytes as last measured: what bringing a dropped one back costs. */
  cellBytes?: Map<string, number>;
  /** Set by a look over the far budget that found cells the network's level could not stand for (none, or made before the roads changed): the owner makes it again. */
  wantsNetwork?: boolean;
  /** From this distance (scene units) the network's far level draws a cell in place of its blocks, whatever the budget: the map's view
   *  (`renderer.ts`), where a block's paint and verges are under a pixel; none: the budget alone decides. */
  networkFrom?: number | undefined;
  /** The cells drawn by the network's level for the view (`networkFrom`): their blocks kept, only hidden, so coming back costs nothing. */
  parked?: Set<string>;
}

/** The view's cells drawn by the network's far level (`networkFrom`) and the others given back to their blocks; returns the cells changed.
 *  DO NOT draw a cell's blocks at the map's view: one mesh a block for each surface (asphalt, footway, kerb, verge, planting, each paint
 *  colour), ~320 draw calls of the 448 of a city of 8,102 buildings, against the network level's two (`npm run diagnose`, 2026-10-22). */
function parkCells(cells: ReadonlyMap<string, Cell>, residency: RoadResidency, network: CellCover): number {
  const parked = residency.parked ??= new Set();
  const dropped = residency.dropped!, restoring = residency.restoring!;
  const from = residency.networkFrom;
  let changed = 0;
  for (const cell of cells.values()) {
    const moving = cell.blocks.some((mesh) => { const levels = levelsOf(mesh)!; return levels.pending || levels.bringing; });
    const want = from !== undefined && cell.d >= from && !dropped.has(cell.key) && !restoring.has(cell.key) && !moving;
    if (want && !network.covers(cell.key)) { residency.wantsNetwork = true; }
    if (want && network.covers(cell.key)) {
      // Hidden again at every look: a level a build or a bring showed meanwhile goes back under the network's.
      for (const mesh of cell.blocks) { mesh.visible = false; const coarse = levelsOf(mesh)!.coarse; if (coarse) coarse.visible = false; }
      if (!parked.has(cell.key)) { parked.add(cell.key); network.show(cell.key); changed++; }
    } else if (parked.has(cell.key)) {
      for (const mesh of cell.blocks) {
        const levels = levelsOf(mesh)!;
        if (!levels.coarse) { mesh.visible = true; continue; }
        mesh.visible = levels.full;
        levels.coarse.visible = !levels.full && !levels.dropped;
      }
      parked.delete(cell.key);
      if (!dropped.has(cell.key)) network.hide(cell.key);
      changed++;
    }
  }
  return changed;
}

/** The network's far level as the residency sees it (`networkFarRoads.ts`). */
export interface CellCover {
  /** Whether it draws the cell's roads as they are now (made, of the roads standing, not cut by an opening's view). */
  covers(key: string): boolean;
  show(key: string): void;
  hide(key: string): void;
}

/** Bytes a block's full level holds for its far level's, before it was ever near. */
const NEAR_PER_FAR = 5;
/** How far round a block's box the view meets it, m: a block just past the edge is near before the eye pans onto it. */
const VIEW_MARGIN = 64;
/** Cells made again at once (`restoreCell`): each a few blocks simplified by the workers. */
const RESTORING_AT_ONCE = 2;
/** A dropped cell ranks as if this much farther than it is: a cell at the budget's edge is not let go and made again as the eye moves by a few metres. */
const DROPPED_FARTHER = 1.15;
/** The bytes a block's full level holds on the GPU (its arrays, or what they were once uploaded, `gpuOnly.ts`), kept as its last measure. */
function fullBytes(mesh: Mesh, levels: BlockLevels): number {
  const bytes = geometryCost(mesh.geometry as BufferGeometry).bytes;
  if (bytes > 0) levels.nearBytes = bytes;
  return bytes;
}

/** A road cell as one look sees it. */
interface Cell {
  readonly key: string;
  readonly blocks: Mesh[];
  /** The nearest of its blocks, scene units. */
  d: number;
  seen: boolean;
  at: number;
  /** Its blocks' far levels' bytes now. */
  bytes: number;
  /** A block near, coming near or whose far level is being made: its levels stay. */
  held: boolean;
  /** Blocks whose far level stands (not dropped). */
  live: number;
}

/** Every block of a cell let go to the network's far level: the far levels' geometry given back (made again by `restoreCell`), a block with none (too small to simplify) hidden. */
function dropCell(cell: Cell, residency: RoadResidency): void {
  for (const mesh of cell.blocks) {
    const levels = levelsOf(mesh)!;
    if (levels.coarse) {
      if (levels.dropped) continue;
      levels.dropped = true;
      levels.coarse.visible = false;
      // Out of the upload queue first (`uploads.ts`): one sent ahead after its arrays went found none (three's createBuffer on a null array).
      cancelWarm([levels.coarse]);
      giveBackArrays(levels.coarse);
      levels.coarse.geometry.dispose();
    } else mesh.visible = false;
  }
  residency.cellBytes!.set(cell.key, cell.bytes);
  residency.dropped!.add(cell.key);
  residency.network!.show(cell.key);
}

/** A dropped cell's blocks' far levels made again off the page, shown together in place of the network's level once all are back. */
function restoreCell(cell: Cell, residency: RoadResidency): void {
  const { key } = cell;
  const restoring = residency.restoring!;
  restoring.add(key);
  const blocks = cell.blocks.filter((mesh) => levelsOf(mesh)!.dropped);
  void Promise.all(blocks.map((mesh) => {
    const remake = levelsOf(mesh)!.remake;
    // None made off the page: made here from its tiles (`restoreFarLevel`).
    return remake ? remake().catch((error: unknown) => { console.warn('[roads] a far level could not be made again off the page; made here', error); return null; }) : Promise.resolve(null);
  })).then((made) => {
    restoring.delete(key);
    blocks.forEach((mesh, i) => {
      const levels = levelsOf(mesh);
      // Let go meanwhile (`disposeMesh`): nothing to show.
      if (!levels?.coarse || !levels.dropped) return;
      restoreFarLevel(levels.coarse, made[i] ?? null);
      levels.dropped = false;
      levels.coarse.visible = !levels.full;
      // Sent to the GPU ahead of its first draw, as a far level made by the build is (`roadSurfaces.ts`).
      void warmLooseAhead([levels.coarse]);
    });
    for (const mesh of cell.blocks) if (!levelsOf(mesh)?.coarse) mesh.visible = true;
    residency.dropped!.delete(key);
    residency.network?.hide(key);
  });
}

/** The far levels under `residency.farBudget`: the cells it holds keep them, the rest go to the network's far level (see `RoadResidency`). */
function fitFarLevels(cells: ReadonlyMap<string, Cell>, residency: RoadResidency): number {
  const network = residency.network;
  const budget = residency.farBudget ?? Infinity;
  const dropped = residency.dropped ??= new Set();
  const restoring = residency.restoring ??= new Set();
  const cellBytes = residency.cellBytes ??= new Map();
  residency.wantsNetwork = false;
  if (!network) return 0;
  let changed = parkCells(cells, residency, network);
  const parked = residency.parked!;
  let used = 0;
  const free: Cell[] = [];
  for (const cell of cells.values()) {
    const isDropped = dropped.has(cell.key);
    // Drawn by the network's level for the view: its blocks' far levels kept as they are.
    if (parked.has(cell.key)) { used += cell.bytes; continue; }
    if (!isDropped && cell.live > 0) cellBytes.set(cell.key, cell.bytes);
    // A cell dropped that a build put blocks in since (an edit, the fill): the rest of it made again at once, the new blocks over the network's level meanwhile.
    if (isDropped && cell.live > 0 && !restoring.has(cell.key)) { restoreCell(cell, residency); changed++; }
    if (restoring.has(cell.key)) { used += cellBytes.get(cell.key) ?? 0; continue; }
    // Nothing to let go (its blocks too small to simplify), or held: kept as it is.
    if (!isDropped && (cell.held || cell.live === 0)) { used += cell.bytes; continue; }
    free.push(cell);
  }
  if (budget === Infinity && dropped.size === 0) return changed;
  const farther = (cell: Cell): number => cell.d * (dropped.has(cell.key) ? DROPPED_FARTHER : 1);
  free.sort((a, b) => Number(b.seen) - Number(a.seen) || (a.seen ? farther(a) - farther(b) : b.at - a.at || a.d - b.d));
  const restore: Cell[] = [];
  for (const cell of free) {
    const isDropped = dropped.has(cell.key);
    // DO NOT make again a cell out of the view: the network's level stands there till the eye comes.
    if (isDropped && !cell.seen) continue;
    const bytes = isDropped ? cellBytes.get(cell.key) ?? 0 : cell.bytes;
    if (used + bytes <= budget) {
      used += bytes;
      if (isDropped) restore.push(cell);
      continue;
    }
    if (isDropped) continue;
    // Not covered by the network's level: kept, and the level asked for.
    if (!network.covers(cell.key)) { residency.wantsNetwork = true; used += bytes; continue; }
    dropCell(cell, residency);
    changed++;
  }
  for (const cell of restore) {
    if (restoring.size >= RESTORING_AT_ONCE) break;
    restoreCell(cell, residency);
    changed++;
  }
  return changed;
}

/** The levels brought up to the camera at (`focusX`, `focusY`) in world units, under `residency`'s budgets; returns the blocks and cells changed. */
export function updateRoadLevels(blocks: Iterable<Mesh>, focusX: number, focusY: number, reach: number, residency: RoadResidency = {}): number {
  let changed = 0;
  const look = residency.looks = (residency.looks ?? 0) + 1;
  const viewBox = new Box3();
  const view = residency.view ?? null;
  const budget = residency.budget ?? Infinity;
  const dropped = residency.dropped ??= new Set();
  const wanted: { mesh: Mesh; d: number }[] = [];
  const full: { mesh: Mesh; d: number; seen: boolean; bytes: number; at: number }[] = [];
  const cells = new Map<string, Cell>();
  let total = 0;
  const farFrom = reach * FAR_MARGIN;
  for (const mesh of blocks) {
    const levels = levelsOf(mesh);
    if (!levels) continue;
    const d = distance(levels, focusX, focusY);
    // A far level let go keeps its box (`restoreFarLevel`); a full level let go keeps its own.
    const box = mesh.geometry.boundingBox ?? levels.coarse?.geometry.boundingBox ?? null;
    const seen = !view || !box || view.intersectsBox(viewBox.copy(box).expandByScalar(VIEW_MARGIN));
    if (seen) levels.seenAt = look;
    let cell: Cell | undefined;
    if (levels.cell !== undefined) {
      cell = cells.get(levels.cell);
      if (!cell) cells.set(levels.cell, cell = { key: levels.cell, blocks: [], d, seen, at: levels.seenAt ?? 0, bytes: 0, held: false, live: 0 });
      cell.blocks.push(mesh);
      cell.d = Math.min(cell.d, d);
      cell.seen ||= seen;
      cell.at = Math.max(cell.at, levels.seenAt ?? 0);
      if (levels.pending || levels.bringing) cell.held = true;
    }
    if (!levels.coarse) continue;
    if (cell && !levels.dropped) { cell.live++; cell.bytes += geometryCost(levels.coarse.geometry as BufferGeometry).bytes; }
    if (levels.full) {
      if (cell) cell.held = true;
      if (d > farFrom) { makeFar(mesh); changed++; continue; }
      const bytes = fullBytes(mesh, levels);
      total += bytes;
      full.push({ mesh, d, seen, bytes, at: levels.seenAt ?? 0 });
    } else if (d < reach && seen && !levels.bringing && !levels.dropped && !(levels.cell !== undefined && (dropped.has(levels.cell) || residency.parked?.has(levels.cell)))) wanted.push({ mesh, d });
  }
  // Past the budget: out of the view first, the least recently seen first; then the farthest of the view.
  if (total > budget) {
    full.sort((a, b) => Number(a.seen) - Number(b.seen) || a.at - b.at || b.d - a.d);
    for (const block of full) {
      if (total <= budget) break;
      makeFar(block.mesh);
      total -= block.bytes;
      changed++;
    }
  }
  wanted.sort((a, b) => a.d - b.d);
  let brought = 0;
  for (const { mesh } of wanted) {
    if (brought >= BRING_PER_LOOK) break;
    const levels = levelsOf(mesh)!;
    const bytes = levels.nearBytes ?? geometryCost(levels.coarse!.geometry as BufferGeometry).bytes * NEAR_PER_FAR;
    // The nearest that does not fit holds the rest back: DO NOT bring a farther one in its place.
    if (total + bytes > budget) break;
    total += bytes;
    makeNear(mesh);
    const cell = levels.cell !== undefined ? cells.get(levels.cell) : undefined;
    if (cell) cell.held = true;
    brought++;
    changed++;
  }
  return changed + fitFarLevels(cells, residency);
}

/** The residency's cells forgotten (another map opened: its blocks and the network's level went with the last one). */
export function forgetRoadCells(residency: RoadResidency): void {
  residency.dropped?.clear();
  residency.restoring?.clear();
  residency.cellBytes?.clear();
  residency.parked?.clear();
  residency.wantsNetwork = false;
}

/** Whether a block at (`x`, `y`) in world units is within `reach` of the camera: the level a block is made at. */
export const isNear = (x: number, y: number, focusX: number, focusY: number, reach: number): boolean =>
  Math.hypot(x - focusX, y - focusY) < reach;

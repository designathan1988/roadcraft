import { Box3, type BufferAttribute, type BufferGeometry, type Frustum, type Mesh } from 'three';
import { geometryCost } from '../gpuLedger';
import { fillArrays } from './gpuOnly';
import { type BlockLevels, levelsOf } from './roadLod';

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
 * THE ROADS' NEAR LEVEL UNDER A BUDGET (`quality.ts` GEOMETRY_BUDGETS roadsNearMB): a block's far level stays for good (`attachFarLevel`,
 * 0.12 m off the full one), its full level only while it is wanted and the budget holds it. Wanted: within the reach and meeting the
 * view's frustum (Cesium's traversal visits only the tiles in the frustum); past the budget, the near blocks out of the view go first,
 * the least recently seen first (3DTilesRendererJS `lruCache`), then the farthest in it - never a hole, its far level stands. A block is
 * brought near only where its bytes fit (as last measured, or its far level's times `NEAR_PER_FAR` before it ever was near).
 */
export interface RoadResidency {
  /** The view's frustum (three's axes); null: every block is in view. */
  view?: Frustum | null;
  /** The most the full levels may hold, bytes. */
  budget?: number;
  /** The looks so far (`updateRoadLevels`): when each block last met the view (`BlockLevels.seenAt`). */
  looks?: number;
}
/** Bytes a block's full level holds for its far level's, before it was ever near. */
const NEAR_PER_FAR = 5;
/** How far round a block's box the view meets it, m: a block just past the edge is near before the eye pans onto it. */
const VIEW_MARGIN = 64;
/** The bytes a block's full level holds on the GPU (its arrays, or what they were once uploaded, `gpuOnly.ts`), kept as its last measure. */
function fullBytes(mesh: Mesh, levels: BlockLevels): number {
  const bytes = geometryCost(mesh.geometry as BufferGeometry).bytes;
  if (bytes > 0) levels.nearBytes = bytes;
  return bytes;
}

/** The levels brought up to the camera at (`focusX`, `focusY`) in world units, the near ones under `residency`'s budget; returns the blocks changed. */
export function updateRoadLevels(blocks: Iterable<Mesh>, focusX: number, focusY: number, reach: number, residency: RoadResidency = {}): number {
  let changed = 0;
  const look = residency.looks = (residency.looks ?? 0) + 1;
  const viewBox = new Box3();
  const view = residency.view ?? null;
  const budget = residency.budget ?? Infinity;
  const wanted: { mesh: Mesh; d: number }[] = [];
  const full: { mesh: Mesh; d: number; seen: boolean; bytes: number; at: number }[] = [];
  let total = 0;
  const farFrom = reach * FAR_MARGIN;
  for (const mesh of blocks) {
    const levels = levelsOf(mesh);
    if (!levels?.coarse) continue;
    const d = distance(levels, focusX, focusY);
    const box = mesh.geometry.boundingBox;
    const seen = !view || !box || view.intersectsBox(viewBox.copy(box).expandByScalar(VIEW_MARGIN));
    if (seen) levels.seenAt = look;
    if (levels.full) {
      if (d > farFrom) { makeFar(mesh); changed++; continue; }
      const bytes = fullBytes(mesh, levels);
      total += bytes;
      full.push({ mesh, d, seen, bytes, at: levels.seenAt ?? 0 });
    } else if (d < reach && seen && !levels.bringing) wanted.push({ mesh, d });
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
    brought++;
    changed++;
  }
  return changed;
}

/** Whether a block at (`x`, `y`) in world units is within `reach` of the camera: the level a block is made at. */
export const isNear = (x: number, y: number, focusX: number, focusY: number, reach: number): boolean =>
  Math.hypot(x - focusX, y - focusY) < reach;

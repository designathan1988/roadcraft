import type { BufferAttribute, BufferGeometry, Mesh } from 'three';
import { type BlockLevels, levelsOf } from './roadLod';

/**
 * WHICH LEVEL OF A BLOCK OF ROAD IS ON THE GPU (`roadLod.ts`): the block's own mesh
 * within `reach` of the camera, the coarse one beyond it. A block that goes far
 * gives its full mesh's buffers back (`BufferGeometry.dispose`), its arrays already
 * gone (`mesh/gpuOnly.ts`); one that comes near has its arrays made again from what
 * they were made from (`refillArrays`) and is sent again, the coarse one drawn
 * until it is. The blocks are asked about at a distance with a margin (hysteresis):
 * a camera standing on the line does not send a block back and forth.
 *
 * The road surfaces were every block at full detail, wherever the camera was: 1.04 GB of
 * a 2,560 m city's 1.56 GB of geometry, and a map of 10 km would not have fitted a card.
 * DO NOT keep a far block's full mesh: no pixel of it is resolved from there.
 */

/** A block goes far when it is this much farther than `reach`, so one near the line is not asked twice. */
export const FAR_MARGIN = 1.25;
/** Blocks brought near in one look: each is made again from its tiles, a few milliseconds. */
const BRING_PER_LOOK = 3;

/** The block's distance to the camera in the ground plane, scene units (x, z = -y). */
const distance = (levels: BlockLevels, focusX: number, focusY: number): number =>
  Math.hypot(levels.x - focusX, levels.z + focusY);

/** The arrays of a mesh's attributes and index let go (made again by `refillArrays`). */
function giveBackArrays(mesh: Mesh): void {
  const geometry = mesh.geometry as BufferGeometry;
  const letGo = (attribute: BufferAttribute): void => { (attribute as unknown as { array: ArrayLike<number> | null }).array = null; };
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

/** The block's full mesh made again and shown; the coarse one is hidden. */
export function makeNear(mesh: Mesh): void {
  const levels = levelsOf(mesh);
  if (!levels?.coarse || levels.full) return;
  const refill = mesh.userData.refillArrays as (() => void) | undefined;
  if (!refill) return;
  refill();
  levels.full = true;
  mesh.visible = true;
  levels.coarse.visible = false;
}

/**
 * The levels brought up to the camera at (`focusX`, `focusY`) in world units: blocks beyond `reach` times
 * the margin go far, those within `reach` come near - nearest first, `BRING_PER_LOOK` of them. Returns
 * how many blocks changed level.
 */
export function updateRoadLevels(blocks: Iterable<Mesh>, focusX: number, focusY: number, reach: number): number {
  let changed = 0;
  const wanted: { mesh: Mesh; d: number }[] = [];
  const farFrom = reach * FAR_MARGIN;
  for (const mesh of blocks) {
    const levels = levelsOf(mesh);
    if (!levels?.coarse) continue;
    const d = distance(levels, focusX, focusY);
    if (levels.full) {
      if (d > farFrom) { makeFar(mesh); changed++; }
    } else if (d < reach) wanted.push({ mesh, d });
  }
  wanted.sort((a, b) => a.d - b.d);
  for (const { mesh } of wanted.slice(0, BRING_PER_LOOK)) { makeNear(mesh); changed++; }
  return changed;
}

/** Whether a block at (`x`, `y`) in world units is within `reach` of the camera: the level a block is made at. */
export const isNear = (x: number, y: number, focusX: number, focusY: number, reach: number): boolean =>
  Math.hypot(x - focusX, y - focusY) < reach;

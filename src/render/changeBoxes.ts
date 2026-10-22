import { Box3, Vector3 } from 'three';
import { m } from '@world/units';

/** THE BOXES OF WHAT CHANGED, KEPT APART: a cell coming in ahead of the view and a plant going behind it are two small boxes, not one over the whole square (the sun's cascades draw their stores again under each box alone, `sunCascades.ts` patches; one union covered more than half the near cascades' maps in 184 of 122 passes of a street pan, 2026-10-22). */

/** Boxes within this much of each other are one. */
const TOUCH = m(16);
/** The most boxes a list holds: past it a box joins the nearest. */
const MOST = 16;

const touching = new Box3();
const centre = new Vector3();
const other = new Vector3();

/** `box` joined into `list`: into the first box it touches, else as one more, else (the list full) into the nearest by centre. The list owns its boxes (`box` is copied). */
export function addChangeBox(list: Box3[], box: Box3, pool: Box3[] = []): void {
  for (const kept of list) {
    touching.copy(kept).expandByScalar(TOUCH);
    if (touching.intersectsBox(box)) { kept.union(box); return; }
  }
  if (list.length < MOST) {
    const fresh = pool.pop() ?? new Box3();
    fresh.copy(box);
    list.push(fresh);
    return;
  }
  box.getCenter(centre);
  let nearest = list[0]!, least = Infinity;
  for (const kept of list) {
    const d = kept.getCenter(other).distanceToSquared(centre);
    if (d < least) { least = d; nearest = kept; }
  }
  nearest.union(box);
}

/** A list's boxes given back to `pool`, the list emptied. */
export function clearChangeBoxes(list: Box3[], pool: Box3[]): void {
  for (const box of list) pool.push(box);
  list.length = 0;
}

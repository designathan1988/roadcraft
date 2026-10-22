import { Box3, Vector3 } from 'three';
import { m } from '@world/units';

/** THE BOXES OF WHAT CHANGED, KEPT APART: a cell coming in ahead of the view and a plant going behind it are two small boxes, not one over the whole square (the sun's cascades draw their stores again under each box alone, `sunCascades.ts` patches; one union covered more than half the near cascades' maps in 184 of 122 passes of a street pan, 2026-10-22). */

/** Boxes within this much of each other are one. */
const TOUCH = m(16);
/** The most boxes a list holds: past it a box joins the nearest. DO NOT keep it at 16: a move's props, posts and plants coming and going
 *  round the cascades were joined into boxes of 2-3 km reaching over the near cascade, whose store was then thrown away (`tooBig` in 462
 *  of 601 passes, `npm run diagnose`, 2026-10-22). Each cascade takes the boxes cut to its own square (`sunCascades.ts` rectsOf): the
 *  ones past it cost nothing there. */
const MOST = 128;
/** A layer's own list (a mesh's `castBoxes`, read and emptied by the renderer each pass): its changes are near each other, kept smaller. */
export const LAYER_BOXES = 32;

/** A box of what changed and the widest cascade texel the change shows in, world units (`reach`): a caster drawn into a cascade only where
 *  it spans enough of its texels (`shadowCasters.ts` castBySize) changes nothing in a cascade of coarser texels (`sunCascades.ts` rectsOf).
 *  None: every cascade. */
export type ChangeBox = Box3 & { reach?: number };

const touching = new Box3();
const joined = new Box3();
const centre = new Vector3();
const other = new Vector3();

/** `box` joined into `list`: into the first box it touches, else as one more, else (the list full) into the nearest by centre on its own
 *  side of `near` (the near cascade's cover, `environment.shadowCover`): one under it joins one under it, one past it one past it. DO NOT join
 *  across: a move's props changing level in a ring round the camera, past the near cascade on both sides, were joined into boxes of 3 km
 *  over it (`hydrants 3048`, `street-bins 2903`) and its store thrown away in 268 of 332 passes (`npm run diagnose`, 2026-10-22). The list
 *  owns its boxes (`box` is copied). */
export function addChangeBox(list: ChangeBox[], box: Box3, pool: Box3[] = [], most = MOST, near: Box3 | null = null, reach = (box as ChangeBox).reach ?? Infinity): void {
  for (const kept of list) {
    touching.copy(kept).expandByScalar(TOUCH);
    if (touching.intersectsBox(box)) { kept.union(box); kept.reach = Math.max(kept.reach ?? Infinity, reach); return; }
  }
  if (list.length < most) {
    const fresh: ChangeBox = pool.pop() ?? new Box3();
    fresh.copy(box);
    fresh.reach = reach;
    list.push(fresh);
    return;
  }
  box.getCenter(centre);
  const under = near !== null && near.intersectsBox(box);
  let nearest: Box3 | null = null, least = Infinity;
  for (const kept of list) {
    if (near !== null && near.intersectsBox(kept) !== under) continue;
    // One past it joined only where the two together stay past it: DO NOT let two boxes either side of the near cascade make one over it.
    if (near !== null && !under && near.intersectsBox(joined.copy(kept).union(box))) continue;
    const d = kept.getCenter(other).distanceToSquared(centre);
    if (d < least) { least = d; nearest = kept; }
  }
  // None on its side (every box on the other): one more past the cap, the next of its side joining it.
  if (nearest === null) { const fresh: ChangeBox = (pool.pop() ?? new Box3()).copy(box); fresh.reach = reach; list.push(fresh); return; }
  nearest.union(box);
  (nearest as ChangeBox).reach = Math.max((nearest as ChangeBox).reach ?? Infinity, reach);
}

/** A list's boxes given back to `pool`, the list emptied. */
export function clearChangeBoxes(list: Box3[], pool: Box3[]): void {
  for (const box of list) pool.push(box);
  list.length = 0;
}

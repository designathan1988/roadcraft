import { EPS, planOverlap, volumeElevation, volumeLift } from '@world/buildings/geometry';
import { type Building, type Volume, volumeTop } from '@world/buildings/types';

/** Pairs of volumes that would stand in the same space: overlapping in plan and in levels. */
export function clashes(b: Building): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < b.volumes.length; i++) {
    const a = b.volumes[i] as Volume;
    for (let j = i + 1; j < b.volumes.length; j++) {
      const c = b.volumes[j] as Volume;
      // By height: two blocks on the same levels at floors of their own (a block under another's lifted floor) do not meet.
      const meet = Math.abs(volumeLift(a) - volumeLift(c)) < EPS
        ? a.base < volumeTop(c) && c.base < volumeTop(a)
        : volumeElevation(b, a, a.base) < volumeElevation(b, c, volumeTop(c)) - EPS &&
          volumeElevation(b, c, c.base) < volumeElevation(b, a, volumeTop(a)) - EPS;
      if (meet && planOverlap(a, c)) out.push([a.id, c.id]);
    }
  }
  return out;
}

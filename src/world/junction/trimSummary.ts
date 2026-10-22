import type { SegmentId } from '../ids';
import { Level } from '../roadTypes';
import type { JunctionLevels } from './levels';

/* What the network's build reconciles a road's ends from, of each junction it keeps (`networkBuild.ts` MemoEntry). */

/** A summary's numbers a road (`trimSummary`): the road, its greatest trim at each level (NaN: no leg there; at the level's own index), the floor of its mouth (0: none). */
export const SUMMARY = 6, SUMMARY_FLOOR = 5;

/**
 * What `reconcileSegment` reads of a node's junction, by road: each level's greatest trim of the road's legs (at least 0), and the part
 * of its mouth no length budget may take (where two carriageways still overlap: the greatest reach along the road of a sharp corner's point).
 */
export function trimSummary(levels: JunctionLevels): number[] {
  const out: number[] = [];
  const slot = (seg: SegmentId): number => {
    for (let k = 0; k < out.length; k += SUMMARY) if (out[k] === seg) return k;
    out.push(seg, NaN, NaN, NaN, NaN, 0);
    return out.length - SUMMARY;
  };
  levels.forEachTrim((level, seg, trim) => {
    const k = slot(seg) + level;
    out[k] = Math.max(Number.isNaN(out[k]!) ? 0 : out[k]!, trim);
  });
  const junction = levels.get(Level.Asphalt);
  if (junction && !junction.transition) {
    for (const corner of junction.corners) {
      const x = corner.x;
      if (!x || corner.psi >= Math.PI / 2) continue;
      for (const index of [corner.i, corner.j]) {
        const leg = junction.legs[index];
        if (!leg) continue;
        const along = (x.x - leg.origin.x) * leg.dir.x + (x.y - leg.origin.y) * leg.dir.y;
        if (!(along > 0)) continue;
        const k = slot(leg.seg) + SUMMARY_FLOOR;
        out[k] = Math.max(out[k]!, along);
      }
    }
  }
  return out;
}

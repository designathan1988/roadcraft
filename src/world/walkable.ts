import { RegionIndex } from '@core/regionIndex';
import type { Vec2 } from '@core/vec2';
import type { Network } from './network';
import type { ChangeRect } from './changes';
import { CELL, cellAt, cellRect } from './cells';
import type { NodeId } from './ids';
import type { Junction } from './junction/build';
import { Level, type SurfaceLevel } from './roadTypes';
import { levelRingsOf } from './surfaces';

/**
 * The ground a pedestrian may stand on: the footway and its kerb, and never
 * the carriageway or the verge beyond.
 *
 * It is the same outline the road mesh draws (`world/surfaces.ts`), read as
 * rings and answered point by point through a `RegionIndex`: inside the
 * footway level, and outside the carriageway. No clipper union is needed —
 * the rings are combined by winding number.
 *
 * BY CELL OF THE WORLD'S GRID (`cells.ts`): a cell's index is made, when a
 * point in it is first asked about, from the rings of the ribbons and
 * junctions filed over it (`Network.segmentCells`, `junctionCells`), each cut
 * to the cell (a ring cut to a box holds the same points inside the box), and
 * made again only when the versions of those filings over the cell moved. An
 * edit pays for the cells it reaches and that are asked about again.
 * DO NOT go back to one index of every ring of the map made at each network
 * rebuild: every road edit paid for the whole map's footways before the first
 * crossing was placed (`Network.crosswalkDistanceAt`).
 *
 * One per network, kept across its rebuilds and through `Network.adopt`:
 * a cell's version names one change of it, never another filing's
 * (`cells.ts` versionClock), so a cell made before reads as current only
 * when nothing filed over it moved.
 */
export class WalkableSurface {
  private readonly made = new Map<number, { readonly stamp: string; readonly outer: RegionIndex; readonly road: RegionIndex }>();

  constructor(private readonly net: Network) {}

  /** Cells of the grids made so far, for the performance budgets (`core/perfBudget.ts`). */
  get cells(): number {
    let n = 0;
    for (const cell of this.made.values()) n += cell.outer.cellCount + cell.road.cellCount;
    return n;
  }

  /** On the footway or its kerb. */
  footway(x: number, y: number): boolean {
    const cell = this.cellOf(x, y);
    return cell.outer.contains(x, y) && !cell.road.contains(x, y);
  }

  /** On the carriageway. */
  carriageway(x: number, y: number): boolean {
    return this.cellOf(x, y).road.contains(x, y);
  }

  private cellOf(x: number, y: number): { readonly outer: RegionIndex; readonly road: RegionIndex } {
    const key = cellAt(x, y);
    const [x0, y0, x1, y1] = cellRect(key);
    // The cell itself, its far edges left out: a point there is the next cell's.
    const area: ChangeRect = [x0, y0, x1 - CELL * 1e-9, y1 - CELL * 1e-9];
    const net = this.net;
    const stamp = `${net.segmentCells.stamp(area)}|${net.junctionCells.stamp(area)}`;
    const known = this.made.get(key);
    if (known && known.stamp === stamp) return known;
    const ribbons = net.ribbonsMeeting(area);
    const junctions: [NodeId, ReadonlyMap<SurfaceLevel, Junction>][] = [];
    for (const id of net.junctionCells.idsMeeting(area)) {
      const byLevel = net.junctions.get(id);
      if (byLevel) junctions.push([id, byLevel]);
    }
    // Cut a little beyond the cell, so no edge of the cut lies on its border.
    const box: ChangeRect = [x0 - 1, y0 - 1, x1 + 1, y1 + 1];
    const ringsOf = (level: SurfaceLevel): Vec2[][] => {
      const out: Vec2[][] = [];
      for (const polygon of levelRingsOf(net, level, ribbons, junctions)) {
        for (const ring of polygon) {
          const cut = clipToBox(ring.map((p) => ({ x: p[0] as number, y: p[1] as number })), box);
          if (cut.length >= 3) out.push(cut);
        }
      }
      return out;
    };
    const cell = {
      stamp,
      outer: RegionIndex.fromRings(ringsOf(Level.Sidewalk), 'nonzero'),
      road: RegionIndex.fromRings(ringsOf(Level.Asphalt), 'nonzero'),
    };
    this.made.set(key, cell);
    return cell;
  }
}

/**
 * A ring cut to an axis-aligned box (Sutherland and Hodgman, "Reentrant
 * polygon clipping", 1974: one half-plane at a time). For any simple ring,
 * convex or not, the part inside the box is the same region, wound the same
 * way, so the winding number of every point in the box is unchanged.
 */
function clipToBox(ring: readonly Vec2[], box: ChangeRect): Vec2[] {
  let pts: Vec2[] = ring.slice();
  const sides: readonly ((p: Vec2) => number)[] = [
    (p) => p.x - box[0], (p) => box[2] - p.x, (p) => p.y - box[1], (p) => box[3] - p.y,
  ];
  for (const side of sides) {
    if (pts.length === 0) break;
    const out: Vec2[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!, q = pts[(i + 1) % pts.length]!;
      const sp = side(p), sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      }
    }
    pts = out;
  }
  return pts;
}

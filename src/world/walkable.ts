import { RegionIndex } from '@core/regionIndex';
import type { Vec2 } from '@core/vec2';
import type { Network } from './network';
import type { ChangeRect } from './changes';
import { CELL, cellAt, cellRect } from './cells';
import type { NodeId } from './ids';
import type { Junction } from './junction/build';
import { Level, type SurfaceLevel } from './roadTypes';
import { levelRingsOf } from './surfaces';

/** DO NOT go back to one index of every ring of the map made at each network rebuild */
export class WalkableSurface {
  private readonly made = new Map<number, { readonly stamp: string; readonly outer: RegionIndex; readonly road: RegionIndex }>();
  /** The network's state the cells kept were checked against (`forgetChanged`). */
  private seen: object | null = null;

  constructor(private readonly net: Network) {}

  /** DO NOT keep a cell's rings after its roads changed or went (a tile let go): its stamp would not match again, and the grids of every cell the walkers ever crossed stayed in the worker. The cells the network's changes since the last look reach let go. */
  private forgetChanged(): void {
    const net = this.net;
    if (this.seen === net.state) return;
    const delta = this.seen === null ? null : net.changesSince(this.seen);
    this.seen = net.state;
    if (delta === null) { this.made.clear(); return; }
    if (!delta.rects.length) return;
    for (const key of [...this.made.keys()]) {
      const [x0, y0, x1, y1] = cellRect(key);
      if (delta.rects.some((r) => r[0] <= x1 && r[2] >= x0 && r[1] <= y1 && r[3] >= y0)) this.made.delete(key);
    }
  }

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
    this.forgetChanged();
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

/** A ring cut to an axis-aligned box */
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

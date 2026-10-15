import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from './doc';
import type { SegmentId } from './ids';
import type { Network } from './network';
import { carriesPedestrians } from './pedestrianAccess';
import { Level, halfWidth } from './roadTypes';
import { m } from './units';
import { GRID_CELL } from './grid';
import { onFootway, onKerbed } from './poleLines';

/**
 * The zoning grid: the land along every street, cut into cells the player
 * zones and buildings grow on.
 *
 * As in Cities: Skylines, a street makes its own grid: cells of 10 x 10 m
 * (one cell of the universal grid, `grid.ts`), in
 * columns along each side of the road from the back of the footway, up to
 * `ZONE_DEPTH` cells deep, following the road round its curves. Nothing about
 * the grid is stored: it is derived from the roads, so it moves with them. What
 * the player paints is stored by place (`ZoneMark`, `world/zones.ts`) and
 * found again by the cell that stands there.
 *
 * The first version zoned a rectangle aligned with the map's axes: under the
 * isometric camera a square drag became a sliver crossing the road, and the
 * buildings it made all at once overlapped each other.
 */

export const ZONE_CELL = GRID_CELL;
export const ZONE_DEPTH = 4;
/** The subgrid a cell is trimmed on where a whole cell does not fit (1 m). */
const SUB_CELL = m(1);

export interface ZoneCell {
  /** Stable while the road does not change: segment, side, column, row. */
  readonly id: string;
  readonly segment: SegmentId;
  /** +1 left of the segment's a -> b direction, -1 right. */
  readonly side: 1 | -1;
  readonly column: number;
  readonly row: number;
  /** Corners in order: front-start, front-end, back-end, back-start. */
  readonly corners: readonly [Vec2, Vec2, Vec2, Vec2];
  readonly centre: Vec2;
  /** The middle of the cell's front edge, toward the road. */
  readonly front: Vec2;
  /** Rotation a building on this cell is placed with (`placeBuilding`): it faces the road. */
  readonly rotation: number;
  /** Width along the street: `ZONE_CELL`, or less for a cell trimmed on the 1 m subgrid. */
  readonly width: number;
}

export interface ZoneGrid {
  readonly cells: readonly ZoneCell[];
  readonly byId: ReadonlyMap<string, ZoneCell>;
  /** Cell at (segment, side, column, row), or undefined where the grid has none. */
  at(segment: SegmentId, side: 1 | -1, column: number, row: number): ZoneCell | undefined;
  /** The cell whose quad holds a world point. */
  cellAt(p: Vec2): ZoneCell | undefined;
  /** Cells whose centre lies within `radius` of a point. */
  cellsNear(p: Vec2, radius: number): ZoneCell[];
}

const key = (segment: SegmentId, side: number, column: number, row: number): string =>
  `${segment}:${side}:${column}:${row}`;

/** Spatial hash bucket edge: one cell. */
const BUCKET = ZONE_CELL;
const bucketKey = (x: number, y: number): string => `${Math.floor(x / BUCKET)},${Math.floor(y / BUCKET)}`;

function insideQuad(p: Vec2, q: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const a = q[i] as Vec2, b = q[j] as Vec2;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** How far two cells may run into each other and still count as apart: rounding, and cells that only share an edge. */
const OVERLAP_SLACK = m(0.25);

/**
 * Whether two quads overlap by more than `slack`, by the separating-axis
 * test: they are apart when, along the normal of some edge of either, their
 * projections overlap by `slack` or less. Exact for convex quads, which a
 * cell is (a cell on the inside of a bend tighter than its depth would not
 * be, and it is then judged by its edges' normals all the same).
 */
export function quadsOverlap(a: readonly Vec2[], b: readonly Vec2[], slack: number): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      if (len < 1e-9) continue;
      const nx = -(q.y - p.y) / len, ny = (q.x - p.x) / len;
      let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
      for (const v of a) { const d = v.x * nx + v.y * ny; aMin = Math.min(aMin, d); aMax = Math.max(aMax, d); }
      for (const v of b) { const d = v.x * nx + v.y * ny; bMin = Math.min(bMin, d); bMax = Math.max(bMax, d); }
      if (Math.min(aMax, bMax) - Math.max(aMin, bMin) <= slack) return false;
    }
  }
  return true;
}

/** Builds the grid of every ground street that carries pedestrians. */
/**
 * What land may not be built on: any ground road's carriageway and footway
 * (`onRoad`, by the street's reach), and the paving as drawn - kerbs,
 * footways and every junction's corners (`onPlate`). Shared by the zone grid
 * and the lots (`lots.ts`).
 */
export function pavedTester(doc: RoadDoc, net: Network): { onRoad: (p: Vec2) => boolean; onPlate: (p: Vec2) => boolean } {
  // What a cell may not sit on: any road's carriageway and footway, at ground,
  // read from the network's cells round the point (`Network.segmentCells`: a
  // ribbon is filed over its casing, past its footway). DO NOT bucket every
  // ribbon of the map for each tester: every zone stroke and lot plan paid
  // for the whole map first.
  const onRoad = (p: Vec2): boolean => {
    for (const id of net.segmentCells.idsMeeting([p.x, p.y, p.x, p.y])) {
      const ribbon = net.ribbons.get(id);
      if (!ribbon || doc.segment(id)?.structure !== 'ground') continue;
      const reach = halfWidth(ribbon.road, Level.Sidewalk);
      const bb = ribbon.full.bbox;
      if (p.x < bb.minX - reach || p.x > bb.maxX + reach || p.y < bb.minY - reach || p.y > bb.maxY + reach) continue;
      if (ribbon.full.distanceTo(p) < reach - m(0.05)) return true;
    }
    return false;
  };
  // The paving as drawn - carriageways, kerbs, footways and every junction's
  // corners - so a cell comes right up to the footway's back edge and round
  // the corner of the block. A disc round each junction (as wide as its
  // widest mouth) used to stand in for the junction, and took a bite out of
  // every block corner: the zones stopped short of the corners, broken.
  // Read from the cells round each point (`poleLinesAt`), not the whole map's lines.
  const onPlate = (p: Vec2): boolean => onFootway(net, p) || onKerbed(net, p);
  return { onRoad, onPlate };
}

export function buildZoneGrid(doc: RoadDoc, net: Network): ZoneGrid {
  const steps = zoneGridSteps(doc, net);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/**
 * `buildZoneGrid` a street at a time: it yields after each street, so the
 * grid can be laid over several frames (the overlay keeps the last one until
 * this is done) instead of in one stall after every road edit. The answer is
 * the same grid; the document and the network must not change meanwhile.
 */
function* zoneGridSteps(doc: RoadDoc, net: Network): Generator<void, ZoneGrid> {
  const { onRoad, onPlate } = pavedTester(doc, net);
  const cells: ZoneCell[] = [];
  const byId = new Map<string, ZoneCell>();
  const buckets = new Map<string, ZoneCell[]>();
  /**
   * Whether a cell would overlap one already laid by more than a sliver.
   * The test is a separating-axis one on the two quads: the corner-inside
   * test it replaces missed two cells that cross without either holding a
   * corner of the other (a curved street's grid over a straight one's), and
   * the grids of neighbouring streets were drawn over each other.
   */
  const taken = (centre: Vec2, corners: readonly Vec2[]): boolean => {
    const bx = Math.floor(centre.x / BUCKET), by = Math.floor(centre.y / BUCKET);
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
      for (const other of buckets.get(`${bx + dx},${by + dy}`) ?? []) {
        if (Math.hypot(other.centre.x - centre.x, other.centre.y - centre.y) > ZONE_CELL * 2) continue;
        if (quadsOverlap(corners, other.corners, OVERLAP_SLACK)) return true;
      }
    }
    return false;
  };

  // Each street's columns and the cell maker for them, first; the cells are
  // then laid a row at a time across every street (below).
  interface Street {
    readonly spans: readonly { column: number; sa: number; sb: number }[];
    readonly cellOver: (side: 1 | -1, column: number, row: number, sa: number, sb: number) => ZoneCell | null;
  }
  const streets: { id: SegmentId; street: Street }[] = [];
  const ids = [...doc.segments.keys()].sort((a, b) => a - b);
  for (const segId of ids) {
    const seg = doc.requireSegment(segId);
    const ribbon = net.ribbons.get(segId);
    if (!ribbon || seg.structure !== 'ground' || !carriesPedestrians(ribbon.road)) continue;
    const line = ribbon.full;
    const length = line.length;
    // Columns along the whole street, centred on it; those that reach into a
    // junction are refused cell by cell against the paving, so the grid runs
    // up to the corner of each block instead of stopping at the mouth.
    const columns = Math.floor(length / ZONE_CELL);
    if (columns < 1) continue;
    const s0 = (length - columns * ZONE_CELL) / 2;
    const face = halfWidth(ribbon.road, Level.Sidewalk);
    const frame = (s: number) => {
      const f = line.sampleAt(Math.max(0, Math.min(length, s)));
      return { p: f.p, t: f.t };
    };
    /** The cell over [sa, sb] along the street at `row`, or null where it cannot be land. */
    const cellOver = (side: 1 | -1, column: number, row: number, sa: number, sb: number): ZoneCell | null => {
      const a = frame(sa), b = frame(sb), mid = frame((sa + sb) / 2);
      const na = { x: -a.t.y * side, y: a.t.x * side };
      const nb = { x: -b.t.y * side, y: b.t.x * side };
      const nm = { x: -mid.t.y * side, y: mid.t.x * side };
      const d0 = face + row * ZONE_CELL, d1 = d0 + ZONE_CELL;
      const corners: [Vec2, Vec2, Vec2, Vec2] = [
        { x: a.p.x + na.x * d0, y: a.p.y + na.y * d0 },
        { x: b.p.x + nb.x * d0, y: b.p.y + nb.y * d0 },
        { x: b.p.x + nb.x * d1, y: b.p.y + nb.y * d1 },
        { x: a.p.x + na.x * d1, y: a.p.y + na.y * d1 },
      ];
      const centre = { x: mid.p.x + nm.x * (d0 + d1) / 2, y: mid.p.y + nm.y * (d0 + d1) / 2 };
      const edgeMids = corners.map((corner, i) => {
        const next = corners[(i + 1) % 4]!;
        return { x: (corner.x + next.x) / 2, y: (corner.y + next.y) / 2 };
      });
      // Tested a tenth of the way in, so a cell whose edge lies along the
      // paving's edge (as the front row's does) is not refused for it.
      const inset = (q: Vec2): Vec2 => ({ x: q.x + (centre.x - q.x) * 0.1, y: q.y + (centre.y - q.y) * 0.1 });
      if (onRoad(centre) || corners.map(inset).some(onRoad) || onPlate(centre) ||
        [...corners, ...edgeMids].some((q) => onPlate(inset(q))) || taken(centre, corners)) return null;
      const front = { x: mid.p.x + nm.x * d0, y: mid.p.y + nm.y * d0 };
      return {
        id: key(segId, side, column, row), segment: segId, side, column, row,
        corners, centre, front, rotation: Math.atan2(mid.t.y, mid.t.x) + (side === 1 ? 0 : Math.PI),
        width: sb - sa,
      };
    };
    // The regular 10 m columns, then a partial column at each end of the
    // street for what is left before the junction.
    const spans: { column: number; sa: number; sb: number }[] = [];
    for (let c = 0; c < columns; c++) spans.push({ column: c, sa: s0 + c * ZONE_CELL, sb: s0 + (c + 1) * ZONE_CELL });
    if (s0 >= SUB_CELL) spans.unshift({ column: -1, sa: 0, sb: s0 });
    if (length - (s0 + columns * ZONE_CELL) >= SUB_CELL) spans.push({ column: columns, sa: s0 + columns * ZONE_CELL, sb: length });
    streets.push({ id: segId, street: { spans, cellOver } });
  }

  const lay = (cell: ZoneCell): void => {
    cells.push(cell);
    byId.set(cell.id, cell);
    const k = bucketKey(cell.centre.x, cell.centre.y);
    let bucket = buckets.get(k);
    if (!bucket) buckets.set(k, bucket = []);
    bucket.push(cell);
  };
  // Where two streets' grids would cover the same land, the cell nearer its
  // own street keeps it, and between cells as near, the older street's (the
  // lower id) - the rule of Cities: Skylines' zone blocks. So the grid is laid
  // a row at a time across the whole town: every street's front row, then
  // every street's second row, and so on. Laid a street at a time, the first
  // street took its whole depth and the land between two parallel streets
  // went to whichever was drawn first, its back rows over the other's front.
  for (let row = 0; row < ZONE_DEPTH; row++) {
    for (const { id: segId, street } of streets) {
      const { spans, cellOver } = street;
      for (const side of [1, -1] as const) {
        for (const { column, sa, sb } of spans) {
          // A column stops at its first refused cell: a deeper row with the
          // front one missing would float away from the street.
          if (row > 0 && !byId.has(key(segId, side, column, row - 1))) continue;
          // A cell that does not fit whole is trimmed on the 1 m subgrid, from
          // whichever end is in the way, down to a single metre: the grid then
          // reaches the footway and the corner of the block with no gap.
          let cell = cellOver(side, column, row, sa, sb);
          for (let k = 1; !cell && sb - sa - k * SUB_CELL >= SUB_CELL - 1e-6; k++) {
            cell = cellOver(side, column, row, sa + k * SUB_CELL, sb) ?? cellOver(side, column, row, sa, sb - k * SUB_CELL);
          }
          if (cell) lay(cell);
        }
      }
      yield;
    }
  }

  return {
    cells,
    byId,
    at: (segment, side, column, row) => byId.get(key(segment, side, column, row)),
    cellAt(p) {
      const bx = Math.floor(p.x / BUCKET), by = Math.floor(p.y / BUCKET);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const cell of buckets.get(`${bx + dx},${by + dy}`) ?? []) if (insideQuad(p, cell.corners)) return cell;
      }
      return undefined;
    },
    cellsNear(p, radius) {
      const out: ZoneCell[] = [];
      const span = Math.ceil(radius / BUCKET) + 1;
      const bx = Math.floor(p.x / BUCKET), by = Math.floor(p.y / BUCKET);
      for (let dx = -span; dx <= span; dx++) for (let dy = -span; dy <= span; dy++) {
        for (const cell of buckets.get(`${bx + dx},${by + dy}`) ?? []) {
          if (Math.hypot(cell.centre.x - p.x, cell.centre.y - p.y) <= radius) out.push(cell);
        }
      }
      return out;
    },
  };
}

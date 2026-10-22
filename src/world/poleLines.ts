import { EndType, FillRule, JoinType, inflatePathsD, unionD, type PathsD } from 'clipper2-ts';

import { Polyline } from '@core/polyline';
import { EPS } from '@core/scalar';
import type { MultiPoly } from '@core/clipper';
import type { Vec2 } from '@core/vec2';
import type { Network } from './network';
import { carriesPedestrians } from './pedestrianAccess';
import { LAMP_ZONE } from './section';
import { crossingAccesses, crossingAccessesAt, type CrossingAccess } from './landscape';
import { levelPolygons, levelRingsOf } from './surfaces';
import { CLIPPER_SCALE, union } from '@core/clipper';
import { Level, type SurfaceLevel } from './roadTypes';
import type { NodeId, SegmentId } from './ids';
import { deckOf } from './walkways';
import { m } from './units';
import type { ChangeRect } from './changes';
import { cellAt, cellRect, grow } from './cells';
import { NEAR, PAVED, firstTrue, gridRect, type RasterGrid } from './rasterGrid';
import type { Junction } from './junction/build';
import type { SegmentRibbon } from './network';

/** The line wire poles stand on, and the kerb they stand behind. */

/** How far behind the kerb stone the pole line runs: the middle of the lamp zone. */
export const POLE_KERB_INSET = LAMP_ZONE / 2;

export interface PoleLines {
  /** Closed contours, first point repeated at the end. */
  readonly contours: readonly Polyline[];
  /** The ground footways: paving out to the outer edge, and the kerbed carriageway inside it. */
  readonly paving: MultiPoly;
  readonly kerbed: MultiPoly;
  readonly accesses: readonly CrossingAccess[];
  /** The contours' edges filed by place (`nearestOnContour`). */
  readonly edges: ContourEdges;
}

/** The edges of a set of contours filed by place: each edge (contour, index) in every bucket its bounds reach. */
interface ContourEdges { readonly buckets: ReadonlyMap<number, readonly number[]> }
/** Bucket edge of the contour index, world units: about the reach of the questions asked of it. */
const EDGE_BUCKET = m(8);
const edgeBucket = (bx: number, by: number): number => (bx + 1048576) * 2097152 + (by + 1048576);

function contourEdges(contours: readonly Polyline[]): ContourEdges {
  const buckets = new Map<number, number[]>();
  contours.forEach((line, contour) => {
    const xy = line.xy;
    for (let i = 0; i + 1 < line.n; i++) {
      const ax = xy[i * 2]!, ay = xy[i * 2 + 1]!, bx = xy[i * 2 + 2]!, by = xy[i * 2 + 3]!;
      for (let cx = Math.floor(Math.min(ax, bx) / EDGE_BUCKET); cx <= Math.floor(Math.max(ax, bx) / EDGE_BUCKET); cx++) {
        for (let cy = Math.floor(Math.min(ay, by) / EDGE_BUCKET); cy <= Math.floor(Math.max(ay, by) / EDGE_BUCKET); cy++) {
          const key = edgeBucket(cx, cy);
          const list = buckets.get(key);
          if (list) list.push(contour, i); else buckets.set(key, [contour, i]);
        }
      }
    }
  });
  return { buckets };
}

/** A place on a contour. */
export interface OnContour {
  readonly contour: number;
  readonly s: number;
  readonly at: Vec2;
  readonly distance: number;
}

/** DO NOT go back to scanning the contours: the question is local. */
export function nearestOnContour(lines: PoleLines, at: Vec2, reach: number): OnContour | null {
  const { buckets } = lines.edges;
  const px = at.x, py = at.y;
  // Per contour: the least squared distance found, the first edge giving it, and its parameter.
  const bestOf = new Map<number, { distSq: number; edge: number; t: number }>();
  for (let cx = Math.floor((px - reach) / EDGE_BUCKET); cx <= Math.floor((px + reach) / EDGE_BUCKET); cx++) {
    for (let cy = Math.floor((py - reach) / EDGE_BUCKET); cy <= Math.floor((py + reach) / EDGE_BUCKET); cy++) {
      const list = buckets.get(edgeBucket(cx, cy));
      if (!list) continue;
      for (let k = 0; k < list.length; k += 2) {
        const contour = list[k]!, i = list[k + 1]!;
        const xy = lines.contours[contour]!.xy;
        // The arithmetic of `Polyline.nearestSegment`, in its order, so the answer is the same bit for bit.
        const ax = xy[i * 2]!, ay = xy[i * 2 + 1]!;
        const abx = xy[i * 2 + 2]! - ax, aby = xy[i * 2 + 3]! - ay;
        const l2 = abx * abx + aby * aby;
        let t = 0, qx = ax, qy = ay;
        if (l2 >= EPS) {
          t = ((px - ax) * abx + (py - ay) * aby) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          qx = ax + abx * t;
          qy = ay + aby * t;
        }
        const ex = px - qx, ey = py - qy;
        const distSq = ex * ex + ey * ey;
        const was = bestOf.get(contour);
        if (!was || distSq < was.distSq || (distSq === was.distSq && i < was.edge)) bestOf.set(contour, { distSq, edge: i, t });
      }
    }
  }
  let best: OnContour | null = null;
  for (const contour of [...bestOf.keys()].sort((a, b) => a - b)) {
    const { distSq, edge, t } = bestOf.get(contour)!;
    const distance = Math.sqrt(distSq);
    if (distance > reach || (best && !(distance < best.distance))) continue;
    const line = lines.contours[contour]!;
    const xy = line.xy, cum = line.cum;
    const ax = xy[edge * 2]!, ay = xy[edge * 2 + 1]!;
    best = {
      contour,
      s: cum[edge]! + t * (cum[edge + 1]! - cum[edge]!),
      at: { x: ax + (xy[edge * 2 + 2]! - ax) * t, y: ay + (xy[edge * 2 + 3]! - ay) * t },
      distance,
    };
  }
  return best;
}


/** The streets whose kerb lines carry poles: ground streets with footways (the two levels read; `surfaces` unions all four). */
function polesInclude(net: Network): (id: SegmentId) => boolean {
  return (id) => {
    if (deckOf(net.doc, id) !== 'ground') return false;
    const ribbon = net.ribbons.get(id);
    return !!ribbon && carriesPedestrians(ribbon.road) && ribbon.road.sidewalk > 0;
  };
}

/** The contours of the kerb line round the kerbed polygons. */
function contoursOf(kerbed: MultiPoly): Polyline[] {
  const paths: PathsD = [];
  for (const poly of kerbed) for (const ring of poly) paths.push(ring.map(([x, y]) => ({ x: x!, y: y! })));
  const contours: Polyline[] = [];
  if (paths.length) {
    const grown = inflatePathsD(unionD(paths, [], FillRule.NonZero, 3), POLE_KERB_INSET, JoinType.Round, EndType.Polygon, 2, 3, m(0.008));
    for (const ring of grown) if (ring.length >= 3) contours.push(Polyline.fromPoints([...ring, ring[0]!]));
  }
  return contours;
}

/** DO NOT keep it per network revision again: every road edit made it again for every street of the map */
export function poleLines(net: Network): PoleLines {
  const include = polesInclude(net);
  const kerbed = levelPolygons(net, Level.Curb, include);
  const paving = levelPolygons(net, Level.Sidewalk, include);
  const contours = contoursOf(kerbed);
  return { contours, paving, kerbed, accesses: crossingAccesses(net), edges: contourEdges(contours) };
}

/** How far round a place its pole lines are made from: the farthest any question about a point reaches */
const LINES_HALO = m(32);


/** What the regional pole lines did: made, kept, and the streets made from. A count for the budgets (`core/perfBudget.ts`). */
export const poleLinesWork = { made: 0, kept: 0, segments: 0 };

/** The versions of the cells a region's lines are made from (`LINES_HALO` round it): equal, nothing they read moved. */
function regionStamp(net: Network, rect: ChangeRect): string {
  const around = grow(rect, LINES_HALO);
  return `${net.segmentCells.stamp(around)}|${net.junctionCells.stamp(around)}`;
}

/** DO NOT go back to a ceiling that lets the least recently asked go (`REGIONAL_KEPT`, 64) */
export class PoleLineState {
  private readonly regions = new Map<string, { readonly rect: ChangeRect; readonly stamp: string; readonly lines: PoleLines }>();
  /** The cells' epochs the regions were last checked at (`stale`). */
  private checkedAt = '';
  /** The footway rings of each street and junction, by the object the network built for it (`localRings`). */
  readonly rings = new WeakMap<object, FootRings>();

  /** The lines of `rect`, kept or made now. */
  linesIn(net: Network, rect: ChangeRect): PoleLines {
    this.letGoStale(net);
    const key = `${rect[0]},${rect[1]},${rect[2]},${rect[3]}`;
    const known = this.regions.get(key);
    if (known) { poleLinesWork.kept++; return known.lines; }
    const lines = poleLinesOf(net, rect);
    this.regions.set(key, { rect, stamp: regionStamp(net, rect), lines });
    return lines;
  }

  /** @rebuild The regions some cell of whose moved since they were made, let go: once per edit of the network */
  private letGoStale(net: Network): void {
    const epochs = `${net.segmentCells.epoch},${net.junctionCells.epoch}`;
    if (epochs === this.checkedAt) return;
    this.checkedAt = epochs;
    for (const [key, region] of this.regions) if (regionStamp(net, region.rect) !== region.stamp) this.regions.delete(key);
  }
}

/** The network's pole line state, made when first asked. */
const stateOf = (net: Network): PoleLineState => (net.poleLines ??= new PoleLineState());

/** The pole lines inside `rect`: the same lines `poleLines` has there */
export function poleLinesIn(net: Network, rect: ChangeRect): PoleLines {
  return stateOf(net).linesIn(net, rect);
}


/** The pole lines inside `rect`, made now and not kept (`poleLinesIn` keeps them) */
export function poleLinesOf(net: Network, rect: ChangeRect): PoleLines {
  const around = grow(rect, LINES_HALO);
  const segments = net.segmentCells.idsMeeting(around), nodes = net.junctionCells.idsMeeting(around);
  const ribbons: SegmentRibbon[] = [];
  const ends = new Set<NodeId>();
  for (const id of segments) {
    const ribbon = net.ribbons.get(id);
    if (ribbon) ribbons.push(ribbon);
    const segment = net.doc.segment(id);
    if (segment) { ends.add(segment.a); ends.add(segment.b); }
  }
  const junctions: [NodeId, ReadonlyMap<SurfaceLevel, Junction>][] = [];
  for (const id of nodes) {
    const byLevel = net.junctions.get(id);
    if (byLevel) junctions.push([id, byLevel]);
  }
  const include = polesInclude(net);
  const kerbed = union(levelRingsOf(net, Level.Curb, ribbons, junctions, include));
  const paving = union(levelRingsOf(net, Level.Sidewalk, ribbons, junctions, include));
  const contours = contoursOf(kerbed);
  const lines: PoleLines = {
    contours, paving, kerbed, edges: contourEdges(contours),
    accesses: crossingAccessesAt(net, [...ends].sort((a, b) => a - b)),
  };
  poleLinesWork.made++;
  poleLinesWork.segments += ribbons.length;
  return lines;
}

/** The pole lines of the cell a point is in (`poleLinesIn`): right for any question reaching under `LINES_HALO - POLE_KERB_INSET` from it. */
export function poleLinesAt(net: Network, p: Vec2): PoleLines {
  return poleLinesIn(net, cellRect(cellAt(p.x, p.y)));
}

/** A ring as Clipper takes it in (`core/clipper.ts` `input`): its vertices on Clipper's grid */
interface WindingRing { readonly xy: Float64Array; readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }

function windingRings(polys: MultiPoly): WindingRing[] {
  const out: WindingRing[] = [];
  for (const poly of polys) {
    for (let k = 0; k < poly.length; k++) {
      const ring = poly[k]!;
      const pts: number[] = [];
      for (const pt of ring) {
        const x = Math.round(pt[0]! * CLIPPER_SCALE), y = Math.round(pt[1]! * CLIPPER_SCALE);
        const n = pts.length;
        if (n && pts[n - 2] === x && pts[n - 1] === y) continue;
        pts.push(x, y);
      }
      if (pts.length > 2 && pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1]) pts.length -= 2;
      if (pts.length < 6) continue;
      let area = 0;
      for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) area += pts[j]! * pts[i + 1]! - pts[i]! * pts[j + 1]!;
      // Positive for the outer ring, negative for a hole, whatever the order it was authored in.
      if ((area > 0) !== (k === 0)) {
        for (let a = 0, b = pts.length - 2; a < b; a += 2, b -= 2) {
          [pts[a], pts[b]] = [pts[b]!, pts[a]!];
          [pts[a + 1], pts[b + 1]] = [pts[b + 1]!, pts[a + 1]!];
        }
      }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < pts.length; i += 2) {
        x0 = Math.min(x0, pts[i]!); x1 = Math.max(x1, pts[i]!);
        y0 = Math.min(y0, pts[i + 1]!); y1 = Math.max(y1, pts[i + 1]!);
      }
      out.push({ xy: Float64Array.from(pts), x0, y0, x1, y1 });
    }
  }
  return out;
}

/** The winding number of a ring round a point, both in grid steps (Sunday's crossing rule: upward edges with the point on their left count +1, downward ones with it on their right -1). */
function windingOf(ring: WindingRing, x: number, y: number): number {
  const xy = ring.xy;
  let wn = 0;
  for (let i = 0, j = xy.length - 2; i < xy.length; j = i, i += 2) {
    const ax = xy[j]!, ay = xy[j + 1]!, bx = xy[i]!, by = xy[i + 1]!;
    if (ay <= y) {
      if (by > y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) > 0) wn++;
    } else if (by <= y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) < 0) wn--;
  }
  return wn;
}

/** The footway and kerb rings of a street or a junction (`NetworkLines.rings`): made again with the object the network builds for it. */
interface FootRings { readonly paving: WindingRing[]; readonly kerbed: WindingRing[] }

/** DO NOT answer a point from a region's union again: the answer is local. */
function insideLevels(net: Network, p: Vec2): { readonly paving: boolean; readonly kerbed: boolean } {
  const x = p.x * CLIPPER_SCALE, y = p.y * CLIPPER_SCALE;
  let paving = 0, kerbed = 0;
  for (const rings of localRings(net, [p.x, p.y, p.x, p.y])) {
    for (const r of rings.paving) if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) paving += windingOf(r, x, y);
    for (const r of rings.kerbed) if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) kerbed += windingOf(r, x, y);
  }
  return { paving: paving !== 0, kerbed: kerbed !== 0 };
}

/** The footway and kerb rings of a street, made once per ribbon the network built. */
function ribbonRings(net: Network, ribbon: SegmentRibbon, include: (id: SegmentId) => boolean): FootRings {
  const footRings = stateOf(net).rings;
  let rings = footRings.get(ribbon);
  if (!rings) {
    rings = {
      paving: windingRings(levelRingsOf(net, Level.Sidewalk, [ribbon], [], include)),
      kerbed: windingRings(levelRingsOf(net, Level.Curb, [ribbon], [], include)),
    };
    footRings.set(ribbon, rings);
  }
  return rings;
}

/** The footway and kerb rings of a junction, made once per junction the network solved. */
function junctionRings(net: Network, id: NodeId, byLevel: ReadonlyMap<SurfaceLevel, Junction>, include: (id: SegmentId) => boolean): FootRings {
  const footRings = stateOf(net).rings;
  let rings = footRings.get(byLevel);
  if (!rings) {
    rings = {
      paving: windingRings(levelRingsOf(net, Level.Sidewalk, [], [[id, byLevel]], include)),
      kerbed: windingRings(levelRingsOf(net, Level.Curb, [], [[id, byLevel]], include)),
    };
    footRings.set(byLevel, rings);
  }
  return rings;
}

/** The footway and kerb rings of the streets with footways and their junctions filed over `rect`, each made once per object the network built. */
function localRings(net: Network, rect: ChangeRect): FootRings[] {
  const include = polesInclude(net);
  const out: FootRings[] = [];
  for (const id of net.segmentCells.idsMeeting(rect)) {
    const ribbon = net.ribbons.get(id);
    if (ribbon) out.push(ribbonRings(net, ribbon, include));
  }
  for (const id of net.junctionCells.idsMeeting(rect)) {
    const byLevel = net.junctions.get(id);
    if (byLevel) out.push(junctionRings(net, id, byLevel, include));
  }
  return out;
}

/** DO NOT go back to asking each cell: that is the whole raster times the rings round each cell. */
export function* markPlates(net: Network, grid: RasterGrid, label: Int32Array): Generator<void, void> {
  const { minX, minY, W, H, step } = grid;
  const S = CLIPPER_SCALE;
  const include = polesInclude(net);
  const rect = gridRect(grid);
  const cx = (i: number): number => minX + (i + 0.5) * step;
  const cy = (j: number): number => minY + (j + 0.5) * step;
  // Every ring that can count at some centre, with the run of columns it may count in.
  interface Placed { readonly ring: WindingRing; readonly kerbed: boolean; readonly filed: ChangeRect; readonly lo: number; readonly hi: number }
  const placed: Placed[] = [];
  const place = (rings: FootRings, filed: ChangeRect | undefined): void => {
    if (!filed) return;
    for (const kerbed of [false, true]) {
      for (const ring of kerbed ? rings.kerbed : rings.paving) {
        // insideLevels: x >= r.x0 && x <= r.x1, and idsMeeting: filed[0] <= p.x <= filed[2] - both monotone in the column.
        const lo = firstTrue(0, W, (i) => cx(i) >= filed[0] && cx(i) * S >= ring.x0);
        const hi = firstTrue(lo, W, (i) => cx(i) > filed[2] || cx(i) * S > ring.x1);
        if (lo < hi) placed.push({ ring, kerbed, filed, lo, hi });
      }
    }
  };
  for (const id of net.segmentCells.idsMeeting(rect)) {
    const ribbon = net.ribbons.get(id);
    if (ribbon) place(ribbonRings(net, ribbon, include), net.segmentCells.rectOf(id));
  }
  for (const id of net.junctionCells.idsMeeting(rect)) {
    const byLevel = net.junctions.get(id);
    if (byLevel) place(junctionRings(net, id, byLevel, include), net.junctionCells.rectOf(id));
  }
  yield;
  // Each edge filed under the rows it crosses (a counting sort by row): ring, then edge's end index.
  const rowOf: number[] = [], ringOf: number[] = [], edgeOf: number[] = [];
  for (let p = 0; p < placed.length; p++) {
    const { ring, filed } = placed[p]!;
    const xy = ring.xy;
    for (let i = 0, j = xy.length - 2; i < xy.length; j = i, i += 2) {
      const ay = xy[j + 1]!, by = xy[i + 1]!;
      if (ay === by) continue;
      const lowY = Math.min(ay, by) / S, highY = Math.max(ay, by) / S;
      const r0 = Math.max(0, Math.floor((lowY - minY) / step - 0.5) - 1);
      const r1 = Math.min(H - 1, Math.ceil((highY - minY) / step - 0.5) + 1);
      for (let row = r0; row <= r1; row++) {
        const py = cy(row), y = py * S;
        if (py < filed[1] || py > filed[3] || y < ring.y0 || y > ring.y1) continue;
        if ((ay <= y) === (by <= y)) continue;
        rowOf.push(row); ringOf.push(p); edgeOf.push(i);
      }
    }
  }
  const start = new Int32Array(H + 1);
  for (const row of rowOf) start[row + 1]!++;
  for (let row = 0; row < H; row++) start[row + 1]! += start[row]!;
  const order = new Int32Array(rowOf.length);
  const fill = start.slice(0, H);
  for (let k = 0; k < rowOf.length; k++) order[fill[rowOf[k]!]!++] = k;
  yield;
  const paving = new Int32Array(W + 1), kerbed = new Int32Array(W + 1);
  for (let row = 0; row < H; row++) {
    if (start[row] === start[row + 1]) continue;
    const y = cy(row) * S;
    let from = W, to = 0;
    for (let n = start[row]!; n < start[row + 1]!; n++) {
      const k = order[n]!;
      const { ring, kerbed: isKerb, lo, hi } = placed[ringOf[k]!]!;
      const xy = ring.xy, i = edgeOf[k]!, j = i === 0 ? xy.length - 2 : i - 2;
      const ax = xy[j]!, ay = xy[j + 1]!, bx = xy[i]!, by = xy[i + 1]!;
      // windingOf: upward edges count +1 where the cross is > 0, downward ones -1 where it is < 0; both a run from the left.
      const up = ay <= y;
      const end = firstTrue(lo, hi, (c) => {
        const x = cx(c) * S;
        const cross = (bx - ax) * (y - ay) - (x - ax) * (by - ay);
        return up ? !(cross > 0) : !(cross < 0);
      });
      if (end === lo) continue;
      const acc = isKerb ? kerbed : paving;
      acc[lo]! += up ? 1 : -1;
      acc[end]! -= up ? 1 : -1;
      from = Math.min(from, lo); to = Math.max(to, end);
    }
    let wp = 0, wk = 0;
    const base = row * W;
    for (let c = from; c < to; c++) {
      wp += paving[c]!; wk += kerbed[c]!;
      if ((wp !== 0 || wk !== 0) && label[base + c] === NEAR) label[base + c] = PAVED;
    }
    paving.fill(0, from, to + 1); kerbed.fill(0, from, to + 1);
    if (row % 64 === 63) yield;
  }
}

/** Whether a point is on a footway: on the paving, outside every kerbed carriageway. */
export function onFootway(net: Network, p: Vec2): boolean {
  const inside = insideLevels(net, p);
  return inside.paving && !inside.kerbed;
}

/** DO NOT ask the two in turn: each walked the rings round the point again. */
export function onPaving(net: Network, p: Vec2): boolean {
  const inside = insideLevels(net, p);
  return inside.paving || inside.kerbed;
}

/** The work `kerbward` did: kerb edges walked. A count for the performance budgets (`core/perfBudget.ts`). */
export const kerbWork = { edges: 0 };

/** Each ring's bounds of a MultiPoly, in its order, made once per MultiPoly (`kerbward`). */
const boxesOf = new WeakMap<MultiPoly, readonly (readonly [number, number, number, number])[]>();
function ringBoxes(polys: MultiPoly): readonly (readonly [number, number, number, number])[] {
  const known = boxesOf.get(polys);
  if (known) return known;
  const out: [number, number, number, number][] = [];
  for (const poly of polys) for (const ring of poly) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const pt of ring) { x0 = Math.min(x0, pt[0]!); y0 = Math.min(y0, pt[1]!); x1 = Math.max(x1, pt[0]!); y1 = Math.max(y1, pt[1]!); }
    out.push([x0, y0, x1, y1]);
  }
  boxesOf.set(polys, out);
  return out;
}

/** The unit direction from a point to the nearest kerb edge */
export function kerbward(net: Network, p: Vec2, reach: number): Vec2 | null {
  let best: Vec2 | null = null;
  // As far as the cell's lines would answer (`poleLinesAt`, within their halo).
  let bestD = Math.min(reach, LINES_HALO - POLE_KERB_INSET);
  const rings = localRings(net, [p.x - bestD, p.y - bestD, p.x + bestD, p.y + bestD]);
  const x = p.x * CLIPPER_SCALE, y = p.y * CLIPPER_SCALE;
  let winding = 0;
  for (const set of rings) for (const r of set.kerbed) if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) winding += windingOf(r, x, y);
  // Inside the carriageway the union has no edge where two kerbs overlap, so the rings' nearest edge is not its: asked of the union there.
  if (winding !== 0) return kerbwardOfUnion(net, p, reach);
  /** DO NOT ask a pole's kerb of a region's union again: the answer is local. */
  const reachSq = (bestD * CLIPPER_SCALE) ** 2;
  for (const set of rings) {
    for (const r of set.kerbed) {
      const bx = Math.max(r.x0 - x, 0, x - r.x1), by = Math.max(r.y0 - y, 0, y - r.y1);
      if (bx * bx + by * by > reachSq * (1 + 1e-9) + 1) continue;
      const xy = r.xy;
      kerbWork.edges += xy.length / 2;
      for (let i = 0; i < xy.length; i += 2) {
        const j = (i + 2) % xy.length;
        const ax = xy[i]! / CLIPPER_SCALE, ay = xy[i + 1]! / CLIPPER_SCALE;
        const dx = xy[j]! / CLIPPER_SCALE - ax, dy = xy[j + 1]! / CLIPPER_SCALE - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / len2)) : 0;
        const qx = ax + dx * t - p.x, qy = ay + dy * t - p.y;
        const d = Math.hypot(qx, qy);
        if (d <= 1e-9 || d > bestD + 1e-9) continue;
        const ux = qx / d, uy = qy / d;
        if (best && d >= bestD - 1e-9 && (ux < best.x || (ux === best.x && uy <= best.y))) continue;
        bestD = Math.min(bestD, d);
        best = { x: ux, y: uy };
      }
    }
  }
  return best;
}

/** `kerbward` over the cell's union (`poleLinesAt`): for a point inside a kerb, where the union and the rings differ. */
function kerbwardOfUnion(net: Network, p: Vec2, reach: number): Vec2 | null {
  let best: Vec2 | null = null;
  // The cell's lines answer within their halo (`poleLinesAt`).
  let bestD = Math.min(reach, LINES_HALO - POLE_KERB_INSET);
  const kerbed = poleLinesAt(net, p).kerbed;
  const boxes = ringBoxes(kerbed);
  let r = 0;
  for (const poly of kerbed) {
    for (const ring of poly) {
      // A ring whose bounds are no nearer than the kerb found so far holds no nearer edge
      const box = boxes[r++]!;
      if (Math.hypot(Math.max(box[0] - p.x, 0, p.x - box[2]), Math.max(box[1] - p.y, 0, p.y - box[3])) > bestD + 1e-6) continue;
      kerbWork.edges += ring.length;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
        const ax = a[0]!, ay = a[1]!, dx = b[0]! - ax, dy = b[1]! - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / len2)) : 0;
        const qx = ax + dx * t - p.x, qy = ay + dy * t - p.y;
        const d = Math.hypot(qx, qy);
        if (d <= 1e-9 || d > bestD + 1e-9) continue;
        // Two kerbs as near (a point on a street's middle line): the answer must not hang on the order the rings come in
        const x = qx / d, y = qy / d;
        if (best && d >= bestD - 1e-9 && (x < best.x || (x === best.x && y <= best.y))) continue;
        bestD = Math.min(bestD, d);
        best = { x, y };
      }
    }
  }
  return best;
}

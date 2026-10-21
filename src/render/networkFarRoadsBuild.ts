import earcut from 'earcut';
import { difference, intersection, union, type MultiPoly, type Ring } from '@core/clipper';

/**
 * THE WHOLE NETWORK'S FAR ROADS, MADE FROM THE NETWORK ITSELF (`networkFarRoads.ts`): every road's and junction's real outline (the
 * network's own rings: the carriageway, and the casing its footways and kerbs fill) laid at its height and filled, a cell at a time.
 * Pure, run by a job worker (`networkFarRoads.worker.ts`) or, where none can be made, on the page.
 *
 * DO NOT fill the outlines as they come, one over the other: the casing's outline spans the carriageway too, and two coplanar layers
 * told apart by a polygon offset alone fight triangle by triangle in a floating-point depth buffer (its minimum resolvable difference
 * is per primitive, 2^(e - n) of the largest depth the triangle spans: OpenGL ES 3.0 spec, 3.6.5 "Depth Offset"), the saw-tooth of
 * step-25k 89-ne-district (2026-10-21). Each cell's layers are made disjoint instead: the carriageways merged (each class under the
 * one before it cut away), the casing merged and the carriageways cut out of it (the band between the kerb and the footway's edge),
 * each clipped to its cell exactly (a cell is a road block, `roadSurfaces.ts` CHUNK: its detailed blocks replace it whole).
 */

/** What the page hands over: each outline's vertices (x, y, height), how many each has, its layer (0 the casing, 1 the carriageway) and its colour (linear rgb). */
export interface FarRoadInput {
  /** The cells' side and the grid's origin, world units (the road blocks', `roadSurfaces.ts` CHUNK tiles). */
  readonly cell: number;
  readonly origin: number;
  /** The area whose roads are drawn by their detailed surfaces already (the opening's tiles): cut out of every cell. Null: none. */
  readonly exclude: readonly [number, number, number, number] | null;
  readonly points: Float64Array;
  readonly counts: Uint32Array;
  readonly layers: Uint8Array;
  readonly colors: Float32Array;
}

/** One cell's layer: positions in the scene (x, height, -y), a colour a vertex, the triangles. */
export interface FarRoadCell {
  readonly key: string;
  readonly layer: number;
  readonly positions: Float32Array;
  readonly colors: Float32Array;
  readonly indices: Uint32Array;
}

/** The side of the buckets the outlines' edges are filed in to read a height (`EdgeHeights`), world units: wider than half the widest road, so a cut across a carriageway finds its edges. */
const HEIGHT_BUCKET = 24;

/** The outlines' edges filed by bucket: a point's height is read on the nearest edge, interpolated along it (a clipped vertex is not one of the outline's). */
class EdgeHeights {
  private readonly buckets = new Map<number, number[]>();
  constructor(private readonly points: Float64Array, counts: Uint32Array) {
    let from = 0;
    for (const count of counts) {
      for (let k = 0; k < count; k++) {
        const a = from + k, b = from + ((k + 1) % count);
        const ax = points[a * 3]!, ay = points[a * 3 + 1]!, bx = points[b * 3]!, by = points[b * 3 + 1]!;
        const i0 = Math.floor(Math.min(ax, bx) / HEIGHT_BUCKET), i1 = Math.floor(Math.max(ax, bx) / HEIGHT_BUCKET);
        const j0 = Math.floor(Math.min(ay, by) / HEIGHT_BUCKET), j1 = Math.floor(Math.max(ay, by) / HEIGHT_BUCKET);
        for (let i = i0; i <= i1; i++) {
          for (let j = j0; j <= j1; j++) {
            const key = EdgeHeights.key(i, j);
            const list = this.buckets.get(key);
            if (list) list.push(a, b); else this.buckets.set(key, [a, b]);
          }
        }
      }
      from += count;
    }
  }

  private static key(i: number, j: number): number {
    return (i + 32768) * 65536 + (j + 32768);
  }

  /** The height of the edge nearest (x, y), where its foot falls along it; 0 where no edge is near. */
  at(x: number, y: number): number {
    const p = this.points;
    const ci = Math.floor(x / HEIGHT_BUCKET), cj = Math.floor(y / HEIGHT_BUCKET);
    for (let reach = 1; reach <= 3; reach++) {
      let best = Infinity, z = 0;
      for (let i = ci - reach; i <= ci + reach; i++) {
        for (let j = cj - reach; j <= cj + reach; j++) {
          const list = this.buckets.get(EdgeHeights.key(i, j));
          if (!list) continue;
          for (let k = 0; k < list.length; k += 2) {
            const a = list[k]! * 3, b = list[k + 1]! * 3;
            const ax = p[a]!, ay = p[a + 1]!, ex = p[b]! - ax, ey = p[b + 1]! - ay;
            const len2 = ex * ex + ey * ey;
            const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / len2)) : 0;
            const dx = ax + ex * t - x, dy = ay + ey * t - y;
            const d = dx * dx + dy * dy;
            if (d < best) { best = d; z = p[a + 2]! + (p[b + 2]! - p[a + 2]!) * t; }
          }
        }
      }
      if (best < Infinity) return z;
    }
    return 0;
  }
}

interface Builder { positions: number[]; colors: number[]; indices: number[] }

/** Each polygon of `shape` triangulated (its holes kept), laid at the heights read and painted `colour`, into `b`. */
function fill(shape: MultiPoly, colour: readonly [number, number, number], heights: EdgeHeights, b: Builder): void {
  for (const poly of shape) {
    const flat: number[] = [], holes: number[] = [];
    for (const part of poly) {
      if (part.length < 3) continue;
      if (flat.length) holes.push(flat.length / 2);
      for (const [x, y] of part) flat.push(x!, y!);
    }
    if (flat.length < 6) continue;
    const base = b.positions.length / 3;
    for (let i = 0; i < flat.length; i += 2) {
      const x = flat[i]!, y = flat[i + 1]!;
      b.positions.push(x, heights.at(x, y), -y);
      b.colors.push(colour[0], colour[1], colour[2]);
    }
    for (const t of earcut(flat, holes.length ? holes : undefined)) b.indices.push(base + t);
  }
}

/** The cells' layers, each disjoint from the other and clipped to its cell, the excluded area cut out (see the file's comment). */
export function buildFarRoadCells(input: FarRoadInput): FarRoadCell[] {
  const { cell, origin, exclude, points, counts, layers, colors } = input;
  const heights = new EdgeHeights(points, counts);
  /** Each cell's outlines, by layer: the casing's rings, and the carriageway's by colour (in the order the colours first came). */
  interface CellOutlines { casing: Ring[]; casingColour: [number, number, number]; asphalt: Map<string, { colour: [number, number, number]; rings: Ring[] }> }
  const cells = new Map<string, CellOutlines>();
  let from = 0;
  for (let p = 0; p < counts.length; p++) {
    const count = counts[p]!;
    const start = from;
    from += count;
    if (count < 3) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const ring: Ring = [];
    for (let k = 0; k < count; k++) {
      const i = (start + k) * 3;
      const x = points[i]!, y = points[i + 1]!;
      ring.push([x, y]);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    // Inside the area drawn in detail whole: nothing of it here.
    if (exclude && x0 >= exclude[0] && x1 <= exclude[2] && y0 >= exclude[1] && y1 <= exclude[3]) continue;
    const colour: [number, number, number] = [colors[p * 3]!, colors[p * 3 + 1]!, colors[p * 3 + 2]!];
    // Filed in every cell its box meets: each cell clips it to its own square.
    for (let i = Math.floor((x0 - origin) / cell); i <= Math.floor((x1 - origin) / cell); i++) {
      for (let j = Math.floor((y0 - origin) / cell); j <= Math.floor((y1 - origin) / cell); j++) {
        const key = `${i},${j}`;
        let c = cells.get(key);
        if (!c) cells.set(key, c = { casing: [], casingColour: colour, asphalt: new Map() });
        if (layers[p] === 0) { if (!c.casing.length) c.casingColour = colour; c.casing.push(ring); continue; }
        const tone = colour.join(',');
        const group = c.asphalt.get(tone);
        if (group) group.rings.push(ring); else c.asphalt.set(tone, { colour, rings: [ring] });
      }
    }
  }
  const out: FarRoadCell[] = [];
  for (const [key, c] of cells) {
    const [i, j] = key.split(',').map(Number) as [number, number];
    const x0 = origin + i * cell, y0 = origin + j * cell, x1 = x0 + cell, y1 = y0 + cell;
    let square: MultiPoly = [[[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]];
    if (exclude && exclude[0] < x1 && exclude[2] > x0 && exclude[1] < y1 && exclude[3] > y0) {
      square = difference(square, [[[[exclude[0], exclude[1]], [exclude[2], exclude[1]], [exclude[2], exclude[3]], [exclude[0], exclude[3]]]]]);
      if (!square.length) continue;
    }
    // The carriageways: each colour's merged and clipped, what a colour before it covers cut away (no two overlap).
    const asphalt: Builder = { positions: [], colors: [], indices: [] };
    let covered: MultiPoly = [];
    for (const { colour, rings } of c.asphalt.values()) {
      let shape = intersection(union(rings.map((r) => [r])), square);
      if (covered.length && shape.length) shape = difference(shape, covered);
      if (!shape.length) continue;
      fill(shape, colour, heights, asphalt);
      covered = covered.length ? union(covered, shape) : shape;
    }
    // The casing: the band the carriageways leave of it.
    const casing: Builder = { positions: [], colors: [], indices: [] };
    if (c.casing.length) {
      let shape = intersection(union(c.casing.map((r) => [r])), square);
      if (covered.length && shape.length) shape = difference(shape, covered);
      if (shape.length) fill(shape, c.casingColour, heights, casing);
    }
    for (const [layer, b] of [[0, casing], [1, asphalt]] as const) {
      if (!b.indices.length) continue;
      out.push({ key, layer, positions: new Float32Array(b.positions), colors: new Float32Array(b.colors), indices: new Uint32Array(b.indices) });
    }
  }
  return out;
}

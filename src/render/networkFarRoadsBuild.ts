import earcut from 'earcut';
import { difference, type MultiPoly } from '@core/clipper';

/**
 * THE WHOLE NETWORK'S FAR ROADS, MADE FROM THE NETWORK ITSELF (`networkFarRoads.ts`): every road's and junction's real outline (the
 * network's own rings: the carriageway, and the casing its footways and kerbs fill) laid at its height and filled, merged a cell at a
 * time. Pure, run by a job worker (`networkFarRoads.worker.ts`) or, where none can be made, on the page: O(the outlines' vertices).
 */

/** What the page hands over: each outline's vertices (x, y, height), how many each has, its layer (0 the casing, 1 the carriageway) and its colour (linear rgb). */
export interface FarRoadInput {
  /** The cells' side and the grid's origin, world units (the road blocks', `roadSurfaces.ts` CHUNK tiles). */
  readonly cell: number;
  readonly origin: number;
  /** The area whose roads are drawn by their detailed surfaces already (the opening's tiles): cut out of every outline. Null: none. */
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

/** The outline's height at a point it did not have (a cut along the excluded area's edge): its nearest vertex's. */
function nearestHeight(points: Float64Array, from: number, count: number, x: number, y: number): number {
  let best = Infinity, z = 0;
  for (let k = 0; k < count; k++) {
    const i = (from + k) * 3;
    const d = (points[i]! - x) ** 2 + (points[i + 1]! - y) ** 2;
    if (d < best) { best = d; z = points[i + 2]!; }
  }
  return z;
}

interface Builder { positions: number[]; colors: number[]; indices: number[] }

/** Every outline filled into its cell's layer, the excluded area cut out of those that reach it. */
export function buildFarRoadCells(input: FarRoadInput): FarRoadCell[] {
  const { cell, origin, exclude, points, counts, layers, colors } = input;
  const cells = new Map<string, Builder>();
  const into = (key: string): Builder => {
    let b = cells.get(key);
    if (!b) { b = { positions: [], colors: [], indices: [] }; cells.set(key, b); }
    return b;
  };
  const cut: MultiPoly = exclude ? [[[[exclude[0], exclude[1]], [exclude[2], exclude[1]], [exclude[2], exclude[3]], [exclude[0], exclude[3]]]]] : [];
  let from = 0;
  for (let p = 0; p < counts.length; p++) {
    const count = counts[p]!;
    const start = from;
    from += count;
    if (count < 3) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < count; k++) {
      const i = (start + k) * 3;
      const x = points[i]!, y = points[i + 1]!;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const key = `${Math.floor(((x0 + x1) / 2 - origin) / cell)},${Math.floor(((y0 + y1) / 2 - origin) / cell)}|${layers[p]}`;
    const r = colors[p * 3]!, g = colors[p * 3 + 1]!, bl = colors[p * 3 + 2]!;
    const b = into(key);
    const meets = exclude !== null && x0 < exclude[2] && x1 > exclude[0] && y0 < exclude[3] && y1 > exclude[1];
    if (!meets) {
      const flat: number[] = [];
      for (let k = 0; k < count; k++) flat.push(points[(start + k) * 3]!, points[(start + k) * 3 + 1]!);
      const base = b.positions.length / 3;
      for (let k = 0; k < count; k++) {
        const i = (start + k) * 3;
        b.positions.push(points[i]!, points[i + 2]!, -points[i + 1]!);
        b.colors.push(r, g, bl);
      }
      for (const t of earcut(flat)) b.indices.push(base + t);
      continue;
    }
    // Inside the area drawn in detail whole: nothing of it here. Across its edge: what is left outside, holes and all.
    if (x0 >= exclude[0] && x1 <= exclude[2] && y0 >= exclude[1] && y1 <= exclude[3]) continue;
    const ring: number[][] = [];
    for (let k = 0; k < count; k++) ring.push([points[(start + k) * 3]!, points[(start + k) * 3 + 1]!]);
    for (const poly of difference([[ring]], cut)) {
      const flat: number[] = [], holes: number[] = [];
      for (const part of poly) {
        if (flat.length) holes.push(flat.length / 2);
        for (const [x, y] of part) flat.push(x!, y!);
      }
      const base = b.positions.length / 3;
      for (let i = 0; i < flat.length; i += 2) {
        const x = flat[i]!, y = flat[i + 1]!;
        b.positions.push(x, nearestHeight(points, start, count, x, y), -y);
        b.colors.push(r, g, bl);
      }
      for (const t of earcut(flat, holes.length ? holes : undefined)) b.indices.push(base + t);
    }
  }
  const out: FarRoadCell[] = [];
  for (const [key, b] of cells) {
    if (!b.indices.length) continue;
    const bar = key.lastIndexOf('|');
    out.push({ key: key.slice(0, bar), layer: Number(key.slice(bar + 1)), positions: new Float32Array(b.positions), colors: new Float32Array(b.colors), indices: new Uint32Array(b.indices) });
  }
  return out;
}

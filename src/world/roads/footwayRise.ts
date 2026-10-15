import { Polyline } from '@core/polyline';
import type { Network } from '../network';
import { CASING_BAND, FOOTWAY_RISE, type RoadType, flushOn, footwayOn } from '../roadTypes';

/**
 * How high the footway stands over the carriageway at a point (docs/source/VIAS.md
 * V1, "the kerb is where the heights differ"): `FOOTWAY_RISE` on a kerbed
 * footway, nothing on one laid flush with the carriageway (a shared
 * surface, OpenDRIVE's lane `height` of zero). One answer for everything
 * that stands on a footway - its mesh, the people, the lamps, the signs, the
 * poles - so none of them floats over a flush footway or sinks into a
 * kerbed one.
 *
 * Asked for every walker in every frame, and for every lamp, sign and pole:
 * the flush roads are found by place (`Network.flushCells`, kept by the
 * network's build), so a point reads the cells round it and nothing where
 * no road is flush - every map before V1.
 * DO NOT go back to a list of every flush road of the map, made again at
 * each network revision and walked for every point.
 */

const hit = { s: 0, distance: 0 };

/** What `flushHolds` reads of a road: its widths and which footway is flush. */
export type FlushRoad = Pick<RoadType, 'width' | 'sidewalk' | 'sidewalkLeft' | 'sidewalkRight' | 'flushLeft' | 'flushRight'>;

/**
 * Whether (x, y) is on a footway of this road laid flush. Pure: the page asks
 * it of the roads filed at the point, a road tile worker of the roads handed
 * to it (`render/roadTileMesh.ts`).
 */
export function flushHolds(full: Polyline, road: FlushRoad, x: number, y: number): boolean {
  const reach = road.width / 2 + road.sidewalk + CASING_BAND;
  full.closestInto(x, y, hit);
  if (hit.distance > reach) return false;
  const frame = full.sampleAt(hit.s);
  const left = (x - frame.p.x) * frame.n.x + (y - frame.p.y) * frame.n.y >= 0;
  if (!flushOn(road as RoadType, left ? 'left' : 'right')) return false;
  const edge = road.width / 2;
  return hit.distance >= edge - 1e-6 && hit.distance <= edge + footwayOn(road as RoadType, left ? 'left' : 'right') + CASING_BAND;
}

/** The share of `FOOTWAY_RISE` the footway at (x, y) stands at: 1 kerbed, 0 flush. */
export function footwayRiseShare(net: Network, x: number, y: number): number {
  // A ribbon's filed bounds reach its casing (`ribbonBounds`): every road whose footway holds the point.
  for (const id of net.flushCells.idsMeeting([x, y, x, y])) {
    const ribbon = net.ribbons.get(id);
    if (!ribbon) continue;
    if (flushHolds(ribbon.full, ribbon.road, x, y)) return 0;
  }
  return 1;
}

/** The footway's height over the carriageway at (x, y), world units. */
export const footwayRiseAt = (net: Network, x: number, y: number): number => FOOTWAY_RISE * footwayRiseShare(net, x, y);

/**
 * The roads with a footway laid flush whose filed box (`Network.flushCells`) meets some rectangles:
 * box, line and widths, as arrays to hand a worker (MDN, "Transferable objects"). Every road
 * `footwayRiseShare` reads at a point of the rectangles is among them.
 */
export interface FlushData {
  readonly rects: Float64Array;
  readonly lineEnds: Uint32Array;
  readonly lines: Float64Array;
  readonly roads: readonly FlushRoad[];
}

/** `FlushData` for `rects`, its arrays fresh: the buffers to hand over in `transfer`. */
export function packFlush(net: Network, rects: readonly (readonly [number, number, number, number])[]): { data: FlushData; transfer: ArrayBuffer[] } {
  const ids = new Set<number>();
  for (const rect of rects) for (const id of net.flushCells.idsMeeting(rect)) ids.add(id);
  const roads: FlushRoad[] = [];
  const boxes: number[] = [];
  const lines: Float64Array[] = [];
  for (const id of ids) {
    const ribbon = net.ribbons.get(id as never);
    const rect = net.flushCells.rectOf(id as never);
    if (!ribbon || !rect) continue;
    const road = ribbon.road;
    roads.push({ width: road.width, sidewalk: road.sidewalk,
      ...(road.sidewalkLeft !== undefined ? { sidewalkLeft: road.sidewalkLeft } : {}),
      ...(road.sidewalkRight !== undefined ? { sidewalkRight: road.sidewalkRight } : {}),
      ...(road.flushLeft !== undefined ? { flushLeft: road.flushLeft } : {}),
      ...(road.flushRight !== undefined ? { flushRight: road.flushRight } : {}) });
    boxes.push(rect[0], rect[1], rect[2], rect[3]);
    lines.push(ribbon.full.xy);
  }
  let length = 0;
  for (const line of lines) length += line.length;
  const flat = new Float64Array(length);
  const lineEnds = new Uint32Array(lines.length);
  let at = 0;
  lines.forEach((line, i) => { flat.set(line, at); at += line.length; lineEnds[i] = at; });
  const data: FlushData = { rects: Float64Array.from(boxes), lineEnds, lines: flat, roads };
  return { data, transfer: [data.rects, lineEnds, flat].map((array) => array.buffer as ArrayBuffer) };
}

/** `footwayRiseShare` over `FlushData`: the same answer at every point of the rectangles it was packed for. */
export function flushShareOf(data: FlushData): (x: number, y: number) => number {
  const roads: { minX: number; minY: number; maxX: number; maxY: number; line: Polyline; road: FlushRoad }[] = [];
  let at = 0;
  for (let i = 0; i < data.roads.length; i++) {
    const r = data.rects;
    roads.push({ minX: r[i * 4]!, minY: r[i * 4 + 1]!, maxX: r[i * 4 + 2]!, maxY: r[i * 4 + 3]!,
      line: Polyline.fromFlat(data.lines.subarray(at, data.lineEnds[i]!)), road: data.roads[i]! });
    at = data.lineEnds[i]!;
  }
  return (x, y) => {
    // The roads filed at the point (`CellFiling.idsMeeting`: its box holds it, edges included); any flush there answers 0.
    for (const f of roads) {
      if (x < f.minX || x > f.maxX || y < f.minY || y > f.maxY) continue;
      if (flushHolds(f.line, f.road, x, y)) return 0;
    }
    return 1;
  };
}

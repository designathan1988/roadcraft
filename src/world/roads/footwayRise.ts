import { Polyline, newFrame } from '@core/polyline';
import type { Network } from '../network';
import { CASING_BAND, FOOTWAY_RISE, type RoadType, flushOn, footwayOn } from '../roadTypes';

/** DO NOT go back to a list of every flush road of the map, made again at each network revision and walked for every point. */

const hit = { s: 0, distance: 0 };
/** The frame a read's side is taken from (`flushHolds`): one, never kept. */
const frame = newFrame();

/** What `flushHolds` reads of a road: its widths and which footway is flush. */
type FlushRoad = Pick<RoadType, 'width' | 'sidewalk' | 'sidewalkLeft' | 'sidewalkRight' | 'flushLeft' | 'flushRight'>;

/** Whether (x, y) is on a footway of this road laid flush. */
function flushHolds(full: Polyline, road: FlushRoad, x: number, y: number): boolean {
  const reach = road.width / 2 + road.sidewalk + CASING_BAND;
  full.closestInto(x, y, hit);
  if (hit.distance > reach) return false;
  full.sampleAtInto(hit.s, frame);
  const left = (x - frame.p.x) * frame.n.x + (y - frame.p.y) * frame.n.y >= 0;
  if (!flushOn(road as RoadType, left ? 'left' : 'right')) return false;
  const edge = road.width / 2;
  return hit.distance >= edge - 1e-6 && hit.distance <= edge + footwayOn(road as RoadType, left ? 'left' : 'right') + CASING_BAND;
}

/** The share of `FOOTWAY_RISE` the footway at (x, y) stands at: 1 kerbed, 0 flush. */
export function footwayRiseShare(net: Network, x: number, y: number): number {
  // A ribbon's filed bounds reach its casing (`ribbonBounds`): some road whose footway holds the point, whichever (the answer is 0 or 1, not which). DO NOT ask `idsMeeting` for it: a rectangle, a set and a sorted list a point, read for every vertex of a footway.
  return net.flushCells.someAt(x, y, (id) => { const ribbon = net.ribbons.get(id); return !!ribbon && flushHolds(ribbon.full, ribbon.road, x, y); }) ? 0 : 1;
}

/** The footway's height over the carriageway at (x, y), world units. */
export const footwayRiseAt = (net: Network, x: number, y: number): number => FOOTWAY_RISE * footwayRiseShare(net, x, y);

/** The roads with a footway laid flush whose filed box (`Network.flushCells`) meets some rectangles */
export interface FlushData {
  readonly rects: Float64Array;
  readonly lineEnds: Uint32Array;
  readonly lines: Float64Array;
  readonly roads: readonly FlushRoad[];
}

/** `FlushData` for `rects`, its arrays fresh: the buffers to hand over in `transfer`. */
export function packFlush(net: Network, rects: readonly (readonly [number, number, number, number])[]): { data: FlushData; transfer: ArrayBuffer[] } {
  const ids = new Set<number>();
  for (const id of net.flushCells.idsMeetingAny(rects)) ids.add(id);
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

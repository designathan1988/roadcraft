/** THE ROADS' PAINT AS QUADS (`roadSurfaceInputs.ts`): plain geometry, read on the page and by a road bake in a worker (`nearRoadTiles.ts`); its materials are the page's (`markings.ts`) */

import type { Vec2 } from '@core/vec2';
import { GEO_EPS } from '@core/scalar';
import { LANE_LINE, Level, ROAD_TYPES } from '@world/roadTypes';
import { STYLE_PAINT } from '@world/roads/markingStyle';
import type { Network, SegmentRibbon } from '@world/network';
import type { NodeId } from '@world/ids';
import { type Bar, type StrokeSpec, segmentMarkings } from '@world/markings';
import { STOP_BAR_WIDTH } from '@world/approach';
import { PARKING_PAINT } from '@world/parkingLayout';
import { m } from '@world/units';

/** How far paint stands above the asphalt. Enough to win the depth test. */
export const PAINT_RISE = m(0.008);

/** Where a stroke's quads go, one ring each, with its colour (`roadSurfaceInputs.ts`). */
export type QuadSink = (color: string, ring: number[][]) => void;

function quad(sink: QuadSink, color: string, a: Vec2, b: Vec2, half: number): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < GEO_EPS) return;
  const nx = (-dy / length) * half;
  const ny = (dx / length) * half;
  sink(color, [
    [a.x - nx, a.y - ny],
    [a.x + nx, a.y + ny],
    [b.x + nx, b.y + ny],
    [b.x - nx, b.y - ny],
  ]);
}

/** One stroke as quads, dashed as its pattern says. */
export function strokeQuads(sink: QuadSink, spec: StrokeSpec): void {
  const color = spec.color;
  if (spec.fill) {
    if (spec.points.length >= 3) sink(color, spec.points.map((p) => [p.x, p.y]));
    return;
  }
  const pattern = spec.dash;
  if (!pattern?.length) {
    for (let i = 1; i < spec.points.length; i++) {
      quad(sink, color, spec.points[i - 1] as Vec2, spec.points[i] as Vec2, spec.width / 2);
    }
    return;
  }

  const period = pattern.reduce((sum, value) => sum + value, 0);
  let phase = ((spec.dashOffset % period) + period) % period;
  let patternIndex = 0;
  while (phase >= (pattern[patternIndex] as number)) {
    phase -= pattern[patternIndex] as number;
    patternIndex = (patternIndex + 1) % pattern.length;
  }
  let remaining = (pattern[patternIndex] as number) - phase;
  let ink = patternIndex % 2 === 0;

  for (let i = 1; i < spec.points.length; i++) {
    const a = spec.points[i - 1] as Vec2;
    const b = spec.points[i] as Vec2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < GEO_EPS) continue;
    let travelled = 0;
    while (travelled < length) {
      const amount = Math.min(remaining, length - travelled);
      if (ink) {
        const t0 = travelled / length;
        const t1 = (travelled + amount) / length;
        quad(
          sink,
          color,
          { x: a.x + dx * t0, y: a.y + dy * t0 },
          { x: a.x + dx * t1, y: a.y + dy * t1 },
          spec.width / 2,
        );
      }
      travelled += amount;
      remaining -= amount;
      if (remaining <= GEO_EPS) {
        patternIndex = (patternIndex + 1) % pattern.length;
        remaining = pattern[patternIndex] as number;
        ink = !ink;
      }
    }
  }
}

/** A stop line or a zebra's bar as one quad. */
export function barQuad(sink: QuadSink, color: string, value: Bar): void {
  quad(sink, color, value.a, value.b, value.width / 2);
}

/** Every colour the roads are painted in */
/** The stop lines' and the zebras' paint. */
export const STOP_PAINT = '#ece9d9';
export const ZEBRA_PAINT = '#f4f1e3';
export const PAINT_COLOURS: readonly string[] = Object.freeze([...new Set([...ROAD_TYPES.map((rt) => rt.line), LANE_LINE, ...STYLE_PAINT, ...PARKING_PAINT, STOP_PAINT, ZEBRA_PAINT])]);

/** A road's own paint along it (`segmentMarkings`), from its mouth to its stop lines or crossings. */
export function roadStrokes(net: Network, ribbon: SegmentRibbon): StrokeSpec[] {
  const trims = net.trims.get(ribbon.id);
  const start = trims?.a[Level.Asphalt] ?? 0;
  const segment = net.doc.segment(ribbon.id);
  // From the mouth to the stop line (or the crossing) is not painted along.
  const cut = (node: NodeId | undefined, trim: number): number => {
    if (node === undefined) return 0;
    const crossing = net.doc.node(node)?.crossing;
    if (net.doc.degree(node) < 3 && !crossing) return 0;
    return Math.max(0, net.stopLineDistance(ribbon.id, node) + STOP_BAR_WIDTH / 2 - trim);
  };
  const cutA = cut(segment?.a, start);
  const cutB = cut(segment?.b, trims?.b[Level.Asphalt] ?? 0);
  return segmentMarkings(ribbon, start, cutA, cutB, net.doc.markingStyle);
}

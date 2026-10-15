import type { Polyline } from '@core/polyline';
import type { Vec2 } from '@core/vec2';

/** How far the strip reaches either side of the mouth, along the road, world units. */
const REACH = 2;
/** Spacing of the strip's cross-sections, world units. */
const STEP = 0.5;
/** Shortest strip worth adding, world units. */
const SHORTEST = 0.25;

/** The strip of a curved road's full width across one of its junction mouths. */
export function mouthOverlapStrip(full: Polyline, halfWidth: number, mouth: number): Vec2[] | null {
  const length = full.length;
  const from = Math.max(0, mouth - REACH);
  const to = Math.min(length, mouth + REACH);
  if (to - from < SHORTEST) return null;
  const left: Vec2[] = [], right: Vec2[] = [];
  const count = Math.max(2, Math.ceil((to - from) / STEP));
  for (let i = 0; i <= count; i++) {
    const frame = full.sampleAt(from + (to - from) * i / count);
    left.push({ x: frame.p.x + frame.n.x * halfWidth, y: frame.p.y + frame.n.y * halfWidth });
    right.push({ x: frame.p.x - frame.n.x * halfWidth, y: frame.p.y - frame.n.y * halfWidth });
  }
  return [...left, ...right.reverse()];
}

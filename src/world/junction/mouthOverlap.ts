import type { Polyline } from '@core/polyline';
import type { Vec2 } from '@core/vec2';

/** How far the strip reaches either side of the mouth, along the road, world units. */
const REACH = 2;
/** Spacing of the strip's cross-sections, world units. */
const STEP = 0.5;
/** Shortest strip worth adding, world units. */
const SHORTEST = 0.25;

/**
 * The strip of a curved road's full width across one of its junction mouths.
 *
 * A curved leg's offset edge is not the straight mouth chord the junction
 * plate is cut with, and a tight two-leg corner left a triangular gap of bare
 * ground between them. The drawn surface closes it with this strip, a short
 * exact-width overlap round the mouth taken from the road's full centreline
 * (`surfaces.ts levelRings`); the ground a turn is swept over has to see it
 * too (`turnPaths.ts JunctionSurface`): left out, a body running into a curved
 * mouth was "off the road" on the asphalt the player sees (fuzz
 * `turnOffSurface`, seed 60 of 60 operations).
 *
 * `mouth` is the arc length along `full` where the mouth is cut. Null when the
 * strip would be shorter than `SHORTEST`.
 */
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

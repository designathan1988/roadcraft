import type { Vec2 } from '@core/vec2';
import { m } from './units';

/** Half-length of the chord a body's heading is read along. */
export const HEADING_CHORD = m(1.5);

/** Unit heading from the point `behind` to the point `ahead`, or `fallback` when they coincide. */
export function chordHeading(behind: Vec2, ahead: Vec2, fallback: Vec2): Vec2 {
  const dx = ahead.x - behind.x;
  const dy = ahead.y - behind.y;
  const d = Math.hypot(dx, dy);
  return d < 1e-6 ? fallback : { x: dx / d, y: dy / d };
}

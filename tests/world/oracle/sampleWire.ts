import { WIRE_SEGMENTS, spanSag, wireDrop } from '@world/utilities';

/** Samples one wire between two poles, as a flat list of 3D points. */
export function sampleWire(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  segments = WIRE_SEGMENTS,
): { x: number; y: number; z: number }[] {
  const length = Math.hypot(bx - ax, by - ay);
  const sag = spanSag(length);
  const out: { x: number; y: number; z: number }[] = new Array(segments + 1);
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    out[i] = {
      x: ax + (bx - ax) * t,
      y: ay + (by - ay) * t,
      z: az + (bz - az) * t - wireDrop(t, sag),
    };
  }
  return out;
}

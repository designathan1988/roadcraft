/** A vehicle's one frame on the road: height, pitch and roll, from the road surface under its wheels. */
export interface RoadFrame {
  readonly deck: number;
  readonly pitch: number;
  readonly roll: number;
}

/** A frame written in place (`roadFrameInto`). */
export interface RoadFrameOut {
  deck: number;
  pitch: number;
  roll: number;
}

/** Steepest gradient and camber a frame will take from its samples. */
const MAX_FRAME_PITCH = 0.35;
const MAX_FRAME_ROLL = 0.25;

/** The frame through the road under the axles and the sides. */
export function roadFrame(
  heightAt: (x: number, y: number) => number,
  cx: number,
  cy: number,
  heading: number,
  front: number,
  rear: number,
  track: number,
  fallback: number,
): RoadFrame {
  return roadFrameInto(heightAt, cx, cy, heading, front, rear, track, fallback, { deck: 0, pitch: 0, roll: 0 });
}

/** `roadFrame` into `out`: the renderer asks it for every vehicle near enough, every frame. */
export function roadFrameInto(
  heightAt: (x: number, y: number) => number,
  cx: number,
  cy: number,
  heading: number,
  front: number,
  rear: number,
  track: number,
  fallback: number,
  out: RoadFrameOut,
): RoadFrameOut {
  const ux = Math.cos(heading);
  const uy = Math.sin(heading);
  const base = Math.max(1e-3, front - rear);
  let hFront: number;
  let hRear: number;
  let roll = 0;
  if (track > 0) {
    // Each axle's height is the mean of its two wheels; the roll is the mean of the two axles' side-to-side differences.
    const lx = -uy * track;
    const ly = ux * track;
    const fl = heightAt(cx + ux * front + lx, cy + uy * front + ly);
    const fr = heightAt(cx + ux * front - lx, cy + uy * front - ly);
    const rl = heightAt(cx + ux * rear + lx, cy + uy * rear + ly);
    const rr = heightAt(cx + ux * rear - lx, cy + uy * rear - ly);
    hFront = (fl + fr) / 2;
    hRear = (rl + rr) / 2;
    roll = Math.atan2((fl - fr + rl - rr) / 2, 2 * track);
  } else {
    hFront = heightAt(cx + ux * front, cy + uy * front);
    hRear = heightAt(cx + ux * rear, cy + uy * rear);
  }
  let pitch = Math.atan2(hFront - hRear, base);
  let deck = hRear + (0 - rear) * (hFront - hRear) / base;
  if (!Number.isFinite(pitch) || Math.abs(pitch) > MAX_FRAME_PITCH || !Number.isFinite(deck)) {
    pitch = 0;
    deck = fallback;
  }
  if (!Number.isFinite(roll) || Math.abs(roll) > MAX_FRAME_ROLL) roll = 0;
  out.deck = deck; out.pitch = pitch; out.roll = roll;
  return out;
}

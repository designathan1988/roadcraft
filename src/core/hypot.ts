/** THE LENGTH OF A 2D OR 3D VECTOR, BIT FOR BIT `Math.hypot`, WITH NO NUMBER BOXED OUT OF A BUILT-IN CALL */
// V8's `Math.hypot` is a built-in (`src/builtins/math.tq` MathHypot) the optimising compiler calls, not inlines: its arguments go
// in an array and its result comes back boxed, one heap number a call. This is its algorithm in plain JS, which V8 inlines:
// the absolute values over the largest, their squares summed with Kahan's compensation, the root times the largest.

/** `Math.hypot(dx, dy)` to the bit (Infinity before NaN, then 0 when both are 0, as the built-in). */
export function hypot2(dx: number, dy: number): number {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  const nanX = dx !== dx, nanY = dy !== dy;
  let max = 0;
  if (!nanX && ax > max) max = ax;
  if (!nanY && ay > max) max = ay;
  if (max === Infinity) return Infinity;
  if (nanX || nanY) return NaN;
  if (max === 0) return 0;
  // Kahan summation of the squares of each over the largest, in the arguments' order.
  let sum = 0, compensation = 0;
  const nx = ax / max, sx = nx * nx - compensation, px = sum + sx;
  compensation = (px - sum) - sx;
  sum = px;
  const ny = ay / max, sy = ny * ny - compensation, py = sum + sy;
  sum = py;
  return Math.sqrt(sum) * max;
}

/** `Math.hypot(dx, dy, dz)` to the bit (Infinity before NaN, then 0 when all are 0, as the built-in). */
export function hypot3(dx: number, dy: number, dz: number): number {
  const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
  const nanX = dx !== dx, nanY = dy !== dy, nanZ = dz !== dz;
  let max = 0;
  if (!nanX && ax > max) max = ax;
  if (!nanY && ay > max) max = ay;
  if (!nanZ && az > max) max = az;
  if (max === Infinity) return Infinity;
  if (nanX || nanY || nanZ) return NaN;
  if (max === 0) return 0;
  // Kahan summation of the squares of each over the largest, in the arguments' order.
  let sum = 0, compensation = 0;
  const nx = ax / max, sx = nx * nx - compensation, px = sum + sx;
  compensation = (px - sum) - sx;
  sum = px;
  const ny = ay / max, sy = ny * ny - compensation, py = sum + sy;
  compensation = (py - sum) - sy;
  sum = py;
  const nz = az / max, sz = nz * nz - compensation, pz = sum + sz;
  sum = pz;
  return Math.sqrt(sum) * max;
}

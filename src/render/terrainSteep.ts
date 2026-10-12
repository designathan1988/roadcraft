/**
 * EVERY CORNER'S STEEPEST FACE over a terrain plate (`terrain.ts`), degrees
 * from level: the steepness of each cell (its two triangles, split as `flip`
 * says) worked out once from the positions, then each corner takes the
 * steepest of the cells round it. The same answer as reading every corner's
 * eight faces, which worked each face out six times through Vector3s - 50 ms
 * of a planet plate coming in (profiled 2026-10-10).
 *
 * `positions`: x, y (up), z per corner, `side` corners a row; `flip[k]` for
 * cell k = cx + cy * (side - 1): its diagonal runs a-c instead of b-d.
 */
export function steepnessInto(
  positions: ArrayLike<number>,
  flip: ArrayLike<number | boolean>,
  side: number,
  cells: Float32Array,
  out: Float32Array,
): void {
  const seg = side - 1;
  for (let cy = 0; cy < seg; cy++) {
    for (let cx = 0; cx < seg; cx++) {
      const a = cx + side * cy, b = cx + side * (cy + 1), c = cx + 1 + side * (cy + 1), d = cx + 1 + side * cy;
      const k = cx + cy * seg;
      cells[k] = flip[k]
        ? Math.max(triangleSteep(positions, a, b, c), triangleSteep(positions, a, c, d))
        : Math.max(triangleSteep(positions, a, b, d), triangleSteep(positions, b, c, d));
    }
  }
  for (let v = 0; v < side * side; v++) {
    const ix = v % side;
    const iy = (v - ix) / side;
    let most = 0;
    for (let cy = iy - 1; cy <= iy; cy++) {
      if (cy < 0 || cy >= seg) continue;
      for (let cx = ix - 1; cx <= ix; cx++) {
        if (cx < 0 || cx >= seg) continue;
        const t = cells[cx + cy * seg] as number;
        if (t > most) most = t;
      }
    }
    out[v] = most;
  }
}

/** A triangle's steepness, degrees: its normal (c - b) x (a - b) from the vertical. */
export function triangleSteep(p: ArrayLike<number>, a: number, b: number, c: number): number {
  const bx = p[b * 3] as number, by = p[b * 3 + 1] as number, bz = p[b * 3 + 2] as number;
  const ux = (p[c * 3] as number) - bx, uy = (p[c * 3 + 1] as number) - by, uz = (p[c * 3 + 2] as number) - bz;
  const vx = (p[a * 3] as number) - bx, vy = (p[a * 3 + 1] as number) - by, vz = (p[a * 3 + 2] as number) - bz;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
  return length > 1e-9 ? Math.acos(Math.min(1, Math.abs(ny) / length)) * (180 / Math.PI) : 0;
}

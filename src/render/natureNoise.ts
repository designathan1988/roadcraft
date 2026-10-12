/**
 * The woods' masses: smooth value noise over the map's own coordinates, one
 * octave at a scale, by `salt` (`renderer.ts` natureSweep, the planet's
 * woods tone in `terrain.ts`). Shared so the far woods stand where the near ones do. Pure.
 */
export function natureNoise(x: number, y: number, scale: number, salt: number): number {
  const gx = x / scale, gy = y / scale;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const fx = gx - x0, fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const h00 = hash2(x0, y0, salt), h10 = hash2(x0 + 1, y0, salt), h01 = hash2(x0, y0 + 1, salt), h11 = hash2(x0 + 1, y0 + 1, salt);
  const top = h00 + (h10 - h00) * sx;
  const bottom = h01 + (h11 - h01) * sx;
  return top + (bottom - top) * sy;
}

/**
 * The integer hashes the noises read, at module level: made inside each
 * call, two or three closures a sample were the collector's share of a
 * plate's tree sweep (some 147 000 samples, profiled 2026-10-11). The same
 * numbers.
 */
function hash2(a: number, b: number, salt: number): number {
  let v = Math.imul(a, 374_761_393) ^ Math.imul(b, 668_265_263) ^ Math.imul(salt, 2_246_822_519);
  v = Math.imul(v ^ (v >>> 13), 1_274_126_177);
  return ((v ^ (v >>> 16)) >>> 0) / 4_294_967_296;
}
function hash3(a: number, b: number, c: number, salt: number): number {
  let v = Math.imul(a, 374_761_393) ^ Math.imul(b, 668_265_263) ^ Math.imul(c, 1_440_670_441) ^ Math.imul(salt, 2_246_822_519);
  v = Math.imul(v ^ (v >>> 13), 1_274_126_177);
  return ((v ^ (v >>> 16)) >>> 0) / 4_294_967_296;
}
function layer3(x0: number, y0: number, c: number, sx: number, sy: number, salt: number): number {
  const top = hash3(x0, y0, c, salt) + (hash3(x0 + 1, y0, c, salt) - hash3(x0, y0, c, salt)) * sx;
  const bottom = hash3(x0, y0 + 1, c, salt) + (hash3(x0 + 1, y0 + 1, c, salt) - hash3(x0, y0 + 1, c, salt)) * sx;
  return top + (bottom - top) * sy;
}

/**
 * The woods' density at a place (`natureSweep`'s Horizon Zero Dawn curve):
 * broad masses of a slow noise, the hillsides, the ecosystem's own canopy.
 */
export function natureDensity(wx: number, wy: number, metre: number, hillside: number, ecology: number): number {
  const patch = natureNoise(wx, wy, 170 * metre, 7) * 0.6 + natureNoise(wx, wy, 55 * metre, 9) * 0.3 + natureNoise(wx, wy, 18 * metre, 11) * 0.1;
  const masses = Math.min(1, Math.max(0, (patch - 0.47) / 0.3));
  return masses * 0.72 + hillside * 0.3 + ecology * 0.3 - 0.06;
}

/** `natureNoise` in three dimensions (a point of the sphere, world units): one pattern over the whole planet, no piece's axes in it. */
export function natureNoise3(x: number, y: number, z: number, scale: number, salt: number): number {
  const gx = x / scale, gy = y / scale, gz = z / scale;
  const x0 = Math.floor(gx), y0 = Math.floor(gy), z0 = Math.floor(gz);
  const fx = gx - x0, fy = gy - y0, fz = gz - z0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const a = layer3(x0, y0, z0, sx, sy, salt);
  return a + (layer3(x0, y0, z0 + 1, sx, sy, salt) - a) * sz;
}

/** `natureDensity` at a point of the planet's sphere (world units from its centre). */
export function natureDensity3(x: number, y: number, z: number, metre: number, hillside: number, ecology: number): number {
  const patch = natureNoise3(x, y, z, 170 * metre, 7) * 0.6 + natureNoise3(x, y, z, 55 * metre, 9) * 0.3 + natureNoise3(x, y, z, 18 * metre, 11) * 0.1;
  const masses = Math.min(1, Math.max(0, (patch - 0.47) / 0.3));
  return masses * 0.72 + hillside * 0.3 + ecology * 0.3 - 0.06;
}

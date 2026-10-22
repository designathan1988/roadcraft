import { BufferAttribute, BufferGeometry, MeshStandardMaterial } from 'three';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import { rootWidth, type Guide } from './groom';

/** THE HAIR'S SURFACE AS A VOLUME: every guide strand a tapered tube of density (its clump), the hair the surface where the density crosses a level -
 *  an implicit surface polygonized by marching cubes (Lorensen & Cline 1987; three's MarchingCubes). Clumps meet without gaps, the grooves between
 *  them stay (the union is the densest clump at each point, not their sum), tips come to points: the solid, sculpted hair of The Sims, from any groom. */

/** The level of the surface: a clump's edge at about two thirds of its radius. */
const ISO = 0.3;
/** A clump's depth off the head as a share of its width: a flat lock lying on the skull, not a round tube (`FLAT` of its radius each way). */
export const FLAT = 0.55;

/** The scalp's cap for the volume: a sphere of density at each point (dm), of its own radius. */
export interface Cap { points: Float32Array; radius: Float32Array }

export class HairVolume {
  readonly mesh: MarchingCubes;
  private readonly res: number;

  constructor(material: MeshStandardMaterial, res = 76) {
    this.res = res;
    this.mesh = new MarchingCubes(res, material, false, false, 260000);
    this.mesh.isolation = ISO;
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
  }

  /** The surface for these guides (in the body's frame, dm); `skull` the head's middle, the clumps flattened across the direction out from it. */
  build(guides: readonly Guide[], skull: readonly number[], cap?: Cap): void {
    const mc = this.mesh, N = this.res;
    mc.reset();
    if (!guides.length) { mc.update(); return; }
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], rmax = 0;
    for (const g of guides) {
      rmax = Math.max(rmax, g.radius);
      for (let i = 0; i < g.pts.length; i += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a]!, g.pts[i + a]!); hi[a] = Math.max(hi[a]!, g.pts[i + a]!); }
    }
    lo = lo.map((x) => x - rmax * 1.6); hi = hi.map((x) => x + rmax * 1.6);
    const centre = [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2];
    // A cube (marching cubes' grid is uniform), a cell's margin past the box on every side.
    const half = Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) / 2 * (N / (N - 4));
    mc.position.set(centre[0]!, centre[1]!, centre[2]!);
    mc.scale.setScalar(half);
    const toCell = (v: number, a: number): number => ((v - centre[a]!) / half) * (N / 2) + N / 2;
    const cell = (2 * half) / N;
    const field = mc.field;
    // The cap: a thin even layer over the whole scalp, ending just at the hairline - the hair's base, as on mesh hair, so its edge is one smooth line.
    if (cap) {
      const q = cap.points;
      for (let i = 0; i < q.length / 3; i++) {
        const r = cap.radius[i]!;
        const px = q[i * 3]!, py = q[i * 3 + 1]!, pz = q[i * 3 + 2]!;
        const x0 = Math.max(1, Math.floor(toCell(px - r, 0))), x1 = Math.min(N - 2, Math.ceil(toCell(px + r, 0)));
        const y0 = Math.max(1, Math.floor(toCell(py - r, 1))), y1 = Math.min(N - 2, Math.ceil(toCell(py + r, 1)));
        const z0 = Math.max(1, Math.floor(toCell(pz - r, 2))), z1 = Math.min(N - 2, Math.ceil(toCell(pz + r, 2)));
        for (let z = z0; z <= z1; z++) {
          const wz = centre[2]! + (z - N / 2) * cell - pz;
          for (let y = y0; y <= y1; y++) {
            const wy = centre[1]! + (y - N / 2) * cell - py;
            const row = z * N * N + y * N;
            for (let x = x0; x <= x1; x++) {
              const wx = centre[0]! + (x - N / 2) * cell - px;
              const d2 = (wx * wx + wy * wy + wz * wz) / (r * r);
              if (d2 >= 1) continue;
              const v = (1 - d2) * (1 - d2);
              if (v > field[row + x]!) field[row + x] = v;
            }
          }
        }
      }
    }
    for (const g of guides) {
      const p = g.pts, n = p.length / 3;
      const along = g.seg;
      for (let i = 0; i < n - 1; i++) {
        const t0 = i / (n - 1), t1 = (i + 1) / (n - 1);
        // The clump: thin where it grows (the hairline a fine edge, not a rolled brim), full a few centimetres on, narrowing to a point over its last part.
        const length = along * (n - 1);
        const r0 = g.radius * taper(t0, length, g.blunt) * rootWidth(g, i * along), r1 = g.radius * taper(t1, length, g.blunt) * rootWidth(g, (i + 1) * along);
        const r = Math.max(r0, r1);
        if (r <= 0) continue;
        const ax = p[i * 3]!, ay = p[i * 3 + 1]!, az = p[i * 3 + 2]!, bx = p[i * 3 + 3]!, by = p[i * 3 + 4]!, bz = p[i * 3 + 5]!;
        const x0 = Math.max(1, Math.floor(toCell(Math.min(ax, bx) - r, 0))), x1 = Math.min(N - 2, Math.ceil(toCell(Math.max(ax, bx) + r, 0)));
        const y0 = Math.max(1, Math.floor(toCell(Math.min(ay, by) - r, 1))), y1 = Math.min(N - 2, Math.ceil(toCell(Math.max(ay, by) + r, 1)));
        const z0 = Math.max(1, Math.floor(toCell(Math.min(az, bz) - r, 2))), z1 = Math.min(N - 2, Math.ceil(toCell(Math.max(az, bz) + r, 2)));
        const dx = bx - ax, dy = by - ay, dz = bz - az, ll = dx * dx + dy * dy + dz * dz || 1;
        // Out from the head at the segment, square to the segment: the clump's flat way.
        let ox = (ax + bx) / 2 - skull[0]!, oy = (ay + by) / 2 - skull[1]!, oz = (az + bz) / 2 - skull[2]!;
        const od = (ox * dx + oy * dy + oz * dz) / ll;
        ox -= dx * od; oy -= dy * od; oz -= dz * od;
        const ol = Math.hypot(ox, oy, oz) || 1;
        ox /= ol; oy /= ol; oz /= ol;
        // Never thinner than two cells of the grid: the blur below would wear a thinner lock through (holes, a ragged hairline).
        const flat = Math.min(1, Math.max(FLAT, 2 * cell / r));
        const squash = 1 / (flat * flat) - 1;
        for (let z = z0; z <= z1; z++) {
          const wz = centre[2]! + (z - N / 2) * cell;
          for (let y = y0; y <= y1; y++) {
            const wy = centre[1]! + (y - N / 2) * cell;
            const row = z * N * N + y * N;
            for (let x = x0; x <= x1; x++) {
              const wx = centre[0]! + (x - N / 2) * cell;
              const s = Math.max(0, Math.min(1, ((wx - ax) * dx + (wy - ay) * dy + (wz - az) * dz) / ll));
              const qx = ax + dx * s - wx, qy = ay + dy * s - wy, qz = az + dz * s - wz;
              const rr = r0 + (r1 - r0) * s;
              const qo = qx * ox + qy * oy + qz * oz;
              const d2 = (qx * qx + qy * qy + qz * qz + squash * qo * qo) / (rr * rr);
              if (d2 >= 1) continue;
              const v = (1 - d2) * (1 - d2);
              const q = row + x;
              // The densest clump at each point (a crowd of them never swells the hair), the blur below then rounds their seams into one mass.
              if (v > field[q]!) field[q] = v;
            }
          }
        }
      }
    }
    blur(field, N);
    blur(field, N);
    mc.update();
  }

  /** The surface as plain geometry in the body's frame (dm): its triangles welded into shared vertices. */
  geometry(): { positions: Float32Array; index: Uint32Array } {
    const mc = this.mesh;
    const src = mc.positionArray, count = mc.count;
    const s = mc.scale.x, c = mc.position;
    const map = new Map<string, number>();
    const pos: number[] = [];
    const index = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      const x = c.x + src[i * 3]! * s, y = c.y + src[i * 3 + 1]! * s, z = c.z + src[i * 3 + 2]! * s;
      const key = `${Math.round(x * 2000)},${Math.round(y * 2000)},${Math.round(z * 2000)}`;
      let k = map.get(key);
      if (k === undefined) { k = pos.length / 3; map.set(key, k); pos.push(x, y, z); }
      index[i] = k;
    }
    return { positions: Float32Array.from(pos), index };
  }

  get triangles(): number { return this.mesh.count / 3; }
}

/** The density smoothed by a 1-2-1 kernel along each axis: no lumps, no stair steps from the grid. */
function blur(f: Float32Array, N: number): void {
  const tmp = new Float32Array(f.length);
  const strides = [1, N, N * N];
  for (const s of strides) {
    tmp.set(f);
    for (let i = s; i < f.length - s; i++) f[i] = (tmp[i - s]! + 2 * tmp[i]! + tmp[i + s]!) * 0.25;
  }
}

/** A clump's width along it (`t` 0 at the root, 1 at the tip; `length` dm): full, then narrowing to a rounded point. */
function taper(t: number, length: number, blunt = false): number {
  // A blunt cut only rounds its last few per cent.
  if (blunt) return t < 0.85 ? 1 : 1 - ((t - 0.85) / 0.15) * 0.35;
  // A point over its last 3.5 cm, within 30-45% of it: short hair a layer of locks, not a crop of teardrops; long hair's tips still fine.
  const zone = Math.min(0.45, Math.max(0.3, 0.35 / Math.max(0.1, length)));
  const from = 1 - zone;
  return t < from ? 1 : Math.max(0.12, 1 - ((t - from) / zone) ** 1.4 * 0.88);
}

/** Welded geometry as a BufferGeometry with smooth normals. */
export function volumeBuffer(g: { positions: Float32Array; index: Uint32Array }): BufferGeometry {
  const b = new BufferGeometry();
  b.setAttribute('position', new BufferAttribute(g.positions, 3));
  b.setIndex(new BufferAttribute(g.index, 1));
  b.computeVertexNormals();
  return b;
}

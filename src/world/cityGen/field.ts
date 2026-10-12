import type { Vec2 } from '@core/vec2';

/**
 * THE CITY'S GRAIN: the tensor field the streets of a generated city follow.
 *
 * Chen, Esch, Wonka, Müller and Zhang, "Interactive Procedural Street
 * Modeling" (SIGGRAPH 2008): a street network is the two families of
 * hyperstreamlines of a 2D symmetric tensor field - the major eigenvectors
 * give one set of streets, the minor ones the streets across them, always at
 * right angles where they cross. The field is a sum of basis fields, each
 * weighted by a fall-off round its centre:
 *
 * - a GRID field, one direction everywhere: a district laid out on a grid at
 *   its own angle (the Eixample, Manhattan above Houston);
 * - a RADIAL field round a centre: rings and spokes round a square or a hill
 *   (Paris round the Étoile, a Brazilian praça);
 * - a slow angle noise over the sum, so no street is ruler-straight for a
 *   kilometre unless a field says so.
 *
 * A symmetric traceless tensor is [[a, b], [b, -a]]: its major eigenvector
 * lies at half the angle of (a, b). Grid: (cos 2θ, sin 2θ). Radial round
 * (cx, cy), with d = p - c: (dy² - dx², -2 dx dy) / |d|², whose major
 * direction runs round the centre (rings) and the minor out from it (spokes).
 *
 * World units throughout. Pure and deterministic: the same field gives the
 * same city in the game, in a probe and in a test.
 */

export type BasisField =
  | { readonly kind: 'grid'; readonly x: number; readonly y: number; readonly radius: number; readonly angle: number; readonly weight: number }
  | { readonly kind: 'radial'; readonly x: number; readonly y: number; readonly radius: number; readonly weight: number };

export interface FieldNoise {
  /** Radians the streets turn at most, and over what distance the turn changes (u). */
  readonly amount: number;
  readonly scale: number;
  readonly seed: number;
}

export class TensorField {
  constructor(readonly fields: readonly BasisField[], readonly noise: FieldNoise) {}

  /** The tensor at a point, as (a, b) of [[a, b], [b, -a]]. */
  tensor(x: number, y: number): { a: number; b: number } {
    let a = 0, b = 0;
    for (const f of this.fields) {
      const dx = x - f.x, dy = y - f.y;
      const d2 = dx * dx + dy * dy;
      // Gaussian fall-off: whole inside its radius, gone a radius and a half out.
      const w = f.weight * Math.exp(-d2 / (f.radius * f.radius));
      if (w < 1e-6) continue;
      if (f.kind === 'grid') {
        a += w * Math.cos(2 * f.angle);
        b += w * Math.sin(2 * f.angle);
      } else {
        if (d2 < 1e-6) continue;
        a += (w * (dy * dy - dx * dx)) / d2;
        b += (w * (-2 * dx * dy)) / d2;
      }
    }
    return { a, b };
  }

  /** The way the major streets run at a point (unit), or null where the field vanishes. */
  major(x: number, y: number): Vec2 | null {
    const { a, b } = this.tensor(x, y);
    if (a * a + b * b < 1e-8) return null;
    const turn = this.noise.amount * valueNoise(x / this.noise.scale + this.noise.seed * 0.013, y / this.noise.scale - this.noise.seed * 0.007);
    const phi = Math.atan2(b, a) / 2 + turn;
    return { x: Math.cos(phi), y: Math.sin(phi) };
  }

  /** The way the minor streets run: across the major ones. */
  minor(x: number, y: number): Vec2 | null {
    const d = this.major(x, y);
    return d ? { x: -d.y, y: d.x } : null;
  }

  /** How much the field holds here, 0 where no basis field reaches. */
  strength(x: number, y: number): number {
    const { a, b } = this.tensor(x, y);
    return Math.hypot(a, b);
  }
}

function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 374_761_393) ^ Math.imul(y | 0, 668_265_263);
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 2_147_483_648 - 1;
}

/** Smooth value noise in [-1, 1]. */
export function valueNoise(x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0), b = hash2(x0 + 1, y0), c = hash2(x0, y0 + 1), d = hash2(x0 + 1, y0 + 1);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

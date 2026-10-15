import type { Vec2 } from '@core/vec2';
import { valueNoise } from '../terrain';

/** THE CITY'S GRAIN: the tensor field the streets of a generated city follow. */

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

/** Smooth value noise in [-1, 1]: the land's own (`terrain.ts`), one definition. */
export { valueNoise };

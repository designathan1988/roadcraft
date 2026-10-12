import { describe, expect, it } from 'vitest';

import { computeEcology, type EcologyField, type EcologyInput } from '@world/ecology';
import { valueNoise } from '@world/terrain';

/**
 * A TERRAIN STROKE RE-READS ONLY THE LAND IT MOVED (Etapa 5g). The whole
 * map's ecosystem was read again after every stroke (82 ms), and the
 * countryside's trees could change far from the brush. Read over the stroke's
 * corners and as far as a corner's answer reaches, the field is the one read
 * whole; when the lowest ground moves (every altitude is read from it) the
 * whole field is read again.
 */
const SIDE = 121, CELL = 16;

function land(dig: (ix: number, iy: number) => number): EcologyInput {
  const heights = new Float64Array(SIDE * SIDE);
  const water = new Uint8Array(SIDE * SIDE);
  for (let iy = 0; iy < SIDE; iy++) for (let ix = 0; ix < SIDE; ix++) {
    const i = iy * SIDE + ix;
    heights[i] = 20 + 40 * valueNoise(ix / 17, iy / 13) + 8 * valueNoise(ix / 4, iy / 5) + dig(ix, iy);
    water[i] = heights[i]! < 24 ? 1 : 0;
  }
  return {
    side: SIDE, cell: CELL, heights, water,
    sandstone: new Float32Array(SIDE * SIDE), basalt: new Float32Array(SIDE * SIDE),
    painted: null, settings: { region: 'cerrado', seed: 4242 },
  };
}

const KEYS = ['canopy', 'trees', 'emergent', 'shrub', 'palm', 'cactus', 'grass', 'dry', 'wet', 'rocky', 'region'] as const;
function worst(a: EcologyField, b: EcologyField): number {
  let w = 0;
  for (const k of KEYS) for (let i = 0; i < a[k].length; i++) w = Math.max(w, Math.abs((a[k][i] as number) - (b[k][i] as number)));
  return w;
}

describe('the ecosystem after a terrain stroke', () => {
  it('read over the stroke is the field read whole', () => {
    const before = land(() => 0);
    const field = computeEcology(before);
    const untouched = Float32Array.from(field.canopy);
    // A hill raised over corners 50..62 x 40..55, water unchanged (none there).
    const hill = (ix: number, iy: number): number => (ix >= 50 && ix <= 62 && iy >= 40 && iy <= 55 ? 6 : 0);
    const after = land(hill);
    (after.water as Uint8Array).set(before.water as Uint8Array);
    const updated = computeEcology(after, { previous: field, ix0: 50, ix1: 62, iy0: 40, iy1: 55 });
    const whole = computeEcology(after);
    expect(worst(updated, whole)).toBeLessThan(1e-4);
    // And far from it, nothing moved.
    let farMoved = 0;
    for (let iy = 0; iy < SIDE; iy++) for (let ix = 0; ix < SIDE; ix++) {
      if (ix >= 40 && ix <= 72 && iy >= 30 && iy <= 65) continue;
      if (updated.canopy[iy * SIDE + ix] !== untouched[iy * SIDE + ix]) farMoved++;
    }
    expect(farMoved).toBe(0);
  });

  it('is read whole when the lowest ground moved', () => {
    const before = land(() => 0);
    const field = computeEcology(before);
    const pit = (ix: number, iy: number): number => (ix === 10 && iy === 10 ? -100 : 0);
    const after = land(pit);
    (after.water as Uint8Array).set(before.water as Uint8Array);
    const updated = computeEcology(after, { previous: field, ix0: 10, ix1: 10, iy0: 10, iy1: 10 });
    expect(worst(updated, computeEcology(after))).toBeLessThan(1e-4);
  });
});

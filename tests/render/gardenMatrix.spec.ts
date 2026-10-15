import { readFileSync } from 'node:fs';
import { Object3D } from 'three';
import { describe, expect, it } from 'vitest';

import { yawMatrixInto } from '@render/gardens';

/**
 * A GARDEN PLANT'S MATRIX WITHOUT AN `Object3D` (`gardens.ts` `yawMatrixInto`): the
 * same sixteen numbers three's `updateMatrix` gives for a position, a turn about
 * the up axis and a scale - for every yaw, in float32 as the packs store them.
 */
describe('the matrix of a plant turned about the up axis', () => {
  it('is the matrix three composes for it', () => {
    let seed = 9;
    const rand = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const object = new Object3D();
    const mine = new Float32Array(16), theirs = new Float32Array(16);
    for (let k = 0; k < 2_000; k++) {
      const x = (rand() - 0.5) * 8_000, y = (rand() - 0.5) * 8_000, z = (rand() - 0.5) * 80;
      const yaw = (rand() - 0.5) * 14, sx = 0.2 + rand() * 12, sy = 0.2 + rand() * 12, sz = 0.2 + rand() * 12;
      object.position.set(x, z, -y);
      object.rotation.set(0, yaw, 0);
      object.scale.set(sx, sy, sz);
      object.updateMatrix();
      object.matrix.toArray(theirs);
      yawMatrixInto(mine, 0, x, z, -y, yaw, sx, sy, sz);
      // Numerically equal (a zero may carry either sign).
      for (let i = 0; i < 16; i++) expect(mine[i] === theirs[i], `element ${i} of yaw ${yaw}`).toBe(true);
    }
  });

  it('is what the garden packs use, with no object made for each plant', () => {
    const source = readFileSync('src/render/gardens.ts', 'utf8');
    const pack = source.slice(source.indexOf('const pack = (key'), source.indexOf('const pack = (key') + 900);
    expect(pack).toMatch(/yawMatrixInto\(/);
    expect(pack).not.toMatch(/updateMatrix|new Object3D/);
  });
});

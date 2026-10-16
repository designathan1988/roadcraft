import { readFileSync } from 'node:fs';
import { Object3D } from 'three';
import { describe, expect, it } from 'vitest';

import { yawMatrixInto } from '@render/instanceRuns';

/** A GARDEN PLANT'S MATRIX WITHOUT AN `Object3D` (`instanceRuns.ts` `yawMatrixInto`) */
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

  it('is what the gardens draw with, from poses, with no object made for each plant and no matrix sent', () => {
    const source = readFileSync('src/render/gardens.ts', 'utf8');
    const pack = source.slice(source.indexOf('const pack = (key'), source.indexOf('const pack = (key') + 900);
    expect(pack).toMatch(/poses\[at\] = placement\.x/);
    expect(pack).not.toMatch(/updateMatrix|new Object3D|\.set\(\[/);
    // The pose (`YAW_POSE`) sent as it is, only for a plant drawn at a new position (`cellInstances.ts` `write`); the GPU makes the matrix.
    expect(source).toMatch(/createCellInstances\(kinds, YAW_POSE,/);
    const runs = readFileSync('src/render/instanceRuns.ts', 'utf8');
    const format = runs.slice(runs.indexOf('export const YAW_POSE'), runs.indexOf('/** One mesh of the layer'));
    expect(format).toMatch(/yawMatrixInto\(out, outAt/);
    const cells = readFileSync('src/render/cellInstances.ts', 'utf8');
    const write = cells.slice(cells.indexOf('const write = '), cells.indexOf('const visit = '));
    expect(write).toMatch(/if \(n < b\.capacity && b\.shown\[n\] !== i\)/);
    expect(write).toMatch(/poses\[to \+ j\] = data\[from \+ j\]/);
    expect(write).not.toMatch(/matrixInto|instanceMatrix/);
  });
});

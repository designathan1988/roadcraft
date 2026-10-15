import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { indexArray } from '@render/buildings/cellArrays';
import { newPose, pedPose, pedPoseInto } from '@sim/pose';

/**
 * TWO CHEAP ITEMS OF THE AUDIT OF 2026-10-15, CHECKED IN THE CODE (docs/AUDITORIA-2026-10-15.md 4.4a and 4.9d):
 * a cell's index is 16 bits where its vertices fit (the roads' blocks already were), and a pedestrian's pose is
 * written into a pose made once - the same numbers `pedPose` makes - instead of three objects made for each of
 * the 1,000 drawn, every frame.
 */
describe('a cell\'s index array', () => {
  it('is 16 bits up to 65,535 vertices and 32 beyond', () => {
    expect(indexArray(65_535, 90)).toBeInstanceOf(Uint16Array);
    expect(indexArray(65_536, 90)).toBeInstanceOf(Uint32Array);
    expect(indexArray(0, 0).length).toBe(0);
  });

  it('is what the cells\' masses and shells make', () => {
    const source = readFileSync('src/render/buildings/cellArrays.ts', 'utf8');
    expect(source).not.toMatch(/new Uint32Array\(indices\)[;,]/);
    expect(source.match(/indexArray\(vertices, indices\)/g)).toHaveLength(2);
  });
});

describe('a pedestrian\'s pose written in place', () => {
  const view = (x: number, y: number, px: number, py: number, heading: number, pheading: number): Parameters<typeof pedPose>[0] =>
    ({ x, y, heading, prev: { x: px, y: py, heading: pheading } }) as never;

  it('is the pose `pedPose` makes, to the bit, for every alpha, a jump and a turn through the wrap included', () => {
    const out = newPose();
    let seed = 7;
    const rand = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let k = 0; k < 500; k++) {
      const p = view(rand() * 500, rand() * 500, rand() * 500 + (k % 7 === 0 ? 900 : 0), rand() * 500, (rand() - 0.5) * 7, (rand() - 0.5) * 7);
      const alpha = k % 5 === 0 ? (rand() - 0.5) * 3 : rand();
      const made = pedPose(p, alpha);
      pedPoseInto(p, alpha, out);
      expect(Object.is(out.p.x, made.p.x)).toBe(true);
      expect(Object.is(out.p.y, made.p.y)).toBe(true);
      expect(Object.is(out.angle, made.angle)).toBe(true);
    }
  });

  it('is what the drawing asks, with the one pose the vehicles use', () => {
    const agents = readFileSync('src/render/agents.ts', 'utf8');
    expect(agents).toMatch(/pedPoseInto\(ped, alpha, POSE\);/);
    expect(agents).not.toMatch(/= pedPose\(/);
  });
});

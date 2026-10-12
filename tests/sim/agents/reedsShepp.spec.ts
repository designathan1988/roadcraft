import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import { reedsShepp, sampleReedsShepp } from '@sim/agents/reedsShepp';

/**
 * A REEDS-SHEPP WAY ENDS ON ITS GOAL (`sim/agents/reedsShepp.ts`, after
 * OMPL's ReedsSheppStateSpace): from any pose to any other, the way found
 * driven piece by piece ends at the goal's place and heading, moves no more
 * than a step between two poses, and is no longer than the straight distance
 * plus the turning it must do allows - checked on a thousand pairs.
 */
describe('a Reeds-Shepp way', () => {
  it('ends on the goal, in steps, for any two poses', () => {
    const rng = new Rng(0x5eed);
    const radius = 9.7, step = 0.25;
    for (let k = 0; k < 1000; k++) {
      const a = { x: rng.range(-40, 40), y: rng.range(-40, 40), angle: rng.range(-Math.PI, Math.PI) };
      const b = { x: rng.range(-40, 40), y: rng.range(-40, 40), angle: rng.range(-Math.PI, Math.PI) };
      const path = reedsShepp(a.x, a.y, a.angle, b.x, b.y, b.angle, radius);
      expect(path, `pair ${k}`).not.toBeNull();
      const poses = sampleReedsShepp(path!, a.x, a.y, a.angle, radius, step);
      const end = poses[poses.length - 1]!;
      expect(Math.hypot(end.x - b.x, end.y - b.y), `pair ${k}`).toBeLessThan(1e-6 * radius);
      const turn = Math.atan2(Math.sin(end.angle - b.angle), Math.cos(end.angle - b.angle));
      expect(Math.abs(turn), `pair ${k}`).toBeLessThan(1e-6);
      let prev = a;
      for (const p of poses) {
        expect(Math.hypot(p.x - prev.x, p.y - prev.y)).toBeLessThanOrEqual(step + 1e-9);
        prev = p;
      }
      // The length is at least the straight distance (and the way is no wild detour).
      expect(path!.total * radius).toBeGreaterThanOrEqual(Math.hypot(b.x - a.x, b.y - a.y) - 1e-6);
      expect(path!.total * radius).toBeLessThan(Math.hypot(b.x - a.x, b.y - a.y) + 4 * Math.PI * radius);
    }
  });
});

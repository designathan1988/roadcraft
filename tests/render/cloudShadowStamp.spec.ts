import { describe, expect, it } from 'vitest';
import { Vector3, Vector4 } from 'three';
import { CloudShadowStamp } from '@render/cloudShadowStamp';

/** The clouds' shadow map (`postprocess.ts`) is drawn again only when what it shows would change (RND-11) */

const PUFFS = 7;

function sky(count: number) {
  const bounds = Array.from({ length: 24 }, (_, c) => new Vector4(1000 + c * 400, 900, -2000 + c * 300, 250));
  const puffs = Array.from({ length: 24 * PUFFS }, (_, i) => new Vector4(1000 + i * 30, 880 + (i % 5), -2000 + i * 20, 60 + (i % 3)));
  const lives = Array.from({ length: 24 }, () => 1);
  const bases = Array.from({ length: 24 }, () => 850);
  const shows = Array.from({ length: 24 }, () => 1);
  const sun = new Vector3(0.4, 0.8, 0.3).normalize();
  const rect = new Vector4(500, -2500, 12000, 6000);
  return { count, bounds, puffs, lives, bases, shows, sun, rect, plane: 820 };
}

type Sky = ReturnType<typeof sky>;
const ask = (stamp: CloudShadowStamp, s: Sky): boolean =>
  stamp.changed(s.count, PUFFS, s.bounds, s.puffs, s.lives, s.bases, s.shows, s.sun, s.rect, s.plane);

/** The wind carries every cloud, and the rectangle with them, by (dx, dz). */
function drift(s: Sky, dx: number, dz: number): void {
  for (const b of s.bounds) { b.x += dx; b.z += dz; }
  for (const p of s.puffs) { p.x += dx; p.z += dz; }
  s.rect.x += dx; s.rect.z += dx; s.rect.y += dz; s.rect.w += dz;
}

describe('the clouds\' shadow map', () => {
  it('is drawn once over a still sky, not every frame', () => {
    const stamp = new CloudShadowStamp();
    const s = sky(10);
    let draws = 0;
    for (let frame = 0; frame < 120; frame++) if (ask(stamp, s)) draws++;
    expect(draws).toBe(1);
  });

  it('is not drawn again when the wind carries the clouds and their rectangle together', () => {
    const stamp = new CloudShadowStamp();
    const s = sky(10);
    ask(stamp, s);
    let draws = 0;
    for (let frame = 0; frame < 60; frame++) { drift(s, 0.37, -0.21); if (ask(stamp, s)) draws++; }
    expect(draws).toBe(0);
  });

  it('is drawn again when anything it shows changes', () => {
    const changes: ((s: Sky) => void)[] = [
      (s) => { s.count = 9; },
      (s) => { s.plane += 1; },
      (s) => { s.sun.set(0.5, 0.7, 0.2).normalize(); },
      (s) => { s.rect.z += 50; },
      (s) => { s.bounds[3]!.x += 2; },
      (s) => { s.bounds[3]!.w += 1; },
      (s) => { s.puffs[3 * PUFFS + 2]!.y += 0.5; },
      (s) => { s.puffs[3 * PUFFS + 2]!.w += 0.5; },
      (s) => { s.lives[4] = 0.5; },
      (s) => { s.bases[4] = 851; },
      (s) => { s.shows[9] = 0.8; },
    ];
    for (const change of changes) {
      const stamp = new CloudShadowStamp();
      const s = sky(10);
      ask(stamp, s);
      change(s);
      expect(ask(stamp, s)).toBe(true);
      expect(ask(stamp, s)).toBe(false);
    }
  });

  it('ignores the slots past the clouds counted', () => {
    const stamp = new CloudShadowStamp();
    const s = sky(10);
    ask(stamp, s);
    s.bounds[15]!.x += 100;
    s.shows[20] = 0;
    expect(ask(stamp, s)).toBe(false);
  });

  it('is drawn again after the map is lost', () => {
    const stamp = new CloudShadowStamp();
    const s = sky(10);
    ask(stamp, s);
    stamp.invalidate();
    expect(ask(stamp, s)).toBe(true);
  });
});

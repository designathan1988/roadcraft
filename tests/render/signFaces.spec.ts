import { describe, expect, it } from 'vitest';
import { BLADE_HALF, FACE_OUT, onTopOfPost, plateFaces } from '@render/signs';
import { m } from '@world/units';

/** A SIGN'S FACE IS NEVER CROSSED BY ITS POST (`render/signs.ts` plateFaces). */

/** The post's radius at the top. */
const POST = m(0.04);

describe('the faces of a plate on its post', () => {
  for (const yaw of [0, 0.7, -2.1, Math.PI]) {
    it(`a traffic sign stands clear of the post, looking away from it (yaw ${yaw})`, () => {
      for (const type of ['stop', 'direction', 'info'] as const) {
        expect(onTopOfPost(type)).toBe(false);
        for (const f of plateFaces(type, m(10), m(-4), yaw)) {
          const dx = f.x - m(10), dy = f.y - m(-4);
          // Off the axis by more than the post's radius...
          expect(Math.hypot(dx, dy)).toBeGreaterThan(POST);
          expect(Math.hypot(dx, dy)).toBeCloseTo(FACE_OUT, 9);
          // ...on the side it looks to: the post is behind the face.
          expect(dx * Math.sin(f.yaw) - dy * Math.cos(f.yaw)).toBeGreaterThan(0);
        }
      }
    });
  }

  it('a traffic sign has one face, towards the traffic it faces', () => {
    const [face, ...more] = plateFaces('stop', 0, 0, 0.3);
    expect(more).toHaveLength(0);
    expect(face!.yaw).toBe(0.3);
  });

  it("a street's name is two blades back to back on top of the post, each the right way round", () => {
    expect(onTopOfPost('street')).toBe(true);
    const faces = plateFaces('street', 0, 0, 1.1);
    expect(faces).toHaveLength(2);
    // Opposite ways, each on the side it looks to, a plate's thickness apart
    expect(Math.cos(faces[0]!.yaw - faces[1]!.yaw)).toBeCloseTo(-1, 9);
    for (const f of faces) {
      expect(Math.hypot(f.x, f.y)).toBeCloseTo(BLADE_HALF, 9);
      expect(f.x * Math.sin(f.yaw) - f.y * Math.cos(f.yaw)).toBeGreaterThan(0);
    }
    expect(2 * BLADE_HALF).toBeLessThan(m(0.02));
  });
});

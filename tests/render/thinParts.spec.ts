import { BoxGeometry, BufferGeometry, PlaneGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { twoSided } from '@render/buildings/thinParts';

/** A PART SEEN FROM BOTH SIDES (`thinParts.ts` twoSided): indexed, each face once from the front and once from behind */

/** Each triangle as its three corners' positions and its first normal, in drawing order. */
function triangles(g: BufferGeometry): string[] {
  const p = g.getAttribute('position'), n = g.getAttribute('normal'), index = g.index;
  const count = index ? index.count : p.count;
  const out: string[] = [];
  for (let k = 0; k < count; k += 3) {
    const at = (j: number): number => (index ? index.getX(k + j) : k + j);
    const corner = (j: number): string => [p.getX(at(j)), p.getY(at(j)), p.getZ(at(j))].map((v) => v.toFixed(5)).join(',');
    out.push(`${corner(0)}|${corner(1)}|${corner(2)}|${[n.getX(at(0)), n.getY(at(0)), n.getZ(at(0))].map((v) => v.toFixed(5)).join(',')}`);
  }
  return out;
}

describe('a part seen from both sides', () => {
  it('draws each face from the front, then from behind with its winding and normal turned, on twice the vertices', () => {
    const plane = new PlaneGeometry(1, 0.5);
    const front = triangles(plane);
    const both = twoSided(plane.clone());
    expect(both.index).not.toBeNull();
    expect(both.getAttribute('position').count).toBe(plane.getAttribute('position').count * 2);
    const drawn = triangles(both);
    expect(drawn.slice(0, front.length)).toEqual(front);
    // Behind: corners a, c, b and the normal turned.
    const loose = plane.toNonIndexed();
    const p = loose.getAttribute('position'), n = loose.getAttribute('normal');
    const behind: string[] = [];
    for (let k = 0; k < p.count; k += 3) {
      const corner = (i: number): string => [p.getX(i), p.getY(i), p.getZ(i)].map((v) => v.toFixed(5)).join(',');
      behind.push(`${corner(k)}|${corner(k + 2)}|${corner(k + 1)}|${[-n.getX(k), -n.getY(k), -n.getZ(k)].map((v) => (v === 0 ? 0 : v).toFixed(5)).join(',')}`);
    }
    expect(drawn.slice(front.length).map((t) => t.replace(/-0\.00000/g, '0.00000'))).toEqual(behind.map((t) => t.replace(/-0\.00000/g, '0.00000')));
  });

  it('takes a loose triangle list too', () => {
    const loose = new BoxGeometry(1, 1, 1).toNonIndexed();
    const both = twoSided(loose.clone());
    expect(both.index!.count).toBe(loose.getAttribute('position').count * 2);
    expect(triangles(both).slice(0, loose.getAttribute('position').count / 3)).toEqual(triangles(loose));
  });
});

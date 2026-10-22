import { describe, expect, it } from 'vitest';
import { CylinderGeometry } from 'three';
import { cylinderWith } from '@render/mesh/cylinder';

/** A CYLINDER WITH ONLY THE CAPS THAT ARE SEEN (`render/mesh/cylinder.ts`) */

const triangles = (g: { index: { count: number } | null }): number => g.index!.count / 3;

describe('a cylinder with some caps', () => {
  it('keeps the side and the caps asked for, triangle for triangle', () => {
    const full = new CylinderGeometry(1, 1.08, 2, 16);
    const open = new CylinderGeometry(1, 1.08, 2, 16, 1, true);
    expect(triangles(cylinderWith(1, 1.08, 2, 16, { top: true, bottom: true }))).toBe(triangles(full));
    expect(triangles(cylinderWith(1, 1.08, 2, 16, { top: false, bottom: false }))).toBe(triangles(open));
    // The side (2 x 16) and one cap (16).
    expect(triangles(cylinderWith(1, 1.08, 2, 16, { top: true, bottom: false }))).toBe(48);
  });

  it('keeps no vertex no triangle uses, and the kept cap where it was', () => {
    const g = cylinderWith(0.5, 0.5, 2, 8, { top: true, bottom: false });
    const position = g.getAttribute('position');
    const used = new Set<number>();
    for (let i = 0; i < g.index!.count; i++) used.add(g.index!.getX(i));
    expect(used.size).toBe(position.count);
    let lowest = Infinity, highest = -Infinity;
    for (let v = 0; v < position.count; v++) { lowest = Math.min(lowest, position.getY(v)); highest = Math.max(highest, position.getY(v)); }
    expect([lowest, highest]).toEqual([-1, 1]);
    // No vertex faces down: the bottom cap is gone, the top's faces up.
    const normal = g.getAttribute('normal');
    for (let v = 0; v < normal.count; v++) expect(normal.getY(v)).toBeGreaterThan(-0.5);
    expect(g.getAttribute('uv').count).toBe(position.count);
  });
});

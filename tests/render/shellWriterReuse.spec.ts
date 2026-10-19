import { describe, expect, it } from 'vitest';
import { ShellWriter, emitChunk } from '@render/buildings/buildingMesh';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { m } from '@world/units';

/** PRD-13: a shell writer used again (a cell's buildings one after the other) emits each building as a new writer would, its weld table emptied only where it was used. */
describe('a shell writer used again', () => {
  const ground = (x: number, y: number): number => x * 0.01 - y * 0.02;
  const placed = (i: number): Building => ({ ...JSON.parse(JSON.stringify(BLUEPRINTS[i % BLUEPRINTS.length]!.body)), id: i + 1, x: (i % 5) * m(80), y: Math.floor(i / 5) * m(80), rotation: 0.2 * i } as Building);
  const shells = (chunk: ReturnType<typeof emitChunk>): number[][] =>
    Object.values(chunk.shells).flatMap((s) => [Array.from(s.position), Array.from(s.index), Array.from(s.paint)]);

  it('makes every building after the first bit for bit as a new writer does, the largest first and the small after', () => {
    const buildings = Array.from({ length: BLUEPRINTS.length }, (_, i) => placed(i));
    // The largest first: its table the largest, then many smaller ones on it.
    const size = (b: Building): number => Object.values(emitChunk(b, ground).shells).reduce((n, s) => n + s.position.length, 0);
    buildings.sort((a, b) => size(b) - size(a));
    const writer = new ShellWriter();
    for (const b of buildings) {
      const reused = shells(emitChunk(b, ground, undefined, ground, undefined, false, true, undefined, writer));
      const fresh = shells(emitChunk(b, ground));
      expect(reused).toEqual(fresh);
    }
  });
});

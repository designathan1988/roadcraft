import { describe, expect, it } from 'vitest';

import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { type BuildingChunk, emitChunk } from '@render/buildings/buildingMesh';
import { PartyWalls } from '@render/buildings/partyWalls';
import { m } from '@world/units';

/** A BAY INSIDE A NEIGHBOUR IS NOT LAID; EVERY OTHER BAY IS (`partyWalls.ts`) */

const ground = (x: number, y: number): number => x * 0.01 + y * 0.004;

/** A five-storey block 18 x 12 m, its west corner at (x, 0); `storeys` cut down for a lower one. */
function block(id: number, x: number, storeys?: number): Building {
  const b = { ...JSON.parse(JSON.stringify(BLUEPRINTS[3]!.body)), id, x, y: 0, rotation: 0 } as Building;
  if (storeys !== undefined) b.volumes[0]!.storeys = b.volumes[0]!.storeys.slice(0, storeys);
  return b;
}

const panes = (c: BuildingChunk): number => c.parts.glass.count + c.parts.glassDark.count + c.parts.frame.count;
const emit = (b: Building, list: readonly Building[]): BuildingChunk =>
  emitChunk(b, ground, undefined, ground, undefined, false, true, new PartyWalls(list, ground));

describe('party walls', () => {
  it('lays a building alone as it lays it without neighbours', () => {
    const a = block(1, 0);
    expect(emit(a, [a])).toEqual(emitChunk(a, ground));
  });

  it('leaves out the bays a neighbour stands against, and only those', () => {
    const a = block(1, 0);
    const width = a.volumes[0]!.w;
    const alone = panes(emit(a, [a]));
    const tall = panes(emit(a, [a, block(2, width)]));
    const low = panes(emit(a, [a, block(3, width, 2)]));
    expect(tall).toBeLessThan(alone);
    // A lower neighbour covers the storeys under its eaves only.
    expect(low).toBeGreaterThan(tall);
    expect(low).toBeLessThan(alone);
    // A neighbour a metre away covers nothing.
    expect(panes(emit(a, [a, block(4, width + m(1))]))).toBe(alone);
  });

  it('lays a cut-open neighbour as no cover', () => {
    const a = block(1, 0);
    const cut = { ...block(2, a.volumes[0]!.w), cutaway: 1 } as Building;
    expect(panes(emit(a, [a, cut]))).toBe(panes(emit(a, [a])));
  });
});

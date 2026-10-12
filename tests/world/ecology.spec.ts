import { describe, expect, it } from 'vitest';

import { REGIONS, computeEcology, isNatureSettings, type EcologyInput, type RegionId } from '@world/ecology';

/**
 * A small land: a plateau at 100 with a river valley down the middle column
 * and a cliff along the north edge (rows 0-3 high above the rest).
 */
const SIDE = 41;
const CELL = 16;
function land(region: RegionId, painted: Float32Array | null = null, valleyDepth = 30): EcologyInput {
  const heights = new Float32Array(SIDE * SIDE);
  const water = new Uint8Array(SIDE * SIDE);
  for (let iy = 0; iy < SIDE; iy++) {
    for (let ix = 0; ix < SIDE; ix++) {
      const i = iy * SIDE + ix;
      const fromRiver = Math.abs(ix - 20);
      // A valley 6 cells wide each side, 30 units deep at the river.
      let h = 100 - Math.max(0, valleyDepth * (1 - fromRiver / 6));
      // The cliff: rows 0-3 stand 120 units over the plateau, a wall at row 4.
      if (iy <= 3) h += 120;
      heights[i] = h;
      water[i] = fromRiver === 0 && iy > 6 ? 1 : 0;
    }
  }
  return {
    side: SIDE, cell: CELL, heights, water,
    sandstone: new Float32Array(SIDE * SIDE), basalt: new Float32Array(SIDE * SIDE),
    painted, settings: { region, seed: 1234 },
  };
}
const at = (ix: number, iy: number): number => iy * SIDE + ix;

describe('ecology', () => {
  it('is the same land every time it is read', () => {
    const a = computeEcology(land('cerrado'));
    const b = computeEcology(land('cerrado'));
    for (const key of ['canopy', 'trees', 'shrub', 'palm', 'grass', 'dry', 'wet', 'rocky'] as const) {
      expect(Array.from(a[key])).toEqual(Array.from(b[key]));
    }
  });

  it('grows a gallery forest along a cerrado river and savanna on the plateau', () => {
    const eco = computeEcology(land('cerrado'));
    // Beside the river (one cell off it, not in the water).
    expect(eco.canopy[at(21, 20)]).toBeGreaterThan(0.6);
    // On the plateau far from the river: open, dry, grassy.
    const plateau = at(36, 30);
    expect(eco.canopy[plateau]).toBeLessThan(0.35);
    expect(eco.grass[plateau]).toBeGreaterThan(0.7);
    expect(eco.dry[plateau]).toBeGreaterThan(0.5);
    // Nothing roots in the water.
    expect(eco.canopy[at(20, 20)]).toBe(0);
  });

  it('leaves a cliff bare of trees', () => {
    const eco = computeEcology(land('atlantic'));
    // Row 4 and 3: the wall between the cliff top and the plateau.
    const wall = at(36, 3);
    expect(eco.canopy[wall]! + eco.trees[wall]!).toBeLessThan(0.35);
    // The forest is everywhere else.
    expect(eco.canopy[at(36, 30)]).toBeGreaterThan(0.6);
  });

  it('gives the caatinga its cacti and bare dry ground', () => {
    const eco = computeEcology(land('caatinga'));
    const scrub = at(36, 30);
    expect(eco.cactus[scrub]).toBeGreaterThan(0.1);
    expect(eco.grass[scrub]).toBeLessThan(0.6);
    expect(eco.dry[scrub]).toBeGreaterThan(0.8);
  });

  it('floods the pantanal flats', () => {
    // The pantanal is flat: a valley 4 units deep.
    const eco = computeEcology(land('pantanal', null, 4));
    // The valley floor next to the river, level and low.
    let wet = 0;
    for (let iy = 10; iy < 36; iy++) wet = Math.max(wet, eco.wet[at(22, iy)]!);
    expect(wet).toBeGreaterThan(0.3);
  });

  it('lets a painted biome take over the map region where it is painted', () => {
    const painted = new Float32Array(SIDE * SIDE * REGIONS.length);
    const amazon = REGIONS.indexOf('amazon');
    for (let iy = 20; iy < 41; iy++) for (let ix = 28; ix < 41; ix++) painted[at(ix, iy) * REGIONS.length + amazon] = 1;
    const eco = computeEcology(land('cerrado', painted));
    expect(eco.region[at(36, 30)]).toBe(amazon);
    expect(eco.canopy[at(36, 30)]).toBeGreaterThan(0.8);
    // Unpainted ground keeps the map's own biome.
    expect(eco.region[at(8, 30)]).toBe(REGIONS.indexOf('cerrado'));
  });

  it('accepts only a known biome and a finite seed', () => {
    expect(isNatureSettings({ region: 'pampa', seed: 3 })).toBe(true);
    expect(isNatureSettings({ region: 'tundra', seed: 3 })).toBe(false);
    expect(isNatureSettings({ region: 'pampa', seed: Number.NaN })).toBe(false);
  });
});

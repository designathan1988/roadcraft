import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CITIZEN_LEVEL_ERROR, citizenBandAt, citizenLevelAt, citizenLevelFor } from '@render/riggedCitizens';
import { m, perM } from '@world/units';

describe('the level a body is drawn at', () => {
  it('knows the error every level of a body was simplified to', () => {
    // `LOD_LEVELS` is in the cook's fingerprinted folder, so it is read, not imported.
    const source = readFileSync('src/render/people/personRig.ts', 'utf8');
    const table = /const LOD_LEVELS[^=]*=\s*(\[[^;]*\]);/.exec(source)?.[1];
    expect(table).toBeDefined();
    const errors = [...table!.matchAll(/\[\s*[\d.]+\s*,\s*([\d.]+)/g)].map((hit) => Number(hit[1]));
    expect([0, ...errors]).toEqual([...CITIZEN_LEVEL_ERROR]);
  });

  it('is the coarsest whose error stays under a pixel', () => {
    const tall = m(1.9);
    for (let zoom = 0.1; zoom < 80; zoom *= 1.07) {
      const level = citizenLevelAt(zoom);
      expect(CITIZEN_LEVEL_ERROR[level]! * tall * zoom).toBeLessThanOrEqual(1);
      if (level > 0) expect(CITIZEN_LEVEL_ERROR[level - 1]! * tall * zoom).toBeLessThanOrEqual(1);
      if (level < CITIZEN_LEVEL_ERROR.length - 1) expect(CITIZEN_LEVEL_ERROR[level + 1]! * tall * zoom).toBeGreaterThan(1);
    }
  });

  it('never gets finer as the camera pulls back', () => {
    let last = 0;
    for (let zoom = 80; zoom > 0.1; zoom /= 1.05) {
      const level = citizenLevelAt(zoom);
      expect(level).toBeGreaterThanOrEqual(last);
      last = level;
    }
  });

  it('keeps the whole body wherever the face is drawn, and is never finer than it was by the fixed zooms', () => {
    const fixed = (zoom: number): number => zoom >= 8 ? 0 : zoom >= 2 ? 1 : zoom >= 1.2 ? 2 : 3;
    for (let zoom = 0.1; zoom < 80; zoom *= 1.07) {
      if (citizenBandAt(zoom) === 0) expect(citizenLevelFor(zoom)).toBe(0);
      else expect(citizenLevelFor(zoom)).toBe(citizenLevelAt(zoom));
      expect(citizenLevelFor(zoom)).toBeGreaterThanOrEqual(fixed(zoom));
    }
  });

  it('keeps what a body does at the zooms it always switched at', () => {
    // Pixels a metre: 75, 20 and 19.75, 5 and 4.75, 3 and 2.75.
    expect([75, 20, 19.75, 5, 4.75, 3, 2.75].map((pxPerM) => citizenBandAt(perM(pxPerM)))).toEqual([0, 0, 1, 1, 2, 2, 3]);
  });
});

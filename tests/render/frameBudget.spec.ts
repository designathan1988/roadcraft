import { describe, expect, it } from 'vitest';
import { createBuildingKit } from '@render/buildings/kit';
import { cellMass } from '@render/buildings/cellArrays';
import { ERROR_STEP, FrameScale, GAIN, LandedMeasure, MOST_ERROR_SCALE, MOST_TIME_SCALE, TIME_SLACK, TimeGovernor, fitErrorScale, letGoPassed } from '@render/buildings/frameBudget';
import { createMassCells } from '@render/buildings/massCells';
import { emitMassing } from '@render/buildings/massing';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { m } from '@world/units';

/** THE LEVELS FIT THE FRAME'S BUDGET OF TRIANGLES (`frameBudget.ts`): the error scale rises until they do, comes down while there is room, and every chooser reads it */

describe('the error scale that fits the budget', () => {
  // A count that falls with the scale, as the levels chosen coarser do.
  const count = (scale: number): number => Math.round(1000 / scale);

  it('rises step by step until the count fits, and no further', () => {
    const k = fitErrorScale(1, 1, 400, count);
    expect(count(k)).toBeLessThanOrEqual(400);
    expect(count(k / ERROR_STEP)).toBeGreaterThan(400);
  });

  it('comes down one step a call while there is room, never under the floor', () => {
    const high = fitErrorScale(4, 1, 2000, count);
    expect(high).toBeCloseTo(4 / ERROR_STEP, 6);
    expect(fitErrorScale(2, 2, 2000, count)).toBe(2);
    expect(fitErrorScale(1, 3, 2000, count)).toBe(3);
  });

  it('keeps the scale it chose last: a step finer that does not fit is undone', () => {
    const chosen: number[] = [];
    const tight = (scale: number): number => { chosen.push(scale); return scale >= 2 ? 500 : 2000; };
    // From 2: under the slack (500 <= 0.6 * 1000), 1.6 tried and refused, 2 chosen again.
    expect(fitErrorScale(2, 1, 1000, tight)).toBe(2);
    expect(chosen.at(-1)).toBe(2);
  });

  it('stops at the coarsest scale when nothing fits', () => {
    expect(fitErrorScale(1, 1, 0, count)).toBe(MOST_ERROR_SCALE);
  });
});

describe("the frame's scale and the floor the time sets", () => {
  const count = (scale: number): number => Math.round(1000 / scale);

  it('the floor steps up from what is drawn, stops at the coarsest the time may ask, and comes down to 1', () => {
    const f = new FrameScale();
    f.budget = 400;
    f.fit(count);
    expect(count(f.scale)).toBeLessThanOrEqual(400);
    // A floor under the scale chosen would change nothing: the step is taken from the scale drawn.
    expect(f.press(true)).toBe(true);
    expect(f.floor).toBeCloseTo(f.scale * ERROR_STEP, 6);
    while (f.press(true));
    expect(f.floor).toBe(MOST_TIME_SCALE);
    expect(f.press(true)).toBe(false);
    expect(f.press(false)).toBe(true);
    expect(f.floor).toBeCloseTo(MOST_TIME_SCALE / ERROR_STEP, 6);
    while (f.press(false));
    expect(f.floor).toBe(1);
    expect(f.press(false)).toBe(false);
  });

  it('the scale never goes under the floor', () => {
    const f = new FrameScale();
    f.fit(count);
    expect(f.scale).toBe(1);
    f.press(true);
    f.fit(count);
    expect(f.scale).toBe(f.floor);
  });
});

describe('what a level is reckoned to draw', () => {
  it('as it measured, else the mean of its kind landed, else the typical of its kind', () => {
    const t = new LandedMeasure<'cell' | 'facade'>({ cell: 600, facade: 300 });
    expect(t.of('cell', '0,0')).toBe(600);
    expect(t.of('facade', '0,0')).toBe(300);
    t.set('cell', '0,0', 100);
    t.set('cell', '1,0', 300);
    expect(t.of('cell', '0,0')).toBe(100);
    expect(t.of('cell', '2,0')).toBe(200);
    expect(t.of('facade', '2,0')).toBe(300);
    // Landed again: the mean follows the last measure, not both.
    t.set('cell', '0,0', 500);
    expect(t.of('cell', '2,0')).toBe(400);
  });
});

const CELL = m(256);

/** Five cells in a row east of the origin, each with a building's masses, seen from above at 10 px a metre. */
function row(): ReturnType<typeof createMassCells> {
  const cells = createMassCells(createBuildingKit(), CELL);
  for (let i = 0; i < 5; i++) {
    const bp = BLUEPRINTS[0]!;
    const b = { ...JSON.parse(JSON.stringify(bp.body)), id: i + 1, x: (i + 0.5) * CELL, y: CELL / 2, rotation: 0 } as Building;
    cells.land(`${i},0`, cellMass([emitMassing(b, () => 0)!]));
  }
  return cells;
}

describe('the cells at an error scale', () => {
  it('at 1: near and at full detail (1.5 m spans 15 px, 0.3 m spans 3 px, 2 px allowed)', () => {
    const cells = row();
    cells.choose(CELL / 2, CELL / 2, m(300), 1000, 10, false, Infinity);
    for (let i = 0; i < 5; i++) expect([cells.near(`${i},0`), cells.fine(`${i},0`)]).toEqual([true, true]);
    cells.dispose();
  });

  it('at 7: near at their facade level (14 px allowed: the detail no longer resolves, the facade level does)', () => {
    const cells = row();
    cells.setErrorScale(7);
    cells.choose(CELL / 2, CELL / 2, m(300), 1000, 10, false, Infinity);
    for (let i = 0; i < 5; i++) expect([cells.near(`${i},0`), cells.fine(`${i},0`)]).toEqual([true, false]);
    cells.dispose();
  });

  it('at 9: far, their masses standing for them (18 px allowed, 15.3 with the hysteresis of a cell near, 15 spanned)', () => {
    const cells = row();
    cells.choose(CELL / 2, CELL / 2, m(300), 1000, 10, false, Infinity);
    cells.setErrorScale(9);
    cells.choose(CELL / 2, CELL / 2, m(300), 1000, 10, false, Infinity);
    for (let i = 0; i < 5; i++) expect(cells.near(`${i},0`)).toBe(false);
    cells.dispose();
  });
});

describe("the GPU's time governing the floor", () => {
  /** A press log: what the governor asked, in order; `left` steps up before the coarsest. */
  const pressing = (left = 8) => {
    const asked: boolean[] = [];
    return { asked, press: (up: boolean): boolean => { asked.push(up); if (up && left <= 0) return false; left += up ? -1 : 1; return true; } };
  };

  it('past OVER times the budget: a step up, a window to settle, kept when the time fell by the gain', () => {
    const g = new TimeGovernor();
    const { asked, press } = pressing();
    g.read(40, 12, press);
    expect(asked).toEqual([true]);
    g.read(40, 12, press);
    expect(asked).toEqual([true]);
    g.read(40 * (1 - GAIN) - 0.1, 12, press);
    expect(asked).toEqual([true, true]);
  });

  it('a step that did not pay is undone, and none is tried again under that time', () => {
    const g = new TimeGovernor();
    const { asked, press } = pressing();
    g.read(40, 12, press);
    g.read(40, 12, press);
    g.read(39, 12, press);
    expect(asked).toEqual([true, false]);
    for (let i = 0; i < 5; i++) g.read(40, 12, press);
    expect(asked).toEqual([true, false]);
    // Slower than then by the gain: something changed, tried again.
    g.read(40 * (1 + GAIN) + 0.1, 12, press);
    expect(asked).toEqual([true, false, true]);
  });

  it('well under the budget: a step down, and the vain mark forgotten', () => {
    const g = new TimeGovernor();
    const { asked, press } = pressing();
    g.read(40, 12, press); g.read(40, 12, press); g.read(40, 12, press);
    expect(asked).toEqual([true, false]);
    g.read(12 * TIME_SLACK - 0.1, 12, press);
    expect(asked).toEqual([true, false, false]);
    g.read(40, 12, press);
    expect(asked).toEqual([true, false, false, true]);
  });

  it('between the slack and OVER times the budget nothing moves; a view change forgets the vain mark', () => {
    const g = new TimeGovernor();
    const { asked, press } = pressing();
    g.read(20, 12, press);
    expect(asked).toEqual([]);
    g.read(40, 12, press); g.read(40, 12, press); g.read(40, 12, press);
    expect(asked).toEqual([true, false]);
    g.reset();
    g.read(40, 12, press);
    expect(asked).toEqual([true, false, true]);
  });

  it('at the coarsest floor nothing is asked for a window to settle', () => {
    const g = new TimeGovernor();
    const { asked, press } = pressing(0);
    g.read(40, 12, press);
    g.read(40, 12, press);
    expect(asked).toEqual([true, true]);
  });
});

describe('the cells held back by the budget', () => {
  // Five cells in a row; the eye over the first, then over the last.
  const away = (eyeAt: number) => (key: string): number => Math.abs(Number(key.split(',')[0]) - eyeAt) * 256;

  it('stay held while the cells kept are nearer the eye', () => {
    const far = new Set(['3,0', '4,0']), coarse = new Set(['2,0']);
    letGoPassed(far, coarse, [{ key: '0,0', fine: true }, { key: '1,0', fine: true }, { key: '2,0', fine: false }], away(0));
    expect([...far]).toEqual(['3,0', '4,0']);
    expect([...coarse]).toEqual(['2,0']);
  });

  it('are let go once the eye is nearer them than a cell kept: the one at the camera is drawn in detail again', () => {
    // Held from over the first cell; the eye went down over the last.
    const far = new Set(['3,0', '4,0']), coarse = new Set(['2,0']);
    letGoPassed(far, coarse, [{ key: '0,0', fine: true }, { key: '1,0', fine: true }, { key: '2,0', fine: false }], away(4));
    expect([...far]).toEqual([]);
    expect([...coarse]).toEqual([]);
  });
});

describe('a level never landed, reckoned in bytes', () => {
  it('counts as its kind\'s landed do on average, and before any landed as nothing known (its cell\'s masses then)', async () => {
    const { LandedMeasure: Measure } = await import('@render/buildings/frameBudget');
    const bytes = new Measure<'cell' | 'facade'>({ cell: Number.NaN, facade: Number.NaN });
    expect(Number.isNaN(bytes.of('facade', '3,4'))).toBe(true);
    bytes.set('facade', '0,0', 4_000_000);
    bytes.set('facade', '1,0', 6_000_000);
    // Never the cell kind's for a facade level, never a fixed number.
    expect(bytes.of('facade', '3,4')).toBe(5_000_000);
    expect(Number.isNaN(bytes.of('cell', '3,4'))).toBe(true);
    expect(bytes.of('facade', '1,0')).toBe(6_000_000);
    const { readFileSync } = await import('node:fs');
    const layer = readFileSync('src/render/buildings/layer.ts', 'utf8');
    const cap = layer.slice(layer.indexOf('const capNow'), layer.indexOf('const capNow') + 500);
    expect(cap).toMatch(/landedBytes\.of\(kind, key\)/);
    expect(cap).toMatch(/Number\.isNaN\(mean\) \? massCells\.massBytes\(key\) : mean/);
  });
});

describe('what a level is reckoned to draw', () => {
  it('before any of its kind landed: a dense cell\'s detail and facade level with their parts, as measured', async () => {
    const { TYPICAL_LEVEL_TRIANGLES } = await import('@render/buildings/frameBudget');
    expect(TYPICAL_LEVEL_TRIANGLES).toEqual({ cell: 1_300_000, facade: 600_000 });
  });

  it('once landed: measured with its parts chosen (`cullDetails`), not as it lands with none chosen yet', async () => {
    const { readFileSync } = await import('node:fs');
    const layer = readFileSync('src/render/buildings/layer.ts', 'utf8');
    const cull = layer.slice(layer.indexOf('    cullDetails(eyeX'), layer.indexOf('    cullDetails(eyeX') + 1200);
    expect(cull).toMatch(/cell\.choose\(partView\);[\s\S]*landedTriangles\.set\(kind, key, level\.triangles \+ cell\.triangles\)/);
  });
});

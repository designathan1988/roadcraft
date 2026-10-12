import { describe, expect, it } from 'vitest';
import { TILES_PER_SIDE } from '@core/planetTiles';
import { tileCentre } from '@world/planet/atlas';
import { chartAt, inChart, toOwner } from '@world/planet/charts';
import { RELIEF_FLAT, TerrainIndex, sampleTerrainHeight, type TerrainStamp } from '@world/terrain';
import { borderAlong } from './_border';
import { m } from '@world/units';

/**
 * A ROUGH DAB RAISES THE SAME HILL ON BOTH SIDES OF A BORDER
 * (`world/terrain.ts` TerrainStamp.ox; `render/planet/terrainAtlas.ts`
 * copyOn). Each piece's plate samples the land on its own map, the dabs
 * reaching it copied onto that map. The brush's rough noise was measured
 * from the sampled point itself, which two maps number differently: a
 * stroke over a border raised two different hills, a step of up to 4 m along
 * it (the tools over a border, 2026-10-11). Measured from an origin the dab
 * carries - copied with it - the two agree. Run with `vitest.planet.config.ts`.
 */

const west = 2 * TILES_PER_SIDE * TILES_PER_SIDE + 5 * TILES_PER_SIDE + 5;
const c = tileCentre(west);
const border = { x: c.x + borderAlong(west, 1, 0), y: c.y };

/** A dab written on the piece east of the border (as the brush writes it there), copied onto `chart` as the atlas does. */
function onChart(stamp: TerrainStamp, chart: number): TerrainStamp {
  const at = inChart(chart, stamp);
  const origin = stamp.ox !== undefined && stamp.oy !== undefined ? inChart(chart, { x: stamp.ox, y: stamp.oy }) : null;
  return { ...stamp, x: at.x, y: at.y, ...(origin ? { ox: origin.x, oy: origin.y } : {}) };
}

/** The dab alone, on flat land: the planet's own land is read on the sphere and agrees across a border (`planet/relief.ts`). */
const flat = (stamp: TerrainStamp): TerrainIndex => new TerrainIndex([stamp], 1, RELIEF_FLAT);

/** The most the land differs across the border, sampled on each side's own map, over a run along it. */
function worstStep(stamp: TerrainStamp): number {
  const westChart = west;
  const over = toOwner(west, { x: border.x + m(1), y: border.y });
  const east = chartAt(over.x, over.y);
  const onEast = onChart(stamp, east), onWest = onChart(stamp, westChart);
  let worst = 0;
  for (let dy = -m(100); dy <= m(40); dy += m(2)) {
    // Where the border is at this height (it leans on a piece's map): bisected on the west map.
    let lo = border.x - m(40), hi = border.x + m(40);
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      const p = toOwner(westChart, { x: mid, y: border.y + dy });
      if (chartAt(p.x, p.y) === westChart) lo = mid; else hi = mid;
    }
    // The same ground a hair west and a hair east of it, each on its own piece's map.
    const a = toOwner(westChart, { x: lo - m(0.05), y: border.y + dy });
    const b = toOwner(westChart, { x: hi + m(0.05), y: border.y + dy });
    if (chartAt(a.x, a.y) !== westChart || chartAt(b.x, b.y) !== east) continue;
    const hWest = sampleTerrainHeight(flat(onWest), a.x, a.y);
    const hEast = sampleTerrainHeight(flat(onEast), b.x, b.y);
    worst = Math.max(worst, Math.abs(hWest - hEast));
  }
  return worst;
}

describe('a rough dab over a border between pieces', () => {
  // The brush's dab just east of the border, written on the east piece's map
  // (the border point is on the west piece's: `toOwner` writes it on its own).
  const centre = toOwner(west, { x: border.x + m(4), y: border.y - m(34) });
  const base: TerrainStamp = { id: 1, x: centre.x, y: centre.y, radius: m(80), strength: m(24), mode: 'raise', rough: true, stroke: 1 };

  it('raises one hill on both sides when it carries its noise origin', () => {
    // Its stroke began 20 m west of it, back over the border: the origin written on the dab's map.
    const start = toOwner(west, { x: border.x - m(16), y: border.y - m(28) });
    const origin = inChart(chartAt(centre.x, centre.y), start);
    const stamp = { ...base, ox: origin.x, oy: origin.y };
    // The land is a few centimetres apart over the 10 cm between the two samples, no more.
    expect(worstStep(stamp)).toBeLessThan(m(0.1));
  });

  it('raised two hills with the noise measured from the map itself (the defect)', () => {
    expect(worstStep(base)).toBeGreaterThan(m(0.5));
  });
});

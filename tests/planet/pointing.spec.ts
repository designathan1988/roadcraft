import { describe, expect, it } from 'vitest';
import { U, borderShift } from './_border';
import type { Vec2 } from '@core/vec2';
import { TILES_PER_SIDE } from '@core/planetTiles';
import { tileCentre } from '@world/planet/atlas';
import { chartAt, inChart, onChartOf, ownPointer, ownShape, setPointerChart, toOwner } from '@world/planet/charts';
import { insideLot } from '@world/lots';

/**
 * POINTING AT WHAT IS STORED, ON THE PLANET (`world/planet/charts.ts`
 * `onChartOf`, `ownPointer`, `ownShape`). Run with `vitest.planet.config.ts`.
 *
 * Every shape is kept on its own piece's chart; a point read on another
 * chart was never inside it (the zone brush stopped at the first border),
 * and a pointer point read three pieces out on the gesture's chart lay in
 * another piece's cell of the atlas (it stopped at the second).
 */

const chart = 2 * TILES_PER_SIDE * TILES_PER_SIDE + 5 * TILES_PER_SIDE + 5;
const c = tileCentre(chart);
// Moved out as the border moved (`_border.ts`).
const shift = borderShift(chart, 1, 0);
// The scenes in 0.4 m units, times U.
const at = (x: number, y: number): Vec2 => ({ x: c.x + x * U + shift, y: c.y + y * U });

describe('pointing across the pieces of the planet', () => {
  it('finds a lot kept on one chart from a point written on the next', () => {
    // A lot 40 x 30 straddling the piece's east border, kept on this chart.
    const lot = { corners: [at(230, -15), at(270, -15), at(270, 15), at(230, 15)] };
    const inside = toOwner(chart, at(262, 3));
    expect(chartAt(inside.x, inside.y)).not.toBe(chart);
    expect(insideLot(inside, lot)).toBe(true);
    const outside = toOwner(chart, at(285, 3));
    expect(insideLot(outside, lot)).toBe(false);
  });

  it('carries a point onto the chart of a stored one, and leaves it when they share one', () => {
    const p = toOwner(chart, at(300, 40));
    const q = onChartOf(p, at(0, 0));
    expect(Math.hypot(q.x - (c.x + 300 * U + shift), q.y - (c.y + 40 * U))).toBeLessThan(1e-6);
    const same = at(10, 10);
    expect(onChartOf(same, at(0, 0))).toBe(same);
  });

  it('gives a pointer point read far out on the gesture chart to the piece it lies on', () => {
    setPointerChart(chart);
    try {
      // Three pieces east: past this chart's cell of the atlas.
      const far = at(1500, 20);
      const own = ownPointer(far);
      const back = inChart(chart, own);
      expect(Math.hypot(back.x - far.x, back.y - far.y)).toBeLessThan(1e-6);
      expect(chartAt(own.x, own.y)).not.toBe(chartAt(far.x, far.y));
    } finally {
      setPointerChart(-1);
    }
  });

  it('keeps a drawn shape whole on the chart of the piece under its middle', () => {
    const drawn = [at(400, -10), at(440, -10), at(440, 20), at(400, 20)];
    const kept = ownShape(chart, drawn);
    const owner = chartAt(kept[0]!.x, kept[0]!.y);
    for (const p of kept) expect(chartAt(p.x, p.y)).toBe(owner);
    // The same ground: each corner back on the drawing chart where it was drawn.
    kept.forEach((p, i) => {
      const back = inChart(chart, p);
      expect(Math.hypot(back.x - drawn[i]!.x, back.y - drawn[i]!.y)).toBeLessThan(1e-6);
    });
  });
});

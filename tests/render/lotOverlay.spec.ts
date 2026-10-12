import { describe, expect, it } from 'vitest';
import { Scene } from 'three';
import { createLotOverlay, type LotOverlayInput } from '@render/lotOverlay';
import { ChangeJournal } from '@world/changes';
import { TUNED_UNIT } from '@world/units';

/** The 0.4 m unit these scenes were laid out in: lengths below in it, times U. */
const U = TUNED_UNIT;

/**
 * A LOT CHANGED LAYS ONE LOT AGAIN (performance audit M1, 2026-10-09).
 *
 * Every building grown, every brush stroke of the zoning laid all the town's
 * lots on the ground again - each vertex asking the ground's height: 1.7 s
 * for 468 lots, the game at 1-3 frames a second while a zone grew. Now only
 * the polygons that changed, or whose ground moved (the diary), are laid.
 */

function lots(n: number, zonedAt = -1): LotOverlayInput {
  const polygons = Array.from({ length: n }, (_, i) => {
    const x = (i % 20) * 60 * U, y = Math.floor(i / 20) * 80 * U;
    return {
      corners: [{ x, y }, { x: x + 55 * U, y }, { x: x + 55 * U, y: y + 75 * U }, { x, y: y + 75 * U }],
      fill: i === zonedAt ? 0x56bb73 : null, fillAlpha: i === zonedAt ? 0.45 : 0, line: 0xffffff, lineAlpha: 0.85, width: 0.35 * U,
    };
  });
  return { key: `${n}:${zonedAt}`, polygons, lines: [], points: [] };
}

describe('lot overlay', () => {
  it('lays again only the lot that changed', () => {
    let asked = 0;
    const overlay = createLotOverlay(new Scene(), () => { asked++; return 0; });
    const changes = new ChangeJournal();
    overlay.set(lots(200), changes);
    const all = asked;
    expect(all).toBeGreaterThan(0);
    asked = 0;
    // One lot zoned: its fill appears.
    overlay.set(lots(200, 37), changes);
    expect(asked).toBeLessThan(all / 20);
    asked = 0;
    // Nothing changed: nothing laid.
    overlay.set(lots(200, 37), changes);
    expect(asked).toBe(0);
  });

  it('lays again the lots whose ground moved', () => {
    let asked = 0;
    const overlay = createLotOverlay(new Scene(), () => { asked++; return 0; });
    const changes = new ChangeJournal();
    overlay.set(lots(200), changes);
    const all = asked;
    asked = 0;
    // The ground reshaped round one lot (a building grown there).
    changes.record('buildings', [[0, 0, 50 * U, 70 * U]]);
    overlay.set(lots(200), changes);
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThan(all / 50);
  });
});

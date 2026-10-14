import { describe, expect, it, vi } from 'vitest';
import { type Mesh, Scene } from 'three';
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

/** Every slice of a lay, as the frames that follow would (`set` is true while lots are left). */
function layAll(overlay: ReturnType<typeof createLotOverlay>, input: LotOverlayInput, changes: ChangeJournal): number {
  let frames = 1;
  while (overlay.set(input, changes)) if (++frames > 10_000) throw new Error('the lay never ended');
  return frames;
}

/** Vertices drawn by an overlay's meshes. */
function drawn(scene: Scene): number {
  const group = scene.getObjectByName('lot-overlay');
  return (group?.children ?? []).reduce((n, o) => n + (o as Mesh).geometry.getAttribute('position').count, 0);
}

describe('lot overlay', () => {
  it('lays a big town a slice a frame, all of it in the end', () => {
    // The overlay's clock is the test's own: 20 microseconds a point of
    // ground asked, so 400 lots outlast a frame's slice (work counted, not timed).
    let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    try {
      const scene = new Scene();
      const slow = createLotOverlay(scene, () => { clock += 0.02; return 0; });
      const frames = layAll(slow, lots(400, 7), new ChangeJournal());
      expect(frames).toBeGreaterThan(1);
      const whole = new Scene();
      layAll(createLotOverlay(whole, () => 0), lots(400, 7), new ChangeJournal());
      expect(drawn(scene)).toBe(drawn(whole));
      expect(drawn(scene)).toBeGreaterThan(0);
    } finally {
      now.mockRestore();
    }
  });

  it('lays again only the lot that changed', () => {
    let asked = 0;
    const overlay = createLotOverlay(new Scene(), () => { asked++; return 0; });
    const changes = new ChangeJournal();
    layAll(overlay, lots(200), changes);
    const all = asked;
    expect(all).toBeGreaterThan(0);
    asked = 0;
    // One lot zoned: its fill appears.
    layAll(overlay, lots(200, 37), changes);
    expect(asked).toBeLessThan(all / 20);
    asked = 0;
    // Nothing changed: nothing laid.
    layAll(overlay, lots(200, 37), changes);
    expect(asked).toBe(0);
  });

  it('lays again the lots whose ground moved', () => {
    let asked = 0;
    const overlay = createLotOverlay(new Scene(), () => { asked++; return 0; });
    const changes = new ChangeJournal();
    layAll(overlay, lots(200), changes);
    const all = asked;
    asked = 0;
    // The ground reshaped round one lot: a building's pad levelled there
    // (`renderer.ts` `shapeGround` writes it as 'ground').
    changes.record('ground', [[0, 0, 50 * U, 70 * U]]);
    layAll(overlay, lots(200), changes);
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThan(all / 50);
  });

  it('lays no lot again for a building that moved no ground', () => {
    let asked = 0;
    const overlay = createLotOverlay(new Scene(), () => { asked++; return 0; });
    const changes = new ChangeJournal();
    layAll(overlay, lots(200), changes);
    asked = 0;
    // A generated city wrote one of these a building: 3 000 lots laid again in 25 s (2026-10-14).
    changes.record('buildings', [[0, 0, 50 * U, 70 * U]]);
    layAll(overlay, lots(200), changes);
    expect(asked).toBe(0);
  });
});

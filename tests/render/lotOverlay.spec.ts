import { describe, expect, it } from 'vitest';
import { createLotOverlay, type LotOverlayInput } from '@render/lotOverlay';
import { ChangeJournal } from '@world/changes';
import { sampleLattice } from './support/latticeSampler';

/**
 * THE LOTS COLOURED INTO THE GROUND (`render/lotOverlay.ts`).
 *
 * Laid as geometry on the ground, a town's lots were 3.5 million vertices,
 * each asking the ground's height: 1.3 s, then spread over frames
 * (`LAY_SLICE_MS`) so it would not hold one (OTIMIZACAO.md item 20). Now the
 * lots are 2D shapes in a lattice the ground's shaders read: all of them
 * there from the first frame, an edit rewriting only the cells it touches,
 * and nothing asked of the ground.
 */

function lots(n: number, zonedAt = -1, hovered = -1): LotOverlayInput {
  const polygons = Array.from({ length: n }, (_, i) => {
    const x = (i % 20) * 24, y = Math.floor(i / 20) * 32;
    return {
      corners: [{ x, y }, { x: x + 22, y }, { x: x + 22, y: y + 30 }, { x, y: y + 30 }],
      fill: i === zonedAt ? 0x56bb73 : null, fillAlpha: i === zonedAt ? 0.45 : 0,
      line: i === hovered ? 0xffd25e : 0xffffff, lineAlpha: 0.85, width: i === hovered ? 0.7 : 0.35,
    };
  });
  const lines = polygons.map((p) => ({ a: p.corners[0]!, b: p.corners[1]!, colour: 0x5ee0ff, dashed: false, width: 0.8 }));
  return { key: `${n}:${zonedAt}:${hovered}`, polygons, lines, points: [] };
}

describe('lot overlay', () => {
  it('draws every lot at once, from the first call', () => {
    const overlay = createLotOverlay();
    overlay.set(lots(400, 7));
    // 400 outlines, 400 front lines.
    expect(overlay.lattice.size).toBe(800);
    // The zoned lot is filled at its middle; a lot next to it is not.
    const zoned = sampleLattice(overlay.lattice, 7 * 24 + 11, 15);
    expect(zoned?.records.some((r) => r.fill && r.inside)).toBe(true);
    const plain = sampleLattice(overlay.lattice, 8 * 24 + 11, 15);
    expect(plain?.records.some((r) => r.fill && r.inside) ?? false).toBe(false);
    overlay.dispose();
  });

  it('rewrites only the cells of the lot that changed', () => {
    const overlay = createLotOverlay();
    overlay.set(lots(400));
    const all = overlay.lattice.cellsWritten;
    overlay.lattice.cellsWritten = 0;
    // One lot zoned, then the pointer over another: their cells only.
    overlay.set(lots(400, 37));
    overlay.set(lots(400, 37, 120));
    expect(overlay.lattice.cellsWritten).toBeGreaterThan(0);
    expect(overlay.lattice.cellsWritten).toBeLessThan(all / 20);
    overlay.lattice.cellsWritten = 0;
    // Nothing changed: nothing written.
    overlay.set(lots(400, 37, 120));
    expect(overlay.lattice.cellsWritten).toBe(0);
    overlay.dispose();
  });

  it('keeps a built lot\'s ground level, read again only where the ground moved', () => {
    let ground = 2;
    let asked = 0;
    const overlay = createLotOverlay(() => { asked++; return ground; });
    const changes = new ChangeJournal();
    const built = (input: LotOverlayInput): LotOverlayInput => ({ ...input, polygons: input.polygons.map((p, i) => (i === 5 ? { ...p, built: true } : p)) });
    overlay.set(built(lots(40, 5)), changes);
    // The built lot and the 40 front lines ask the ground, once each; of the lots, only the built one carries a level.
    expect(asked).toBe(41);
    // The pointer moved (a new input, the same shapes): nothing asked again.
    asked = 0;
    overlay.set({ ...built(lots(40, 5)), key: 'moved pointer' }, changes);
    expect(asked).toBe(0);
    const yard = sampleLattice(overlay.lattice, 5 * 24 + 11, 15);
    expect(yard?.records.some((r) => r.level === 2)).toBe(true);
    // On the edge of a lot with no building: its outline, with no level.
    const plain = sampleLattice(overlay.lattice, 8 * 24 + 0.1, 15);
    expect(plain?.records.length).toBeGreaterThan(0);
    expect(plain?.records.filter((r) => r.distance < 1).every((r) => r.level === null)).toBe(true);
    // A building elsewhere moves no ground: nothing read again.
    asked = 0;
    changes.record('buildings', [[0, 0, 10, 10]]);
    overlay.set(built(lots(40, 5)), changes);
    expect(asked).toBe(0);
    // The ground levelled: the level read again, and redrawn.
    ground = 3.5;
    changes.record('ground', [[100, 0, 160, 40]]);
    overlay.set(built(lots(40, 5)), changes);
    // Only what lies where it moved: the built lot and the front lines near it, not the 40.
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThan(8);
    expect(sampleLattice(overlay.lattice, 5 * 24 + 11, 15)?.records.some((r) => r.level === 3.5)).toBe(true);
    overlay.dispose();
  });

  it('takes away what is no longer drawn', () => {
    const overlay = createLotOverlay();
    overlay.set(lots(100, 3));
    overlay.set(lots(50, 3));
    expect(overlay.lattice.size).toBe(100);
    expect(sampleLattice(overlay.lattice, 10 * 24 + 11, 3 * 32 + 15)).toBeNull();
    overlay.set(null);
    expect(overlay.lattice.size).toBe(0);
    overlay.dispose();
  });
});

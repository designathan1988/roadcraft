import { describe, expect, it } from 'vitest';
import { ActiveTiles } from '@render/activeTiles';
import { MeshStandardMaterial } from 'three';
import { applyLotOverlay, createLotOverlay, frameHalfFor, type LotOverlayGroup, type LotOverlayInput } from '@render/lotOverlay';
import { PLATE_SIZE } from '@world/bounds';
import { ChangeJournal } from '@world/changes';
import { TILE, tileKey, tileKeyAt, tileRect } from '@world/tiles';
import { sampleLattice } from './support/latticeSampler';

/** THE LOTS COLOURED INTO THE GROUND (`render/lotOverlay.ts`). */

/** n lots in rows of 20, each its own group (its outline and its front), as the Zoning tool hands them; a new input each call. */
function lots(n: number, zonedAt = -1, hovered = -1, builtAt = -1): LotOverlayInput {
  const groups = new Map<string, LotOverlayGroup>();
  for (let i = 0; i < n; i++) {
    const x = (i % 20) * 24, y = Math.floor(i / 20) * 32;
    const corners = [{ x, y }, { x: x + 22, y }, { x: x + 22, y: y + 30 }, { x, y: y + 30 }];
    groups.set(`l${i}`, {
      rank: i,
      polygons: [{
        corners, fill: i === zonedAt ? 0x56bb73 : null, fillAlpha: i === zonedAt ? 0.45 : 0,
        line: i === hovered ? 0xffd25e : 0xffffff, lineAlpha: 0.85, width: i === hovered ? 0.7 : 0.35, ...(i === builtAt ? { built: true } : {}),
      }],
      lines: [{ a: corners[0]!, b: corners[1]!, colour: 0x5ee0ff, dashed: false, width: 0.8 }],
      points: [],
    });
  }
  return { groups, changedFor: () => null };
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
    const built = (): LotOverlayInput => lots(40, 5, -1, 5);
    overlay.set(built(), changes);
    // The built lot and the 40 front lines ask the ground, once each; of the lots, only the built one carries a level.
    expect(asked).toBe(41);
    // The pointer moved (a new input, the same shapes): nothing asked again.
    asked = 0;
    overlay.set(built(), changes);
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
    overlay.set(built(), changes);
    expect(asked).toBe(0);
    // The ground levelled: the level read again, and redrawn.
    ground = 3.5;
    changes.record('ground', [[100, 0, 160, 40]]);
    overlay.set(built(), changes);
    // Only what lies where it moved: the built lot and the front lines near it, not the 40.
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThan(8);
    expect(sampleLattice(overlay.lattice, 5 * 24 + 11, 15)?.records.some((r) => r.level === 3.5)).toBe(true);
    overlay.dispose();
  });

  it('reads only the groups its input says changed, and those where the ground moved', () => {
    let asked = 0;
    const overlay = createLotOverlay(() => { asked++; return 2; });
    const changes = new ChangeJournal();
    const whole = lots(400, -1, -1, 5);
    let changed: string[] = [];
    // The same input, its groups changed in place and named, as the Zoning tool hands them.
    let seen: object | null = null;
    const input: LotOverlayInput = {
      groups: whole.groups,
      changedFor: (reader) => {
        if (reader !== seen) { seen = reader; return null; }
        return changed.splice(0);
      },
    };
    overlay.set(input, changes);
    const all = overlay.lattice.cellsWritten;
    overlay.lattice.cellsWritten = 0;
    // Lot 37 zoned: its group put again, and named.
    const zoned = lots(400, 37).groups.get('l37')!;
    (whole.groups as Map<string, LotOverlayGroup>).set('l37', zoned);
    changed = ['l37'];
    overlay.set(input, changes);
    expect(overlay.lattice.cellsWritten).toBeGreaterThan(0);
    expect(overlay.lattice.cellsWritten).toBeLessThan(all / 20);
    expect(sampleLattice(overlay.lattice, 37 % 20 * 24 + 11, Math.floor(37 / 20) * 32 + 15)?.records.some((r) => r.fill && r.inside)).toBe(true);
    // Nothing named, nothing moved: nothing written.
    overlay.lattice.cellsWritten = 0;
    overlay.set(input, changes);
    expect(overlay.lattice.cellsWritten).toBe(0);
    // The ground moved under the built lot: its group and its neighbours' made again, not the 400.
    asked = 0;
    changes.record('ground', [[100, 0, 160, 40]]);
    overlay.set(input, changes);
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThan(8);
    overlay.dispose();
  });

  it('walks no group on the frames nothing changed, and only the groups named when a few did', () => {
    const overlay = createLotOverlay();
    const changes = new ChangeJournal();
    /** The groups, counting every walk of them all (`values`, `entries`, the iterator). */
    class Counted extends Map<string, LotOverlayGroup> {
      walks = 0;
      override values() { this.walks++; return super.values(); }
      override entries() { this.walks++; return super.entries(); }
      override [Symbol.iterator]() { this.walks++; return super[Symbol.iterator](); }
    }
    const groups = new Counted(lots(400).groups);
    let changed: string[] = [];
    let seen: object | null = null;
    const input: LotOverlayInput = { groups, changedFor: (reader) => { if (reader !== seen) { seen = reader; return null; } return changed.splice(0); } };
    overlay.set(input, changes);
    // The drawing's frames with nothing changed (the overlay is set every frame, `main.ts` drawOverlayScreen): no group walked.
    groups.walks = 0;
    for (let f = 0; f < 60; f++) overlay.set(input, changes);
    expect(groups.walks).toBe(0);
    // One lot zoned inside the frame: only it laid again, the groups not walked.
    groups.set('l37', lots(400, 37).groups.get('l37')!);
    changed = ['l37'];
    overlay.set(input, changes);
    expect(groups.walks).toBe(0);
    expect(sampleLattice(overlay.lattice, 37 % 20 * 24 + 11, Math.floor(37 / 20) * 32 + 15)?.records.some((r) => r.fill && r.inside)).toBe(true);
    // A lot drawn far past the frame: the frame stood again over every lot, the far one drawn.
    const far = 5 * PLATE_SIZE;
    groups.set('far', { rank: 1, polygons: [{ corners: [{ x: far, y: 0 }, { x: far + 22, y: 0 }, { x: far + 22, y: 30 }, { x: far, y: 30 }], fill: 0x56bb73, fillAlpha: 0.5, line: 0xffffff, lineAlpha: 1, width: 0.35 }], lines: [], points: [] });
    changed = ['far'];
    overlay.set(input, changes);
    expect(sampleLattice(overlay.lattice, far + 11, 15)?.records.some((r) => r.fill && r.inside)).toBe(true);
    // The lots near the origin still drawn in the frame stood again (on lot 0's front).
    expect(sampleLattice(overlay.lattice, 11, 0.2)?.records.length).toBeGreaterThan(0);
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

  it('stands its frame where the lots are on an unbounded world, grown by plates to hold them all', () => {
    const square = (x: number, y: number): LotOverlayGroup => ({
      rank: 0,
      polygons: [{ corners: [{ x, y }, { x: x + 20, y }, { x: x + 20, y: y + 20 }, { x, y: y + 20 }], fill: 0x56bb73, fillAlpha: 0.5, line: 0xffffff, lineAlpha: 1, width: 0.4 }],
      lines: [], points: [],
    });
    // Two lots 9 km apart, 300 km out: wider than the smallest frame.
    const far = 300_000;
    const groups = new Map<string, LotOverlayGroup>([['a', square(far, far)], ['b', square(far + 9_000, far + 400)]]);
    const overlay = createLotOverlay();
    overlay.set({ groups, changedFor: () => null });
    const lattice = overlay.lattice;
    expect(sampleLattice(lattice, far + 10, far + 10)?.records.some((r) => r.fill && r.inside)).toBe(true);
    expect(sampleLattice(lattice, far + 9_010, far + 410)?.records.some((r) => r.fill && r.inside)).toBe(true);
    // Drawn again with nothing moved: the frame stays.
    overlay.set({ groups, changedFor: () => [] });
    expect(overlay.lattice).toBe(lattice);
    overlay.dispose();
  });

  it('lays the lots of the streamed world\'s active tiles only, a lot astride their edge whole, as tiles come and go', () => {
    const square = (x: number, y: number): LotOverlayGroup => ({
      rank: 0,
      polygons: [{ corners: [{ x, y }, { x: x + 20, y }, { x: x + 20, y: y + 20 }, { x, y: y + 20 }], fill: 0x56bb73, fillAlpha: 0.5, line: 0xffffff, lineAlpha: 1, width: 0.4 }],
      lines: [], points: [],
    });
    // One lot on tile (0, 0), one on tile (1, 0), one astride their edge.
    const groups = new Map<string, LotOverlayGroup>([['a', square(100, 100)], ['b', square(TILE + 476, 100)], ['c', square(TILE - 10, 300)]]);
    const input: LotOverlayInput = { groups, changedFor: () => [] };
    const shown = new Set([tileKey(0, 0)]);
    const at = (x: number, y: number): boolean => shown.has(tileKeyAt(x, y));
    const active = new ActiveTiles();
    active.set(at, []);
    const overlay = createLotOverlay(() => 0, active);
    const filled = (x: number, y: number): boolean => sampleLattice(overlay.lattice, x, y)?.records.some((r) => r.fill && r.inside) ?? false;
    const picture = (): boolean[] => [filled(110, 110), filled(TILE + 486, 110), filled(TILE - 5, 310), filled(TILE + 5, 310)];
    overlay.set(input);
    expect(picture()).toEqual([true, false, true, true]);
    // Tile (1, 0) comes in and (0, 0) leaves, the input the same: the lots of those tiles laid again alone.
    shown.add(tileKey(1, 0));
    shown.delete(tileKey(0, 0));
    active.set(at, [tileRect(1, 0), tileRect(0, 0)]);
    overlay.set(input);
    expect(picture()).toEqual([false, true, true, true]);
    // The world closed: every lot.
    active.set(null, []);
    overlay.set(input);
    expect(picture()).toEqual([true, true, true, true]);
    overlay.dispose();
  });

  it('sizes the frame by whole plates round its centre, never under a plate and its ring', () => {
    expect(frameHalfFor(0, 0, -100, -100, 100, 100)).toBe(PLATE_SIZE * 1.5);
    expect(frameHalfFor(0, 0, -100, -100, PLATE_SIZE * 1.5, 100)).toBe(PLATE_SIZE * 1.5);
    expect(frameHalfFor(0, 0, -100, -100, PLATE_SIZE * 1.5 + 1, 100)).toBe(PLATE_SIZE * 2.5);
    expect(frameHalfFor(PLATE_SIZE * 10, 0, PLATE_SIZE * 6, 0, PLATE_SIZE * 10, 0)).toBe(PLATE_SIZE * 4.5);
  });

  it("makes one program of materials whose code is the same, whatever they are named: the key is the code's shape (the varying, the walls), not the material", () => {
    const shaded = (options?: Parameters<typeof applyLotOverlay>[1]): { key: string; vertex: string; fragment: string } => {
      const material = new MeshStandardMaterial();
      applyLotOverlay(material, options);
      const shader = { uniforms: {}, vertexShader: ['#include <common>', '#include <worldpos_vertex>'].join('\n'), fragmentShader: ['#include <common>', '#include <opaque_fragment>'].join('\n') };
      material.onBeforeCompile(shader as never, undefined as never);
      return { key: material.customProgramCacheKey(), vertex: shader.vertexShader, fragment: shader.fragmentShader };
    };
    // The street's surfaces (the asphalt and the raised one, the kerb and the deck): one program each pair, as their code is one.
    expect(shaded()).toEqual(shaded());
    expect(shaded({ building: true })).toEqual(shaded({ building: true }));
    // Another shape of code, another program.
    const keys = new Set([shaded().key, shaded({ building: true }).key, shaded({ world: 'vTerrainAtlas' }).key]);
    expect(keys.size).toBe(3);
    expect(shaded({ building: true }).fragment).not.toBe(shaded().fragment);
  });
});


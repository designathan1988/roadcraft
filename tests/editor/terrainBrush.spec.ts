import { afterEach, describe, expect, it, vi } from 'vitest';

import { RoadDoc } from '@world/doc';
import { TerrainBrush, type DabSettings } from '@editor/terrainBrush';

/** The terrain brush as the player uses it (`editor/terrainBrush.ts`, taken out of `main.ts`). */
function settings(mode: string): DabSettings {
  return {
    mode, radius: 40, strength: 20, hardness: 0, landform: undefined,
    element: { mode: 'lay', kind: 'stones', brush: { density: 50, size: 50, variation: 30, spacing: 1, strength: 50, intensity: 50 } as never },
    tree: { mode: 'stand', kind: 'oak' as never, brush: { density: 100, height: 8, variation: 20, spacing: 4 } as never },
    gully: { strength: 60, erase: false },
    fog: { strength: 50, height: 10, speed: 1, erase: false },
    paint: 'dirt' as never,
  };
}

function brush(mode: string): { brush: TerrainBrush; doc: RoadDoc; records: number[] } {
  const doc = new RoadDoc();
  const records: number[] = [];
  const b = new TerrainBrush({
    doc, settings: () => settings(mode), heightAt: () => 7, interval: () => 0,
    record: () => records.push(doc.terrainStamps.length), redraw: () => {},
  });
  return { brush: b, doc, records };
}

afterEach(() => vi.useRealTimers());

describe('the terrain brush', () => {
  it('raises the land along a stroke, its dabs spaced and carrying one stroke id, one undo step', () => {
    const { brush: b, doc, records } = brush('raise');
    b.begin(1, { x: 0, y: 0 });
    expect(b.stroking).toBe(true);
    b.paint({ x: 40, y: 0 });
    b.paint({ x: 120, y: 0 });
    expect(b.end()).toBe(true);
    expect(records).toEqual([0]);
    expect(doc.terrainStamps.length).toBeGreaterThan(3);
    const ids = new Set(doc.terrainStamps.map((s) => s.stroke));
    expect(ids.size).toBe(1);
    expect(b.stroking).toBe(false);
  });

  it('flattens to the height the stroke started at, and keeps levelling while held still', () => {
    const { brush: b, doc } = brush('flatten');
    b.begin(1, { x: 0, y: 0 });
    const first = doc.terrainStamps.length;
    // Held still: the frames level on (`TerrainBrush.tick`, run by the frame loop), half a second of them.
    const start = 1e12;
    for (let t = 16; t <= 500; t += 16) expect(b.tick(start + t)).toBe(true);
    expect(doc.terrainStamps.length).toBeGreaterThan(first);
    expect(doc.terrainStamps.every((s) => s.level === 7)).toBe(true);
    b.end();
    const held = doc.terrainStamps.length;
    for (let t = 516; t <= 1000; t += 16) expect(b.tick(start + t)).toBe(false);
    expect(doc.terrainStamps.length).toBe(held);
  });

  it('paints the ground without moving the land', () => {
    const { brush: b, doc } = brush('paint');
    b.begin(1, { x: 0, y: 0 });
    b.paint({ x: 60, y: 0 });
    b.end();
    expect(doc.terrainStamps.length).toBe(0);
    expect(doc.terrainPaint.length).toBeGreaterThan(0);
  });

  it('lays the same trees and elements for the same strokes on the same map: no Math.random in the document', () => {
    const laid = (mode: string): string => {
      const { brush: b, doc } = brush(mode);
      b.begin(1, { x: 0, y: 0 });
      b.paint({ x: 120, y: 30 });
      b.end();
      return JSON.stringify(mode === 'trees' ? doc.trees : doc.elements);
    };
    const random = vi.spyOn(Math, 'random');
    for (const mode of ['trees', 'elements']) {
      const first = laid(mode);
      expect(first.length).toBeGreaterThan(10);
      expect(laid(mode)).toBe(first);
    }
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });
});

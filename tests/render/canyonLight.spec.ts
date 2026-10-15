import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, type DataTexture, type ShaderMaterial } from 'three';
import { createCanyonLight } from '@render/canyonLight';
import type { CameraSolids } from '@world/buildings/cameraSolids';
import { m } from '@world/units';

/**
 * The light the town shuts out of its streets (`canyonLight.ts`) follows the
 * buildings by the rectangles that changed: a building grown is laid into the
 * field in place, with only its rows sent, while the window round the view is
 * laid once. Laid again whole at every building, a growing town's field was
 * never put in place.
 */

type Box = { x: number; y: number; w: number; d: number; top: number };

function solidsOf(boxes: Box[]): () => CameraSolids {
  const solids = {
    forEachIn(x0: number, y0: number, x1: number, y1: number,
      visit: (bx: number, by: number, c: number, s: number, lx0: number, ly0: number, lx1: number, ly1: number, top: number) => void) {
      for (const b of boxes) {
        if (b.x + b.w < x0 || b.x > x1 || b.y + b.d < y0 || b.y > y1) continue;
        visit(b.x, b.y, 1, 0, 0, 0, b.w, b.d, b.top);
      }
    },
  } as unknown as CameraSolids;
  return () => solids;
}

describe('canyon light', () => {
  it('lays a building that came in place, sends only its rows, and does not lay the window again', () => {
    const canyon = createCanyonLight(new PerspectiveCamera(), () => null);
    const heights = (canyon.pass.material as ShaderMaterial).uniforms['uHeights']!.value as DataTexture;
    const data = heights.image.data as Uint8Array;
    const boxes: Box[] = [{ x: m(10), y: m(10), w: m(20), d: m(20), top: m(12) }];
    const solids = solidsOf(boxes);
    // The first call lays the whole window; a few hundred volumes a frame, here one.
    canyon.follow(0, 0, solids, null);
    const window = (canyon.pass.material as ShaderMaterial).uniforms['uWindow']!.value as { x: number; y: number; z: number; w: number };
    const cell = (x: number, y: number): number => {
      const k = Math.floor((x - window.x) / window.z), j = Math.floor((y - window.y) / window.z);
      const at = (j * window.w + k) * 4;
      return data[at]! * 256 + data[at + 1]!;
    };
    expect(cell(m(20), m(20))).toBeGreaterThan(0);
    expect(cell(m(80), m(80))).toBe(0);
    // A building grows at (70, 70): its rectangle comes from the diary.
    boxes.push({ x: m(70), y: m(70), w: m(16), d: m(16), top: m(30) });
    heights.clearUpdateRanges();
    canyon.follow(0, 0, solids, [[m(70), m(70), m(86), m(86)]]);
    expect(cell(m(78), m(78))).toBeGreaterThan(cell(m(20), m(20)));
    // Only its rows go up, a range a row.
    expect(heights.updateRanges.length).toBeGreaterThan(0);
    expect(heights.updateRanges.length).toBeLessThanOrEqual(Math.ceil(m(16) / window.z) + 1);
    // The first building is as it was.
    expect(cell(m(20), m(20))).toBeGreaterThan(0);
    // Taken away: its cells clear, the other building's stay.
    boxes.pop();
    canyon.follow(0, 0, solids, [[m(70), m(70), m(86), m(86)]]);
    expect(cell(m(78), m(78))).toBe(0);
    expect(cell(m(20), m(20))).toBeGreaterThan(0);
    canyon.dispose();
  });
});

import { describe, expect, it } from 'vitest';
import { m } from '@world/units';
import { segmentCrossesLot } from '@editor/lotTool';

/** EDT-12: a cut by a line finds a lot narrower than a twentieth of the line, between two of its samples. */
describe('a cut across a narrow lot', () => {
  it('crosses a lot 8 m wide in a cut of 200 m, and not one beside the line', () => {
    const a = { x: 0, y: 0 }, b = { x: m(200), y: 0 };
    // The lot from 101 m to 109 m along the cut: no sample (every 10 m) inside it.
    const lot = [{ x: m(101), y: m(-20) }, { x: m(109), y: m(-20) }, { x: m(109), y: m(20) }, { x: m(101), y: m(20) }];
    expect(segmentCrossesLot(a, b, lot)).toBe(true);
    const beside = lot.map((p) => ({ x: p.x, y: p.y + m(40) }));
    expect(segmentCrossesLot(a, b, beside)).toBe(false);
  });
});

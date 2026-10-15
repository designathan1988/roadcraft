import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { poleLinesIn, poleLinesWork } from '@world/poleLines';
import type { ChangeRect } from '@world/changes';
import { m } from '@world/units';

/**
 * The regional pole lines kept per network (`poleLinesIn`): a rectangle
 * already kept and made again after an edit takes its own place back; it must
 * not let go of another rectangle, which nothing touched.
 */
describe('regional pole lines kept', () => {
  it('a rectangle made again does not let go of another one', () => {
    const doc = new RoadDoc();
    doc.addSegment(doc.addNode({ x: m(-2000), y: m(-2000) }).id, doc.addNode({ x: m(-1900), y: m(-2000) }).id, 1);
    const net = new Network(doc);
    net.rebuild();
    // As many rectangles as are kept, on the map, each well apart from the others (more than the halo).
    const rects: ChangeRect[] = [];
    for (let i = 0; i < 64; i++) {
      const x = (i % 8) * m(300) - m(1200), y = Math.floor(i / 8) * m(300) - m(1200);
      rects.push([x, y, x + m(50), y + m(50)]);
    }
    for (const r of rects) poleLinesIn(net, r);
    // A street inside the last rectangle: that one is made again, the first one is untouched.
    const last = rects[rects.length - 1]!;
    doc.addSegment(doc.addNode({ x: last[0] + m(5), y: last[1] + m(25) }).id, doc.addNode({ x: last[2] - m(5), y: last[1] + m(25) }).id, 1);
    net.rebuild();
    let made = poleLinesWork.made;
    poleLinesIn(net, last);
    expect(poleLinesWork.made - made).toBe(1);
    // The first rectangle is still kept: answered without making its lines.
    made = poleLinesWork.made;
    const kept = poleLinesWork.kept;
    poleLinesIn(net, rects[0]!);
    expect(poleLinesWork.made - made).toBe(0);
    expect(poleLinesWork.kept - kept).toBe(1);
  });

  it('keeps every rectangle still right, however many, and lets go only those an edit reached', () => {
    const doc = new RoadDoc();
    doc.addSegment(doc.addNode({ x: m(-2000), y: m(-2000) }).id, doc.addNode({ x: m(-1900), y: m(-2000) }).id, 1);
    const net = new Network(doc);
    net.rebuild();
    // More than the 64 a ceiling kept, each well apart from the others (more than the halo).
    const rects: ChangeRect[] = [];
    for (let i = 0; i < 100; i++) {
      const x = (i % 10) * m(300) - m(1500), y = Math.floor(i / 10) * m(300) - m(1500);
      rects.push([x, y, x + m(50), y + m(50)]);
    }
    for (const r of rects) poleLinesIn(net, r);
    let made = poleLinesWork.made;
    for (const r of rects) poleLinesIn(net, r);
    expect(poleLinesWork.made - made).toBe(0);
    // A street in one of them: that one alone is made again.
    const hit = rects[37]!;
    doc.addSegment(doc.addNode({ x: hit[0] + m(5), y: hit[1] + m(25) }).id, doc.addNode({ x: hit[2] - m(5), y: hit[1] + m(25) }).id, 1);
    net.rebuild();
    made = poleLinesWork.made;
    for (const r of rects) poleLinesIn(net, r);
    expect(poleLinesWork.made - made).toBe(1);
  });
});

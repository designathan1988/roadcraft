import { describe, expect, it, vi } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { commitRoadPath } from '@editor/commit';

// Every test of a piece of the draft against a piece of a road (`commitDraftInPlace`), counted.
const tests = vi.hoisted(() => ({ count: 0 }));
vi.mock('@core/intersect', async (original) => {
  const actual = await original<typeof import('@core/intersect')>();
  return { ...actual, segSeg: (...args: Parameters<typeof actual.segSeg>) => { if (new Error().stack?.includes('commitDraftInPlace')) tests.count++; return actual.segSeg(...args); } };
});

/** EDT-06: THE CROSSINGS OF A DRAFT, looked for only where a piece of it and a piece of a road share a box */
describe('the crossings of a road drawn', () => {
  it('tests only the pieces whose boxes meet, and finds the same crossings', () => {
    const doc = new RoadDoc();
    // A long winding road the draft crosses twice.
    const a = doc.addNode({ x: 0, y: -400 }, 0), b = doc.addNode({ x: 0, y: 400 }, 0);
    doc.addSegment(a.id, b.id, 1, { t: 0.5, h: 300 });
    const net = new Network(doc);
    net.rebuild();
    const road = net.polylines.get(doc, [...doc.segments.keys()][0]!);
    const before = new Set(doc.nodes.keys());
    tests.count = 0;
    const result = commitRoadPath(doc, net, { kind: 'free', at: { x: -500, y: 0 } }, { kind: 'free', at: { x: 500, y: 0 } }, 1,
      [{ start: { at: { x: -500, y: 0 }, heightOffset: 0 }, end: { at: { x: 500, y: 0 }, heightOffset: 0 }, curve: { t: 0.5, h: 120 } }],
      null, undefined, undefined, { dryRun: true });
    expect(result.committed).toBe(true);
    // Every pair was tested before: the draft's pieces times the road's, at least.
    expect(road.n).toBeGreaterThan(20);
    expect(tests.count).toBeLessThan(road.n * 4);
    expect(new Set(doc.nodes.keys())).toEqual(before);
  });
});

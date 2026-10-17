import { describe, expect, it } from 'vitest';
import { DeltaLog, type NetworkDelta } from '@world/networkDelta';
import type { NodeId, SegmentId } from '@world/ids';

/** THE NETWORK'S HISTORY WITHOUT A LIMIT OF AGE (`DeltaLog`): a reader however far behind is told what changed */
const delta = (k: number): NetworkDelta => ({
  segments: new Set([k as SegmentId, (k + 1) as SegmentId]),
  nodes: new Set([(k % 7) as NodeId]),
  rects: [[k, k, k + 1, k + 1]],
});
const sorted = (d: NetworkDelta | null): unknown => d && {
  segments: [...d.segments].sort((a, b) => a - b), nodes: [...d.nodes].sort((a, b) => a - b),
  rects: [...d.rects].map((r) => r.join(',')).sort(),
};
const expected = (from: number, to: number): unknown => {
  const segments = new Set<SegmentId>(), nodes = new Set<NodeId>(), rects: [number, number, number, number][] = [];
  for (let k = from; k < to; k++) { const d = delta(k); d.segments.forEach((s) => segments.add(s)); d.nodes.forEach((n) => nodes.add(n)); rects.push(...(d.rects as [number, number, number, number][])); }
  return sorted({ segments, nodes, rects });
};

describe('the network history', () => {
  it('tells a reader 500 rebuilds behind what changed', () => {
    const log = new DeltaLog();
    const token = log.state;
    for (let k = 0; k < 500; k++) log.advance(delta(k));
    expect(sorted(log.since(token))).toEqual(expected(0, 500));
  });

  it('answers every reader the same after the states no one holds are merged away', () => {
    const log = new DeltaLog();
    const tokens = new Map<number, object>();
    for (let k = 0; k < 300; k++) {
      if (k % 50 === 0) tokens.set(k, log.state);
      log.advance(delta(k));
    }
    const before = new Map([...tokens].map(([k, t]) => [k, sorted(log.since(t))]));
    const held = new Set(tokens.values());
    log.merge((state) => held.has(state));
    for (const [k, t] of tokens) {
      expect(sorted(log.since(t)), `token ${k}`).toEqual(before.get(k));
      expect(sorted(log.since(t)), `token ${k}`).toEqual(expected(k, 300));
    }
    // Only the held states and the current one are left: one rebuild between each.
    expect((log as unknown as { edges: unknown[] }).edges.length).toBe(tokens.size);
  });

  it('says everything changed across a load', () => {
    const log = new DeltaLog();
    const token = log.state;
    log.advance(delta(1));
    log.advance(null);
    log.advance(delta(2));
    expect(log.since(token)).toBeNull();
    log.merge(() => false);
    expect(log.since(token)).toBeNull();
  });
});

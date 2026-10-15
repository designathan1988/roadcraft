import { describe, expect, it } from 'vitest';
import { ChangeLog } from '@core/changeLog';
import { DeltaLog, type NetworkDelta } from '@world/networkDelta';
import type { NodeId, SegmentId } from '@world/ids';

/** NO HISTORY FORGETS BY AGE (`ChangeLog`, `DeltaLog`) */
const delta = (k: number): NetworkDelta => ({ segments: new Set([k as SegmentId]), nodes: new Set([(k % 13) as NodeId]), rects: [[k, k, k + 1, k + 1]] });

describe('a reader behind thousands of changes', () => {
  it('is told every change of a ChangeLog, never null', () => {
    const log = new ChangeLog<number>();
    const readers = new Map<number, object>();
    for (let k = 0; k < 6000; k++) {
      if (k % 500 === 0) readers.set(k, log.state);
      log.push(k);
    }
    for (const [k, token] of readers) {
      const seen = log.since(token);
      expect(seen, `reader at ${k}`).not.toBeNull();
      expect(seen!.length).toBe(6000 - k);
      expect(seen![0]).toBe(k);
    }
  });

  it('is told every change of the network history, never null', () => {
    const log = new DeltaLog();
    const readers = new Map<number, object>();
    for (let k = 0; k < 6000; k++) {
      if (k % 500 === 0) readers.set(k, log.state);
      log.advance(delta(k));
    }
    for (const [k, token] of readers) {
      const seen = log.since(token);
      expect(seen, `reader at ${k}`).not.toBeNull();
      expect(seen!.segments.size).toBe(6000 - k);
    }
  });
});

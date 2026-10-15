import { describe, expect, it } from 'vitest';

import { type ChangeKind, type ChangeRect, ChangeJournal } from '@world/changes';
import { ChangeSweep } from '@world/derived';
import { Rng } from '@core/rng';

/**
 * The sweep (`ChangeSweep`) answers every reader of a point as the diary's
 * own `touches` does, whatever the reader's serial: caught up with the last
 * advance (the cell asked), behind it (the diary asked), or ahead.
 */
const KINDS: readonly ChangeKind[] = ['ground', 'buildings', 'roads'];
const OTHER: ChangeKind = 'trees';

describe('the diary swept once for many readers', () => {
  it('answers as touches, frame after frame, for readers at every serial', () => {
    const rng = new Rng(7);
    const j = new ChangeJournal();
    const sweep = new ChangeSweep(j, KINDS);
    const readers = Array.from({ length: 400 }, () => ({ x: rng.range(-3000, 3000), y: rng.range(-3000, 3000), seen: 0 }));
    for (let frame = 0; frame < 60; frame++) {
      const writes = Math.floor(rng.range(0, 40));
      for (let w = 0; w < writes; w++) {
        const kind = rng.range(0, 1) < 0.15 ? OTHER : KINDS[Math.floor(rng.range(0, KINDS.length))]!;
        const rects: ChangeRect[] = [];
        for (let r = 0, n = 1 + Math.floor(rng.range(0, 3)); r < n; r++) {
          const x = rng.range(-3000, 3000), y = rng.range(-3000, 3000), w2 = rng.range(0, 300), h = rng.range(0, 300);
          rects.push([x, y, x + w2, y + h]);
        }
        j.record(kind, rng.range(0, 1) < 0.01 ? null : rects);
      }
      sweep.advance();
      for (const reader of readers) {
        const asked = sweep.touches(reader.seen, reader.x, reader.y);
        expect(asked).toBe(j.touches(reader.seen, [reader.x, reader.y, reader.x, reader.y], KINDS));
        // Most readers catch up each frame; some lag a few frames, as cars out of view do.
        if (rng.range(0, 1) < 0.8) reader.seen = sweep.serial;
      }
    }
  });

  it('takes a change too wide to file as the whole map', () => {
    const j = new ChangeJournal();
    const sweep = new ChangeSweep(j, KINDS);
    j.record('ground', [[0, 0, 1, 1]]);
    sweep.advance();
    const seen = sweep.serial;
    j.record('ground', [[-1e6, -1e6, 1e6, 1e6]]);
    sweep.advance();
    expect(sweep.touches(seen, 5000, 5000)).toBe(true);
    expect(j.touches(seen, [5000, 5000, 5000, 5000], KINDS)).toBe(true);
  });
});

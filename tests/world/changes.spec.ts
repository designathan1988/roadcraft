import { describe, expect, it } from 'vitest';

import { type Change, type ChangeKind, ChangeJournal, journalWork } from '@world/changes';

/**
 * The diary's readers of some kinds (`since` with kinds): a kind is forgotten
 * only by entries of its own, and a kind that did not move costs nothing to
 * ask about. In one ring of 2.048 for all, a city growing (thousands of
 * building entries) told the ground's readers "everything changed", and they
 * laid the whole map again (docs/AUDITORIA-2026-10-14.md D8/C1).
 */
const R = [0, 0, 1, 1] as const;

describe('the diary read by kind', () => {
  it('keeps a kind through a burst of another', () => {
    const j = new ChangeJournal();
    const ground = j.record('ground', [R]);
    for (let i = 0; i < 5000; i++) j.record('buildings', [R]);
    expect(j.since(0, ['ground'])?.map((c) => c.serial)).toEqual([ground]);
    expect(j.since(ground, ['ground'])).toEqual([]);
    expect(j.touches(0, R, ['ground'])).toBe(true);
    expect(j.touches(ground, R, ['ground'])).toBe(false);
    // The whole diary still forgets: a reader of everything is told so.
    expect(j.since(0)).toBeNull();
  });

  it('forgets a kind by its own entries', () => {
    // The last 2,048 of a kind are always kept; older ones are let go (in a batch, past twice that) when
    // no reader that follows the diary still needs them (`ChangeJournal.follow`).
    const j = new ChangeJournal();
    for (let i = 0; i < 4097; i++) j.record('ground', [R]);
    expect(j.since(0, ['ground'])).toBeNull();
    expect(j.since(4097 - 2048, ['ground'])).toHaveLength(2048);
  });

  it('costs nothing to ask about a kind that did not move', () => {
    const j = new ChangeJournal();
    const seen = j.record('ground', [R]);
    for (let i = 0; i < 1000; i++) j.record('buildings', [R]);
    const before = journalWork.entries;
    expect(j.since(seen, ['ground', 'elevation'])).toEqual([]);
    expect(journalWork.entries - before).toBe(0);
  });

  it('answers as the whole diary filtered would, in order, while nothing is forgotten', () => {
    const kinds: ChangeKind[] = ['roads', 'ground', 'buildings', 'elevation'];
    let seed = 7;
    const rand = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const j = new ChangeJournal();
    const all: Change[] = [];
    for (let step = 0; step < 1500; step++) {
      const serial = j.record(kinds[Math.floor(rand() * kinds.length)]!, [R]);
      all.push(j.get(serial)!);
      const since = Math.floor(rand() * j.version);
      const asked = kinds.filter(() => rand() < 0.5);
      if (asked.length === 0) continue;
      const want = all.filter((c) => c.serial > since && asked.includes(c.kind)).map((c) => c.serial);
      expect(j.since(since, asked)?.map((c) => c.serial)).toEqual(want);
    }
  });

  it('starts a copy with nothing kept, at the same revisions', () => {
    const j = new ChangeJournal();
    const ground = j.record('ground', [R]);
    j.record('roads', [R]);
    const copy = new ChangeJournal();
    copy.continueFrom(j);
    // Entries before the copy are not there: a reader from before them is told so.
    expect(copy.since(0, ['ground'])).toBeNull();
    // A reader that had seen them: nothing new.
    expect(copy.since(ground, ['ground'])).toEqual([]);
    expect(copy.since(j.version, ['roads'])).toEqual([]);
    const next = copy.record('ground', [R]);
    expect(copy.since(j.version, ['ground'])?.map((c) => c.serial)).toEqual([next]);
    expect(copy.since(ground, ['ground'])).toBeNull();
  });
});

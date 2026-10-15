import { describe, expect, it } from 'vitest';
import { ChangeJournal, type ChangeKind, type JournalReader } from '@world/changes';
import { JournalCursor } from '@world/derived';

/** THE DIARY KEEPS WHAT ITS READERS HAVE NOT READ (`ChangeJournal.follow`) */
const R = [0, 0, 1, 1] as const;
const kept = (j: ChangeJournal, kind: ChangeKind): number =>
  ((j as unknown as { byKind: Map<ChangeKind, { entries: unknown[] }> }).byKind.get(kind)?.entries.length) ?? 0;

describe('the diary and the readers that follow it', () => {
  it('tells a following reader every entry since it last read, past thousands', () => {
    const j = new ChangeJournal();
    const cursor = new JournalCursor(['buildings'], true);
    j.record('buildings', [R], { ids: [0] });
    expect(cursor.read(j)).toBeNull(); // the first read: everything
    for (let k = 1; k <= 10_000; k++) j.record('buildings', [R], { ids: [k] });
    const seen = cursor.read(j);
    expect(seen).not.toBeNull();
    expect(seen!.length).toBe(10_000);
    expect(seen![0]!.ids).toEqual([1]);
  });

  it('keeps what a reader has not read, and lets it go once it has', () => {
    const j = new ChangeJournal();
    const cursor = new JournalCursor(['buildings'], true);
    cursor.read(j);
    for (let k = 0; k < 10_000; k++) j.record('buildings', [R], { ids: [k] });
    expect(kept(j, 'buildings')).toBeGreaterThanOrEqual(10_000);
    // The reader reads after each burst of a thousand: what it read goes, the diary stays small.
    for (let round = 0; round < 20; round++) {
      cursor.read(j);
      for (let k = 0; k < 1_000; k++) j.record('buildings', [R], { ids: [k] });
      expect(kept(j, 'buildings')).toBeLessThanOrEqual(2 * 2048 + 1_000);
    }
  });

  it('holds nothing for a reader that never read (it reads everything first)', () => {
    const j = new ChangeJournal();
    const reader: JournalReader = { kinds: ['buildings'], seenSerial: -1 };
    j.follow(reader);
    for (let k = 0; k < 10_000; k++) j.record('buildings', [R], { ids: [k] });
    expect(kept(j, 'buildings')).toBeLessThanOrEqual(2 * 2048);
  });

  it('keeps the last 2,048 of a kind for a reader that does not follow it, as before', () => {
    const j = new ChangeJournal();
    const at = j.version;
    for (let k = 0; k < 1_000; k++) j.record('buildings', [R], { ids: [k] });
    expect(j.since(at, ['buildings'])!.length).toBe(1_000);
    for (let k = 0; k < 10_000; k++) j.record('buildings', [R], { ids: [k] });
    expect(j.since(at, ['buildings'])).toBeNull();
  });
});

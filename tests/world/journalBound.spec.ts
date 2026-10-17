import { describe, expect, it } from 'vitest';
import { ChangeJournal, TILE_LOADED, TILE_UNLOADED, type ChangeRect, type JournalReader } from '@world/changes';
import { ChangeLog } from '@core/changeLog';

/** The diaries hold what the loaded tiles weigh, not the tiles the camera passed: the same after 2 tiles walked as after 20 */

/** A tile's records: `n` ids and a rectangle each. */
const tileOf = (t: number, n: number): { rects: ChangeRect[]; ids: number[] } => ({
  rects: Array.from({ length: n }, (_, k): ChangeRect => [t * 1000 + k, 0, t * 1000 + k + 1, 1]),
  ids: Array.from({ length: n }, (_, k) => t * 100_000 + k),
});

/** What a diary's ring and its kinds' logs hold, in rectangles and ids. */
type Held = { rects: unknown[] | null; ids?: unknown[] } | undefined;
const weigh = (list: readonly Held[]): number => list.reduce((n, e) => n + (e ? (e.rects?.length ?? 0) + (e.ids?.length ?? 0) : 0), 0);
const heldOf = (j: ChangeJournal): number => {
  const inside = j as unknown as { ring: Held[]; byKind: Map<string, { entries: Held[] }> };
  return weigh(inside.ring) + [...inside.byKind.values()].reduce((n, l) => n + weigh(l.entries), 0);
};

describe('a diary over tiles loaded and let go', () => {
  it('holds as much after 20 tiles walked as after 2, a reader stuck on the first one read whole again', () => {
    const journal = new ChangeJournal();
    // A reader that read once and never again (a store of something no longer shown).
    const stuck: JournalReader = { kinds: ['buildings'], seenSerial: 0 };
    journal.follow(stuck);
    const held: number[] = [];
    for (let t = 0; t < 20; t++) {
      // Three tiles in at a time: the next comes in, the oldest goes.
      const tile = tileOf(t, 20_000);
      journal.causeNext(TILE_LOADED);
      journal.record('buildings', tile.rects, { ids: tile.ids, cause: TILE_LOADED });
      if (t >= 3) {
        const gone = tileOf(t - 3, 20_000);
        journal.record('buildings', gone.rects, { ids: gone.ids, cause: TILE_UNLOADED });
      }
      held.push(heldOf(journal));
    }
    expect(held[19]).toBe(held[4]);
    expect(journal.since(0, ['buildings'])).toBeNull();
  });

  it("keeps a log's merged changes no larger than its owner holds", () => {
    let filed = 300;
    const log = new ChangeLog<readonly ChangeRect[]>({ weight: (boxes) => boxes.length, limit: () => filed });
    const stuck = log.state;
    const held = (): number => (log as unknown as { entries: { changes: (readonly ChangeRect[])[] | null }[] }).entries.reduce((n, e) => n + (e.changes ? e.changes.reduce((m, c) => m + c.length, 0) : 0), 0);
    const sizes: number[] = [];
    for (let t = 0; t < 20; t++) {
      log.push(tileOf(t, 300).rects);
      log.push(tileOf(t, 300).rects);
      filed = 300;
      sizes.push(held());
    }
    expect(sizes[19]).toBe(sizes[1]);
    expect(log.since(stuck)).toBeNull();
  });
});

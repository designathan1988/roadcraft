import { describe, expect, it } from 'vitest';
import { ChangeJournal, TILE_LOADED, TILE_UNLOADED, type ChangeRect } from '@world/changes';

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
  it('holds as much after 20 tiles walked as after 4 while its reader keeps up, and keeps for a reader what it has not read', () => {
    const journal = new ChangeJournal();
    // A reader that reads after each tile, and one that stops after the fifth.
    const reader: { kinds: readonly ['buildings']; seenSerial: number } = { kinds: ['buildings'], seenSerial: 0 };
    const late: { kinds: readonly ['buildings']; seenSerial: number } = { kinds: ['buildings'], seenSerial: 0 };
    journal.follow(reader);
    const held: number[] = [];
    for (let t = 0; t < 20; t++) {
      // Three tiles in at a time: the next comes in, the oldest goes.
      const tile = tileOf(t, 20_000);
      journal.record('buildings', tile.rects, { ids: tile.ids, cause: TILE_LOADED });
      if (t >= 3) {
        const gone = tileOf(t - 3, 20_000);
        journal.record('buildings', gone.rects, { ids: gone.ids, cause: TILE_UNLOADED });
      }
      reader.seenSerial = journal.version;
      held.push(heldOf(journal));
    }
    expect(held[19]).toBe(held[4]);
    // A live reader behind is never cut short: it reads every entry it has not read.
    late.seenSerial = journal.version;
    journal.follow(late);
    for (let t = 20; t < 30; t++) {
      const tile = tileOf(t, 20_000);
      journal.record('buildings', tile.rects, { ids: tile.ids, cause: TILE_LOADED });
      reader.seenSerial = journal.version;
    }
    expect(journal.since(late.seenSerial, ['buildings'])).toHaveLength(10);
  });
});

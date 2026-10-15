import { Heap } from '@core/heap';
import type { RoadDoc } from '../doc';
import { JournalCursor } from '../derived';
import { type Building, type BuildingId, DECAY_GRACE, DECAY_SPAN, decayOf } from './types';

/**
 * THE BUILDINGS' DECAY (`decayOf`), each building looked at only when its next
 * tenth is due. A record changes only when its decay moves a tenth.
 *
 * - What came or changed is read from the diary (`JournalCursor`). An
 *   entry without ids is the whole store replaced - cleared, a map loaded
 *   (`BuildingStore.changed(null, ...)`) - and, like a diary that forgot or a
 *   clock that went back, files the town again. DO NOT read `change.ids ?? []`:
 *   after a load the new town never ran down and the old one stayed due.
 * - The due times are a min-heap (`core/heap.ts`) with the current time of each
 *   building beside it; an entry that no longer matches is skipped when it
 *   comes up (Python heapq, "Priority Queue Implementation Notes": mark the
 *   entry removed, push the new one). A look costs the buildings due, not the
 *   town. DO NOT walk every building's due time on every look: that was the
 *   whole town every three seconds, cost by the map's size.
 */
export function createDecayWatch(doc: RoadDoc, wear: (id: BuildingId, decay: number) => void): (now: number) => boolean {
  /** Each built record's next tenth, city minutes; absent: fully run down or gone. */
  const due = new Map<BuildingId, number>();
  const queue = new Heap();
  const seen = new JournalCursor(['buildings'], true);
  let lastNow = -Infinity;
  const nextTenth = (b: Building, now: number): number => {
    if (b.builtAt === undefined) return Infinity;
    const decay = decayOf(b.builtAt, now);
    // `decayOf` rounds (now - builtAt - grace) / span to tenths: the next tenth at the half past this one.
    return decay >= 1 ? Infinity : b.builtAt + DECAY_GRACE + (DECAY_SPAN * (decay * 10 + 0.5)) / 10;
  };
  const file = (b: Building | undefined, id: BuildingId, now: number): void => {
    const at = b ? nextTenth(b, now) : Infinity;
    if (at === Infinity) { due.delete(id); return; }
    due.set(id, at);
    queue.push(id, at);
  };
  /** One look at city minute `now`; true when a building's decay changed. */
  return (now: number): boolean => {
    // A clock that went back reads the town again, as a diary that forgot does.
    if (now < lastNow) seen.reset();
    const changes = seen.read(doc.changes);
    lastNow = now;
    if (changes === null) {
      // @rebuild The diary forgot, or the clock went back: every building filed again.
      due.clear();
      queue.clear();
      for (const b of doc.buildings.all()) file(b, b.id, now);
    } else {
      for (const change of changes) for (const id of change.ids!) file(doc.buildings.get(id as BuildingId), id as BuildingId, now);
    }
    let changed = false;
    while (queue.peekKey() <= now) {
      const at = queue.peekKey();
      const id = queue.pop() as BuildingId;
      if (due.get(id) !== at) continue; // superseded by a later filing, or gone
      const b = doc.buildings.get(id);
      if (!b) { due.delete(id); continue; }
      const decay = decayOf(b.builtAt, now);
      if (decay !== (b.decay ?? 0)) { wear(id, decay); changed = true; }
      file(doc.buildings.get(id), id, now);
    }
    return changed;
  };
}

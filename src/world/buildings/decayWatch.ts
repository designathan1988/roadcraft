import { Heap } from '@core/heap';
import { IdSlots, grown } from '@core/idSlots';
import type { RoadDoc } from '../doc';
import { JournalCursor } from '../derived';
import { type Building, type BuildingId, DECAY_GRACE, DECAY_SPAN, decayOf } from './types';

/** DO NOT read `change.ids ?? []`: after a load the new town never ran down and the old one stayed due. */
export function createDecayWatch(doc: RoadDoc, wear: (id: BuildingId, decay: number) => void): (now: number) => boolean {
  /** Each built record's next tenth, city minutes, in a column by its id's slot; no slot: fully run down or gone. DO NOT keep a `Map` entry a building: the whole city is filed here. */
  const slots = new IdSlots(1024);
  let dueAt = new Float64Array(16);
  slots.onGrow = (n) => { dueAt = grown(dueAt, n); };
  const dueOf = (id: BuildingId): number | undefined => { const slot = slots.get(id); return slot < 0 ? undefined : dueAt[slot]; };
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
    if (at === Infinity) { slots.delete(id); return; }
    // The slot taken first: taking it may grow the column (`onGrow`), and the column read before it would be the old one.
    const slot = slots.take(id);
    dueAt[slot] = at;
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
      slots.clear();
      queue.clear();
      for (const b of doc.buildings.all()) file(b, b.id, now);
    } else {
      for (const change of changes) for (const id of change.ids!) file(doc.buildings.get(id as BuildingId), id as BuildingId, now);
    }
    let changed = false;
    while (queue.peekKey() <= now) {
      const at = queue.peekKey();
      const id = queue.pop() as BuildingId;
      if (dueOf(id) !== at) continue; // superseded by a later filing, or gone
      const b = doc.buildings.get(id);
      if (!b) { slots.delete(id); continue; }
      const decay = decayOf(b.builtAt, now);
      if (decay !== (b.decay ?? 0)) { wear(id, decay); changed = true; }
      file(doc.buildings.get(id), id, now);
    }
    return changed;
  };
}

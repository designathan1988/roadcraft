import { describe, expect, it } from 'vitest';

import { gardenLists } from '@render/gardenLists';
import type { GardenChange, GardenPlant } from '@render/gardens';
import type { GroundRecord, Rect } from '@render/groundChanges';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building, BuildingElement, BuildingId } from '@world/buildings/types';
import { RoadDoc } from '@world/doc';
import { m } from '@world/units';

/** The gardens' lists taken in a change at a time, by the ids the diary gives (`BuildingStore.changedSince`, AUDITORIA C2) */
const still: GroundRecord = { version: 0, touches: () => false };
const bank = (b: Building): Rect => [b.x - m(20), b.y - m(20), b.x + m(20), b.y + m(20)];
/** A building's plants as the renderer's sampling would give them: one per plant element, where it stands. */
const plantsOf = (b: Building): readonly GardenPlant[] =>
  (b.elements ?? []).filter((e) => e.kind === 'tree' || e.kind === 'shrub').map((e) => ({ x: b.x + e.x, y: b.y + e.y, kind: e.kind }) as unknown as GardenPlant);

function body(i: number, x: number, y: number, planted: boolean): Omit<Building, 'id'> {
  const bp = BLUEPRINTS[i % BLUEPRINTS.length]!;
  const b = { ...JSON.parse(JSON.stringify(bp.body)), x, y, rotation: 0 } as Omit<Building, 'id'>;
  if (!planted) return b;
  const tree: BuildingElement = { id: 9_000 + i, kind: 'tree', x: 1, y: 2, facing: 0, w: m(1), d: m(1), z: 0, h: m(6) };
  return { ...b, elements: [...(b.elements ?? []), tree] };
}

describe('the gardens, a change at a time', () => {
  it('give the lists a reader made from nothing gives', () => {
    let seed = 5;
    const rand = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const doc = new RoadDoc();
    for (let i = 0; i < 30; i++) doc.buildings.add(body(i, (i % 6) * m(60), Math.floor(i / 6) * m(60), rand() < 0.6));
    const live = gardenLists(still, bank, plantsOf);
    /** The lists the gardens hold, as the changes handed to them leave them. */
    const held = new Set<readonly GardenPlant[]>();
    const apply = (change: GardenChange | null): void => {
      if (!change) return;
      for (const list of change.removed) { expect(held.has(list)).toBe(true); held.delete(list); }
      for (const list of change.added) held.add(list);
    };
    const texts = (lists: Iterable<readonly GardenPlant[]>): string[] => [...lists].map((list) => JSON.stringify(list)).sort();
    apply(live.update(doc.buildings, true));
    let placed = 0;
    for (let round = 0; round < 40; round++) {
      const ids = [...doc.buildings.all()].map((b) => b.id);
      const pick = ids[Math.floor(rand() * ids.length)]! as BuildingId;
      const roll = rand();
      if (roll < 0.3) doc.buildings.add(body(round, rand() * m(400), rand() * m(400), rand() < 0.7));
      else if (roll < 0.45) doc.buildings.remove(pick);
      else if (roll < 0.7) { const b = doc.buildings.get(pick)!; doc.buildings.put({ ...b, x: b.x + m(5) }); }
      else if (roll < 0.85) { const b = doc.buildings.get(pick)!; doc.buildings.put({ ...b, palette: (b.palette + 1) % 8 }); }
      else { const b = doc.buildings.get(pick)!; doc.buildings.put({ ...b, elements: (b.elements ?? []).filter((e) => e.kind !== 'tree') }); }
      const change = live.update(doc.buildings, true);
      apply(change);
      const whole = gardenLists(still, bank, plantsOf).update(doc.buildings, true)?.added ?? [];
      // A repaint changes no garden: nothing placed again.
      if (change) placed++;
      expect(texts(held)).toEqual(texts(whole));
    }
    expect(placed).toBeGreaterThan(15);
  });
});

describe('the gardens when the ground moves', () => {
  /** A ground that moved in the rectangles given, after each serial, and counts the questions asked of it. */
  function ground(): GroundRecord & { moves: { serial: number; rect: Rect }[]; asked: number; move(rect: Rect): void } {
    const g = {
      version: 0, asked: 0, moves: [] as { serial: number; rect: Rect }[],
      move(rect: Rect) { g.version++; g.moves.push({ serial: g.version, rect }); },
      touches: () => { g.asked++; return true; },
      rectsSince: (since: number) => g.moves.filter((x) => x.serial > since).map((x) => x.rect),
    };
    return g;
  }

  it('find the buildings a change reached by place, never asking the record of each', () => {
    const doc = new RoadDoc();
    for (let i = 0; i < 400; i++) doc.buildings.add(body(i, (i % 20) * m(100), Math.floor(i / 20) * m(100), true));
    const g = ground();
    const lists = gardenLists(g, bank, plantsOf);
    expect(lists.update(doc.buildings, true)!.added).toHaveLength(400);
    // The ground cut and filled round one building's bank (the one at 500 m, 500 m).
    g.move([m(495), m(495), m(505), m(505)]);
    const change = lists.update(doc.buildings, true)!;
    expect(change.added).toHaveLength(1);
    expect(change.removed).toHaveLength(1);
    // DO NOT ask every planted building whether the ground moved under it.
    expect(g.asked).toBe(0);
  });
});

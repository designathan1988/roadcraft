import { describe, expect, it } from 'vitest';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import { createDecayWatch } from '@world/buildings/decayWatch';
import { DECAY_GRACE, DECAY_SPAN, type Building, type BuildingId } from '@world/buildings/types';
import { RoadDoc } from '@world/doc';
import { m } from '@world/units';

/**
 * THE BUILDINGS RUN DOWN AFTER A MAP IS LOADED, AND A LOOK COSTS WHAT IS DUE
 * (`world/buildings/decayWatch.ts`): a store cleared or loaded writes one diary
 * entry without ids, which files the town again; and the due times are a heap,
 * so a look with nothing due touches nothing.
 */
const house = (i: number, builtAt: number): Omit<Building, 'id'> =>
  ({ ...JSON.parse(JSON.stringify(BLUEPRINTS[0]!.body)), x: (i % 40) * m(30), y: Math.floor(i / 40) * m(30), rotation: 0, builtAt } as Omit<Building, 'id'>);

/** A watch whose wear is applied to the store, counting each look's wear. */
function watched(doc: RoadDoc): { look: (now: number) => boolean; worn: BuildingId[] } {
  const worn: BuildingId[] = [];
  const look = createDecayWatch(doc, (id, decay) => { worn.push(id); doc.buildings.wear(id, decay); });
  return { look, worn };
}

describe("the buildings' decay", () => {
  it('reaches the buildings of a map loaded after the first look', () => {
    const doc = new RoadDoc();
    doc.buildings.add(house(0, 0));
    const { look } = watched(doc);
    look(0);
    // A map opened: the store loaded whole (one entry without ids).
    const other = new RoadDoc();
    for (let i = 0; i < 3; i++) other.buildings.add(house(i, 0));
    doc.buildings.load(other.buildings.toJSON());
    look(1);
    look(DECAY_GRACE + DECAY_SPAN * 0.5);
    for (const b of doc.buildings.all()) expect(b.decay ?? 0, `building ${b.id}`).toBeGreaterThan(0);
  });

  it('touches only the buildings due, however big the town', () => {
    const work = (count: number): number => {
      const doc = new RoadDoc();
      // One building old enough to be due; the rest built later, none due yet.
      doc.buildings.add(house(0, 0));
      for (let i = 1; i < count; i++) doc.buildings.add(house(i, DECAY_SPAN));
      const { look, worn } = watched(doc);
      look(0);
      worn.length = 0;
      look(DECAY_GRACE + DECAY_SPAN * 0.06);
      return worn.length;
    };
    expect(work(50)).toBe(1);
    expect(work(800)).toBe(1);
  });
});

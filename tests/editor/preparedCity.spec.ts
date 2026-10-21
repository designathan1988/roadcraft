import { describe, expect, it } from 'vitest';
import { prepareCity, preparedCity } from '@editor/preparedCity';
import { generateBody } from '@world/buildings/blueprints';
import { refOf } from '@world/buildings/recordTable';
import type { Building } from '@world/buildings/types';
import { RoadDoc, type SerializedDoc } from '@world/doc';
import { m } from '@world/units';

const house = (id: number, x: number, floors: number): Building => ({ ...generateBody('residential', m(20), m(20), floors), id, x, y: m(100), rotation: 0 }) as unknown as Building;

/** A map of buildings as the city's generator answers it (`cityGen.worker.ts`), one id twice. */
function city(): SerializedDoc {
  const doc = new RoadDoc().toJSON();
  const buildings = [house(1, 0, 2), house(2, m(30), 2), house(3, m(60), 5), house(3, m(90), 1)];
  return JSON.parse(JSON.stringify({ ...doc, buildings })) as SerializedDoc;
}

describe('a city prepared off the page', () => {
  it('opens the very buildings the plain map opens, each a row of one shared table, adopted by the page\'s document as they are', () => {
    const plain = new RoadDoc();
    plain.replaceFromJSON(city());
    const { data, buildings } = prepareCity(city());
    // Posted with no building objects: the table alone carries them.
    expect(data.buildings).toEqual([]);
    const opened = preparedCity(data, buildings);
    expect(opened.prepared).toBe(true);
    const doc = new RoadDoc();
    doc.replaceFromJSON(opened.data, { preparedBuildings: opened.prepared });
    const read = [...doc.buildings.all()];
    expect(JSON.stringify(read)).toBe(JSON.stringify([...plain.buildings.all()]));
    expect(read.map((b) => b.id)).toEqual([1, 2, 3]);
    // The records read from the table are the document's own (not walked and copied again), each knowing its row: no table of its own made for a job.
    expect(read.every((b, k) => b === (opened.data.buildings as unknown as Building[])[k])).toBe(true);
    expect(new Set(read.map((b) => refOf(b).buffer))).toEqual(new Set([buildings]));
    // Their members alike shared, as the page's interning shares them.
    expect(read[0]!.volumes.length).toBeGreaterThan(0);
    expect(read[0]!.volumes).toBe(read[1]!.volumes);
  });
});

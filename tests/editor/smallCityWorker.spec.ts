import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { buildSmallCityMap, preparedSmallCity } from '@editor/smallCityMap';

/** THE SMALL CITY MADE IN A WORKER IS THE CITY MADE ON THE PAGE (`smallCity.worker.ts`, `smallCityPool.ts`) */
describe('the small city made off the page', () => {
  it('files the same document from the records sent as they are (cloned as a message, loaded prepared)', () => {
    const seed = 7;
    // As the worker sends it: the records themselves, through the message's clone.
    const sent = structuredClone(preparedSmallCity(seed));
    const prepared = RoadDoc.fromJSON(sent, { preparedBuildings: true });
    // As the page made it before: the JSON, every record migrated and interned.
    const onPage = RoadDoc.fromJSON(buildSmallCityMap(seed));
    expect(prepared.buildings.size).toBeGreaterThan(100);
    expect(JSON.stringify(prepared.toJSON())).toBe(JSON.stringify(onPage.toJSON()));
  });
});

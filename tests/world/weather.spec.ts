import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { DEFAULT_WEATHER, readWeather, windVector } from '@world/weather';
import { CLOUD_SPAN, driftedCloud } from '@world/clouds';

describe('the map’s weather', () => {
  it('is kept in the map, in range, and moves its revision only on a change', () => {
    const doc = new RoadDoc();
    const before = doc.weatherRevision;
    doc.setWeather({ rain: 0 });
    expect(doc.weatherRevision).toBe(before);
    doc.setWeather({ rain: 2, wind: 12, windDirection: 400, lightning: 6 });
    expect(doc.weather).toMatchObject({ rain: 1, wind: 12, windDirection: 0, lightning: 6 });
    const loaded = RoadDoc.fromJSON(doc.toJSON());
    expect(loaded.weather).toEqual(doc.weather);
    expect(RoadDoc.fromJSON(new RoadDoc().toJSON()).weather).toEqual(DEFAULT_WEATHER);
    expect(readWeather({ wind: -3 }).wind).toBe(0);
  });

  it('blows the way it is set, and carries the clouds round the map without a pop', () => {
    const east = windVector({ ...DEFAULT_WEATHER, wind: 10, windDirection: 0 }, 2);
    expect(east.x).toBeCloseTo(20);
    expect(east.y).toBeCloseTo(0);
    const cloud = { id: 1, x: 0, y: 0, height: 400, size: 300, density: 1, yaw: 0 };
    expect(driftedCloud(cloud, { x: 100, y: 0 })).toMatchObject({ x: 100, y: 0, show: 1 });
    // Past the edge of the sky's period it comes round the other side, faded out there.
    const wrapped = driftedCloud(cloud, { x: CLOUD_SPAN * 0.5 + 10, y: 0 });
    expect(wrapped.x).toBeLessThan(0);
    expect(wrapped.show).toBeLessThan(0.01);
  });

  it('has its clouds over any part of the world: each one\'s repeat nearest where the view looks', () => {
    const cloud = { id: 1, x: 120, y: -40, height: 400, size: 300, density: 1, yaw: 0 };
    const far = { x: CLOUD_SPAN * 37 + 50, y: -CLOUD_SPAN * 12 };
    const seen = driftedCloud(cloud, { x: 30, y: 0 }, far);
    expect(seen.x).toBeCloseTo(CLOUD_SPAN * 37 + 150, 6);
    expect(seen.y).toBeCloseTo(-CLOUD_SPAN * 12 - 40, 6);
    expect(seen.show).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { MAX_PLACED_CLOUDS, cloudUnder } from '@world/clouds';

describe('placed clouds', () => {
  it('are kept in the map: added, moved, adjusted, removed, saved and loaded', () => {
    const doc = new RoadDoc();
    const a = doc.addCloud({ x: 0, y: 0, height: 450, size: 375, density: 0.8, yaw: 0 })!;
    const b = doc.addCloud({ x: 500, y: 200, height: 600, size: 300, density: 0.5, yaw: 1 })!;
    doc.updateCloud(a.id, { x: 100, size: 500 });
    doc.removeCloud(b.id);
    const loaded = RoadDoc.fromJSON(doc.toJSON());
    expect(loaded.clouds).toEqual([{ ...a, x: 100, size: 500 }]);
  });

  it('holds no more than the sky draws', () => {
    const doc = new RoadDoc();
    for (let i = 0; i < MAX_PLACED_CLOUDS; i++) expect(doc.addCloud({ x: i, y: 0, height: 450, size: 375, density: 1, yaw: 0 })).not.toBeNull();
    expect(doc.addCloud({ x: 0, y: 0, height: 450, size: 375, density: 1, yaw: 0 })).toBeNull();
  });

  it('is picked where the pointer ray crosses its body', () => {
    const clouds = [{ id: 1, x: 0, y: 0, height: 450, size: 300, density: 1, yaw: 0 }, { id: 2, x: 1000, y: 0, height: 450, size: 300, density: 1, yaw: 0 }];
    expect(cloudUnder(clouds, () => ({ x: 980, y: 30 }))?.id).toBe(2);
    expect(cloudUnder(clouds, () => ({ x: 500, y: 0 }))).toBeNull();
  });

  it('is the one nearest the camera where the ray passes through two', () => {
    // A slanting ray (the camera up and to the -x side) through a small cloud
    // in front and a huge one behind it.
    const ray = (h: number): { x: number; y: number } => ({ x: 600 - h, y: 0 });
    const front = { id: 1, x: 0, y: 0, height: 500, size: 300, density: 1, yaw: 0 };
    const behind = { id: 2, x: 900, y: 0, height: 0, size: 1000, density: 1, yaw: 0 };
    expect(cloudUnder([behind, front], ray)?.id).toBe(1);
    expect(cloudUnder([behind], ray)?.id).toBe(2);
  });
});

import { describe, expect, it } from 'vitest';

import { Rng } from '@core/rng';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { blueprintByKey } from '@world/buildings/blueprints';
import { pickBuilding, type Ray3 } from '@world/buildings/pick';
import type { Building } from '@world/buildings/types';
import { m } from '@world/units';
import { type BuildingContext, placeBuilding } from '@editor/buildings';
import { pickAlongRay } from '@editor/buildingTool';

/** THE PICK UNDER THE POINTER reads the buildings along the ray's track, not the city (`pickAlongRay`) */
describe('picking a building along the ray', () => {
  it('finds the same face as a look at every building, for rays from every side', () => {
    const doc = new RoadDoc();
    const net = new Network(doc);
    net.rebuild();
    const ctx: BuildingContext = { doc, net, groundAt: () => 0 };
    const rng = new Rng(7);
    const keys = ['house', 'shop', 'tower', 'apartments', 'office'].filter((k) => blueprintByKey(k));
    for (let i = 0; i < 160; i++) {
      const bp = blueprintByKey(keys[i % keys.length]!)!;
      placeBuilding(ctx, bp.body, { x: (rng.float() - 0.5) * m(1200), y: (rng.float() - 0.5) * m(1200) }, rng.float() * Math.PI * 2, bp.key);
    }
    expect(doc.buildings.size).toBeGreaterThan(40);
    const floorOf = (): number => 0;
    let hits = 0;
    for (let k = 0; k < 400; k++) {
      // An eye up in the air looking down at a slant, somewhere over the town.
      const azimuth = rng.float() * Math.PI * 2, tilt = 0.15 + rng.float() * 1.3;
      const dx = Math.cos(azimuth) * Math.cos(tilt), dy = Math.sin(azimuth) * Math.cos(tilt), dz = -Math.sin(tilt);
      const ray: Ray3 = { ox: (rng.float() - 0.5) * m(1400), oy: (rng.float() - 0.5) * m(1400), oz: m(40 + rng.float() * 300), dx, dy, dz };
      const all = pickBuilding([...doc.buildings.all()] as Building[], ray, floorOf);
      const walked = pickAlongRay(doc.buildings, ray, null, floorOf);
      expect(walked?.building ?? null, `ray ${k}`).toBe(all?.building ?? null);
      if (all) {
        hits++;
        expect(walked!.t).toBeCloseTo(all.t, 6);
        expect(walked!.face).toBe(all.face);
      }
    }
    expect(hits).toBeGreaterThan(10);
  });

  it('walks the ray only where it can meet a roof: a few cells for a view from above, not sixteen kilometres', () => {
    let asked = 0;
    const store = { near: () => { asked++; return [] as Building[]; } };
    // From 300 m up, looking down at 30 degrees: under the land well before a kilometre and a half.
    const tilt = Math.PI / 6;
    const ray: Ray3 = { ox: 0, oy: 0, oz: m(300), dx: Math.cos(tilt), dy: 0, dz: -Math.sin(tilt) };
    expect(pickAlongRay(store, ray, null, () => 0)).toBeNull();
    expect(asked).toBeLessThan(110);
    // Looking up from the ground: nothing to walk past the highest roof.
    asked = 0;
    pickAlongRay(store, { ...ray, oz: m(2), dz: 0.5 }, null, () => 0);
    expect(asked).toBeLessThan(110);
  });
});

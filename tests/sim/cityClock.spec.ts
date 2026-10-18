import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { DT } from '@sim/params';

/** A SAVED CITY'S TIME OF DAY COMES BACK WITH IT: the clock put at the saved minutes, and running on from there */
describe('the city clock', () => {
  it('starts at 06:30, is put at a saved time and keeps running from it', () => {
    const doc = new RoadDoc();
    const net = new Network(doc);
    net.rebuild();
    const w = new SimWorld(doc, net);
    expect(w.city.minutes(w)).toBeCloseTo(6 * 60 + 30, 6);
    w.clock.tick = 1234;
    w.city.setMinutes(w, 19 * 60 + 5);
    expect(w.city.minutes(w)).toBeCloseTo(19 * 60 + 5, 6);
    w.clock.tick += Math.round(60 / DT);
    expect(w.city.minutes(w)).toBeGreaterThan(19 * 60 + 5);
  });
});

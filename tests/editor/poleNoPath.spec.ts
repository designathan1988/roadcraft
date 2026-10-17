import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { planPoleRun, planPoleRunWhole, poleRouteWork } from '@editor/poles';

/** A POLE RUN BETWEEN STREETS NO LINE JOINS IS REFUSED AT ONCE, NOT AFTER GROWING THE REGION TO 4 KM (`poles.ts` routeRun, plan E4) */
describe('a pole run with no way between its ends', () => {
  it('is refused after one region, as a plan over the whole map refuses it', () => {
    const doc = new RoadDoc();
    // Two streets 300 m apart, joined by nothing.
    for (const y of [0, m(300)]) {
      const a = doc.addNode({ x: m(-150), y }), b = doc.addNode({ x: m(150), y });
      doc.addSegment(a.id, b.id, 1);
    }
    const net = new Network(doc);
    net.rebuild();
    const from = { x: 0, y: m(5.6) }, to = { x: 0, y: m(300) + m(5.6) };
    const before = poleRouteWork.regions;
    const plan = planPoleRun(doc, net, from, to, m(6));
    expect(plan.refused).toBe('noPath');
    expect(poleRouteWork.regions - before).toBeLessThanOrEqual(2);
    expect(planPoleRunWhole(doc, net, from, to, m(6)).refused).toBe('noPath');
  });
});

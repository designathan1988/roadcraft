import { describe, expect, it, vi } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { SimWorld } from '@sim/world';
import { Meso } from '@sim/meso/meso';
import { DT } from '@sim/params';

/** THE SCENERY WITH THE MESO TRAFFIC DOES NOT MEASURE THE ROADS FOR DRIVERS IT DOES NOT MAKE (`AmbientWorld.step`) */
describe('the scenery round the view with the meso traffic', () => {
  it('measures the roads for its walkers only', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: 0, y: 0 }), b = doc.addNode({ x: m(200), y: 0 });
    doc.addSegment(a.id, b.id, 1);
    const net = new Network(doc);
    net.rebuild();
    const w = new SimWorld(doc, net, 3);
    w.rebuildTopology();
    w.ambient.enabled = true;
    w.ambient.source = 'view';
    w.focus = { x: m(100), y: 0, r: m(150), detail: true };
    const street = (w.ambient as unknown as { street: { around: (...args: unknown[]) => number } }).street;
    const around = vi.spyOn(street, 'around');
    const looks = (): number => { around.mockClear(); for (let t = 0; t < Math.ceil(0.25 / DT) + 1; t++) w.ambient.step(w); return around.mock.calls.length; };
    expect(looks()).toBe(2);
    w.meso = new Meso();
    expect(looks()).toBe(1);
  });
});

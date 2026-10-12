import { describe, expect, it } from 'vitest';
import { U, borderShift } from './_border';
import type { Vec2 } from '@core/vec2';
import { TILES_PER_SIDE } from '@core/planetTiles';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { tileCentre } from '@world/planet/atlas';
import { chartAt, onChartOf, toOwner } from '@world/planet/charts';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { commitRoadPath } from '@editor/commit';
import { growOnLot } from '@editor/zoning';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { collectBays } from '@sim/agents/parking';
import { DT } from '@sim/params';

/**
 * CARS IN AND OUT OF THE LOTS ALONG A STREET ACROSS THE PIECES' BORDERS
 * (`sim/agents/lotTraffic.ts`, `parking.ts`). Run with `vitest.planet.config.ts`.
 *
 * A street on the planet runs over several pieces, each kept on its own chart:
 * a lot's stalls must find the lane in front of their gate on the street's
 * chart, and the cars sent to them must drive in and out again.
 */
const chart = 2 * TILES_PER_SIDE * TILES_PER_SIDE + 5 * TILES_PER_SIDE + 5;
const c = tileCentre(chart);
const at = (x: number, y: number): Vec2 => toOwner(chart, { x: c.x + x, y: c.y + y });

describe('the lots\' cars on the planet', () => {
  it('reach their stalls from the lane and drive in and out across the borders', () => {
    const doc = new RoadDoc();
    doc.setBalance(1e9);
    const net = new Network(doc);
    net.rebuild();
    // Across both borders, as the borders moved (`_border.ts`).
    const a = at(-420 * U - borderShift(chart, -1, 0), 0), b = onChartOf(at(420 * U + borderShift(chart, 1, 0), 0), a);
    expect(commitRoadPath(doc, net, { kind: 'free', at: a }, { kind: 'free', at: b }, 1,
      [{ start: { at: a, heightOffset: 0 }, end: { at: b, heightOffset: 0 }, curve: null }]).committed).toBe(true);
    if (net.revision !== doc.revision) net.rebuild();
    applyLots(doc, planLots(doc, net));
    zoneLots(doc, doc.lots.map((l) => l.id), { use: 'residential', density: 'medium' });
    const refused = new Set<number>();
    for (let k = 0; k < doc.lots.length * 3; k++) {
      if (growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
    }
    const w = new SimWorld(doc, net, 7);
    w.rebuildTopology();
    // The panel's number of cars (the game sets it from the traffic slider).
    w.trafficCount = 20;
    // The scenery on, with its cars coming in at the road ends, as the game runs it (`main.ts`).
    w.ambient.enabled = true;
    w.ambient.source = 'edges';
    const parks = [...doc.buildings.all()].filter((bd) => (bd.elements ?? []).some((e) => e.kind === 'parking'));
    // On more than one piece.
    expect(new Set(parks.map((bd) => chartAt(bd.x, bd.y))).size).toBeGreaterThan(1);
    const bays = collectBays(w).filter((bay) => !bay.kerb && parks.some((bd) => bd.id === bay.building));
    expect(bays.length).toBeGreaterThan(4);
    const reached = bays.filter((bay) => bay.lane?.entryAt !== undefined && bay.via.length > 0);
    expect(reached.length / bays.length).toBeGreaterThan(0.8);
    // Five minutes of the town: cars sent into the lots, parked, and out again.
    for (let i = 0; i < 300 / DT; i++) step(w, { traffic: true, pedestrians: false });
    const lots = w.city.lots;
    expect(lots.called).toBeGreaterThan(0);
    expect(lots.parkedIn + lots.leftBy).toBeGreaterThan(0);
  }, 180_000);
});

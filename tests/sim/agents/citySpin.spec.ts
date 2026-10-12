import { describe, expect, it } from 'vitest';

import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { createAgentWalkEngine } from '@sim/agents/walk';
import { m } from '@world/units';
import { Network } from '@world/network';
import { applyLots, planLots } from '@world/lots';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import type { BuildingId } from '@world/buildings/types';
import { greenCity, layCity, widenCityFootways, zoneCity } from '@editor/cityGenerator';
import { LOT_PLAN_VERSION, growOnLot } from '@editor/zoning';

/** The city exactly as `main.ts` `generateCity` and `growCity` make it, on the given ground. */
function gameCity(groundAt: (x: number, y: number) => number): { doc: ReturnType<typeof layCity>; net: Network } {
  const plan = planCity(DEFAULT_CITY);
  const doc = layCity(plan);
  widenCityFootways(doc);
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  greenCity(doc, net, DEFAULT_CITY.seed);
  const zoned = zoneCity(doc, plan);
  const refused = new Set<number>();
  for (let guard = 0; guard < zoned * 3 + 50; guard++) {
    const id = growOnLot({ doc, net, groundAt }, refused, 0x5eed);
    if (id === null) {
      const open = doc.lots.some((l) => l.use && (l.building === undefined || !doc.buildings.has(l.building as BuildingId)) && !refused.has(l.id));
      if (!open) break;
      continue;
    }
    const fresh = doc.buildings.get(id as BuildingId);
    if (fresh) doc.buildings.put({ ...fresh, builtAt: 0, decay: 0, lotPlan: LOT_PLAN_VERSION });
  }
  if (net.revision !== doc.revision) net.rebuild();
  return { doc, net };
}

/**
 * NOBODY SPINS ON THE SPOT (Etapa 5a). In the generated city a walker on a
 * short stretch of a back yard's path, a little aside of it, steered for the
 * stretch's end at more than 60°, stood, turned and circled it at 4 rad/s,
 * never reaching the end (2026-10-10, by a barbecue). A spin is the heading
 * round more than a whole turn within 2 s (turning back is half a turn) while the body stays within half a
 * metre. Run on the city `main.ts` generates, with the scenery's people.
 */
describe('walkers in the generated city', () => {
  it('never spin on the spot', () => {
    // A gentle hillside, as new maps are born (the yards terraced, with steps).
    const city = gameCity((x, y) => -y * 0.08 + x * 0.04);
    const sim = new SimWorld(city.doc, city.net, 0x5917);
    sim.rebuildTopology();
    sim.clock.paused = false;
    sim.usePedestrianEngine(createAgentWalkEngine());
    sim.ambient.enabled = true;
    sim.ambient.source = 'edges';
    sim.pedestrianCount = 300;
    const windows = new Map<number, { x: number; y: number; heading: number; t: number }>();
    const spinning = new Set<number>();
    let detail = '', samples = 0;
    const ticks = Math.round(120 / DT);
    for (let i = 0; i < ticks; i++) {
      step(sim, { traffic: false, pedestrians: true });
      if (i % 6) continue;
      for (const p of sim.pedViews) {
        samples++;
        const w = windows.get(p.id);
        if (!w || i - w.t >= Math.round(2 / DT)) { windows.set(p.id, { x: p.x, y: p.y, heading: p.heading, t: i }); continue; }
        if (Math.abs(p.heading - w.heading) > 2 * Math.PI && Math.hypot(p.x - w.x, p.y - w.y) < m(0.5) && !spinning.has(p.id)) {
          spinning.add(p.id);
          detail ||= `walker ${p.id} (${p.ground}) at ${p.x.toFixed(1)},${p.y.toFixed(1)}: ${(p.heading - w.heading).toFixed(1)} rad in ${((i - w.t) * DT).toFixed(1)} s`;
        }
      }
    }
    expect(samples).toBeGreaterThan(100_000);
    expect(spinning.size, detail).toBe(0);
  }, 900_000);
});

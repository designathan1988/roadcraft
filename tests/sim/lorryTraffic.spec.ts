import { describe, expect, it, vi } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import type { BuildingId } from '@world/buildings/types';
import { growOnLot } from '@editor/zoning';
import { SimWorld } from '@sim/world';
import type { Driver } from '@sim/vehicles/driver';
import { LorryTraffic, YardList } from '@sim/agents/lorryTraffic';

/** Every yard begun (`buildYard`) and every one made to the end, by building. */
const yards = vi.hoisted(() => ({ begun: [] as number[], made: [] as number[] }));
vi.mock('@sim/agents/lorryDocks', async (importOriginal) => {
  const real = await importOriginal<typeof import('@sim/agents/lorryDocks')>();
  function* buildYard(...args: Parameters<typeof real.buildYard>): ReturnType<typeof real.buildYard> {
    yards.begun.push(args[0].id);
    const yard = yield* real.buildYard(...args);
    yards.made.push(args[0].id);
    return yard;
  }
  return { ...real, buildYard };
});

/** THE LORRIES' OWN WORK IS NOT THROWN AWAY, AND A NEW MAP DRAWS AS THE FIRST. - A yard is made a slice a tick */
function works(): { doc: RoadDoc; w: SimWorld } {
  const doc = new RoadDoc();
  const n = 2, block = 120, ids: number[][] = [];
  for (let i = 0; i <= n; i++) { ids.push([]); for (let j = 0; j <= n; j++) ids[i]!.push(doc.addNode({ x: m(block) * (i - n / 2), y: m(block) * (j - n / 2) }).id); }
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      if (i < n) doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, 1);
      if (j < n) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, 1);
    }
  }
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  doc.lots.forEach((l) => zoneLots(doc, [l.id], { use: 'industrial', density: 'medium' }));
  const refused = new Set<number>();
  for (let k = 0; k < doc.lots.length * 3; k++) {
    if (growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed + k) === null && refused.size >= doc.lots.length) break;
  }
  const w = new SimWorld(doc, net, 0x10221);
  w.rebuildTopology();
  return { doc, w };
}

describe('the lorries to the docks', () => {
  it('make each yard once: the yard in hand is not thrown away for another', () => {
    const { doc, w } = works();
    const list = new YardList().read(doc);
    expect(list.length).toBeGreaterThan(1);
    yards.begun.length = 0;
    yards.made.length = 0;
    const lorries = new LorryTraffic();
    // A minute of looks with no lorry on the road: the yards are drawn, made and planned.
    for (let k = 0; k < 60 * 60; k++) lorries.step(w, () => false);
    expect(yards.made.length).toBeGreaterThan(0);
    // Each yard begun once (the map does not change), and all but the one in hand made.
    expect(new Set(yards.begun).size).toBe(yards.begun.length);
    expect(yards.begun.length - yards.made.length).toBeLessThanOrEqual(1);
  });

  it('draw again from their seed when the world is reset', () => {
    const { doc, w } = works();
    const lorries = new LorryTraffic();
    const driverOf = (building: BuildingId): Driver => {
      const kept = (lorries as unknown as { lorries: Map<number, { building: BuildingId; body: { driver: Driver } | null }> }).lorries;
      const lorry = [...kept.values()].find((l) => l.building === building);
      return { ...lorry!.body!.driver };
    };
    // The first dock of the town with a way in and out.
    let sent: { building: BuildingId; dock: number } | null = null;
    for (const y of new YardList().read(doc)) {
      for (let dock = 0; dock < y.docks && !sent; dock++) if (lorries.sendNow(w, y.building, dock)) sent = { building: y.building, dock };
      if (sent) break;
    }
    expect(sent).not.toBeNull();
    const before = driverOf(sent!.building);
    // A map opened (`main.ts`): the world and its scenery reset; the lorries' draws are the world's.
    w.reset();
    lorries.reset(w);
    expect(lorries.sendNow(w, sent!.building, sent!.dock)).toBe(true);
    expect(driverOf(sent!.building)).toEqual(before);
  });
});

import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { growOnLot } from '@world/growth/zoning';
import { SimWorld } from '@sim/world';
import { ARCHETYPES } from '@sim/vehicles/archetypes';
import { type Holonomic, WaySearch, bodyClearExact, clearanceOf } from '@sim/agents/hybridAStar';
import { Rng } from '@core/rng';
import { buildYard, knownYard, lorryOf, yardKey } from '@sim/agents/lorryDocks';

/** A WORKS' YARD IS MADE A SLICE A TICK. */
function works(): RoadDoc {
  const doc = new RoadDoc();
  const ids: number[][] = [];
  for (let i = 0; i <= 1; i++) { ids.push([]); for (let j = 0; j <= 1; j++) ids[i]!.push(doc.addNode({ x: m(120) * (i - 0.5), y: m(120) * (j - 0.5) }).id); }
  for (let i = 0; i <= 1; i++) {
    for (let j = 0; j <= 1; j++) {
      if (i < 1) doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, 1);
      if (j < 1) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, 1);
    }
  }
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  doc.lots.forEach((l) => zoneLots(doc, [l.id], { use: 'industrial', density: 'medium' }));
  const refused = new Set<number>();
  for (let k = 0; k < doc.lots.length * 3; k++) {
    if (growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
  }
  return doc;
}

describe('a works yard', () => {
  it('is made over many slices, the same as at once', () => {
    const doc = works();
    const net = new Network(doc);
    net.rebuild();
    const w = new SimWorld(doc, net, 0x0be9);
    w.rebuildTopology();
    const b = [...w.buildings.all()].find((x) => knownYard(w, x) !== null);
    expect(b).toBeDefined();
    const steps = buildYard(b!, yardKey(w), w, lorryOf(ARCHETYPES.find((a) => a.id === 'truck')!));
    let slices = 0;
    let next = steps.next();
    while (!next.done) { slices++; next = steps.next(); }
    const yard = next.value;
    const cells = yard.solid.nx * yard.solid.ny;
    // The clearance alone goes over every cell twice, some 40 000 a slice.
    expect(cells).toBeGreaterThan(100_000);
    expect(slices).toBeGreaterThanOrEqual(Math.floor((2 * cells) / 40_000));
    // Sliced, the field is the one worked out at once.
    const whole = clearanceOf(yard.solid);
    expect(yard.field.clear).toEqual(whole.clear);
  });

  it('goes on being made when the roads move far from it, and starts over only when they move on its grid', () => {
    const doc = works();
    const net = new Network(doc);
    net.rebuild();
    const w = new SimWorld(doc, net, 0x0be9);
    w.rebuildTopology();
    const b = [...w.buildings.all()].find((x) => knownYard(w, x) !== null)!;
    const lorries = w.city.lots.lorries as unknown as { yardFor(w: SimWorld, building: number): unknown; making: { steps: unknown } | null };
    expect(lorries.yardFor(w, b.id)).toBeUndefined();
    const steps = lorries.making!.steps;
    // A road laid 2 km off: the roads' key moves, the yard's grid does not.
    doc.addSegment(doc.addNode({ x: m(2000), y: 0 }).id, doc.addNode({ x: m(2100), y: 0 }).id, 1);
    net.rebuild();
    w.rebuildTopology();
    expect(lorries.yardFor(w, b.id)).toBeUndefined();
    expect(lorries.making!.steps).toBe(steps);
    let yard: unknown;
    for (let k = 0; k < 10_000 && yard === undefined; k++) yard = lorries.yardFor(w, b.id);
    expect(yard).toBeTruthy();
    expect(knownYard(w, b)).toBe(yard);
  });

  it('works out the distance map to a goal once for every search to it on the same field', () => {
    const doc = works();
    const net = new Network(doc);
    net.rebuild();
    const w = new SimWorld(doc, net, 0x0be9);
    w.rebuildTopology();
    const b = [...w.buildings.all()].find((x) => knownYard(w, x) !== null)!;
    const body = lorryOf(ARCHETYPES.find((a) => a.id === 'truck')!);
    const steps = buildYard(b, yardKey(w), w, body);
    let next = steps.next();
    while (!next.done) next = steps.next();
    const yard = next.value;
    const dock = yard.docks.find((d) => d.pre !== d.docked) ?? yard.docks[0]!;
    const maps = new Map<string, Holonomic>();
    const searches = yard.gates.map((g) => new WaySearch(yard.field, body, g.stop, dock.pre, { arriveReversing: true, maps }));
    const fresh = yard.gates.map((g) => new WaySearch(yard.field, body, g.stop, dock.pre, { arriveReversing: true }));
    expect(maps.size).toBeLessThanOrEqual(1);
    // The same searches, with the map shared or each its own.
    for (let k = 0; k < searches.length; k++) {
      searches[k]!.run(1e6); fresh[k]!.run(1e6);
      expect(searches[k]!.state).toBe(fresh[k]!.state);
      expect(searches[k]!.way).toEqual(fresh[k]!.way);
    }
  });

  it("tests a body against the grid the same with the clearance field's shortcut as cell by cell", () => {
    const doc = works();
    const net = new Network(doc);
    net.rebuild();
    const w = new SimWorld(doc, net, 0x0be9);
    w.rebuildTopology();
    const b = [...w.buildings.all()].find((x) => knownYard(w, x) !== null)!;
    const body = lorryOf(ARCHETYPES.find((a) => a.id === 'truck')!);
    const steps = buildYard(b, yardKey(w), w, body);
    let next = steps.next();
    while (!next.done) next = steps.next();
    const { field, solid } = next.value;
    const rng = new Rng(0xd3);
    let clear = 0;
    for (let k = 0; k < 3000; k++) {
      const x = solid.x0 + rng.float() * solid.nx * solid.cell, y = solid.y0 + rng.float() * solid.ny * solid.cell, a = rng.float() * Math.PI * 2;
      const exact = bodyClearExact(solid, body, x, y, a, m(0.02));
      expect(bodyClearExact(field, body, x, y, a, m(0.02)), `pose ${k}`).toBe(exact);
      if (exact) clear++;
    }
    expect(clear).toBeGreaterThan(30);
  });
});

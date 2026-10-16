import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { growOnLot } from '@editor/zoning';
import { SimWorld } from '@sim/world';
import { ARCHETYPES } from '@sim/vehicles/archetypes';
import { clearanceOf } from '@sim/agents/hybridAStar';
import { buildYard, knownYard, lorryOf, yardKey, yardNeighbours } from '@sim/agents/lorryDocks';

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
    const steps = buildYard(b!, yardKey(w), w, lorryOf(ARCHETYPES.find((a) => a.id === 'truck')!), yardNeighbours(w, null));
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
});

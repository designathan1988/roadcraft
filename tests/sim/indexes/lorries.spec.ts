import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { Rng } from '@core/rng';
import { applyLots, planLots, zoneLots } from '@world/lots';
import type { Building, BuildingId } from '@world/buildings/types';
import { lorryDocks } from '@world/buildings/docks';
import type { LaneletId } from '@world/lanelets';
import { growOnLot } from '@world/growth/zoning';
import { SimWorld } from '@sim/world';
import { ARCHETYPES } from '@sim/vehicles/archetypes';
import type { Waypoint } from '@sim/agents/hybridAStar';
import { gatedProperty } from '@sim/agents/parking';
import { buildYard, knownYard, lorryOf, type Yard, yardKey, yardOf } from '@sim/agents/lorryDocks';
import { closures, YardList } from '@sim/agents/lorryTraffic';
import { trafficBuilding } from '@sim/agents/trafficBuildings';
import { buildYard as oldBuildYard, yardNeighbours as oldYardNeighbours, type Yard as OldYard } from './oracle/lorryDocksOld';

/** THE LORRIES READ WHAT IS NEAR, AND FIND WHAT THE OLD LOOPS FOUND. - The yards a lorry may be sent to */

/** The old `readYards`: every building of the town, in the store's order. */
function oldYards(doc: RoadDoc): { building: BuildingId; docks: number }[] {
  const out: { building: BuildingId; docks: number }[] = [];
  for (const b of doc.buildings.all()) {
    const docks = gatedProperty(b) ? lorryDocks(b).length : 0;
    if (docks) out.push({ building: b.id, docks });
  }
  return out;
}

/** The old `closures`: every lane of the map against the poses' box. */
function oldClosures(w: SimWorld, poses: readonly Waypoint[], owner: number, rear: number, length: number, width: number) {
  if (!poses.length) return [];
  const LANE_HALF = m(2), CLOSURE_MARGIN = m(1.5);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poses) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const pad = length + LANE_HALF;
  const spans = new Map<LaneletId, { from: number; to: number }>();
  // In lane id order: the order the lanes' grid hands them out in, whatever order the edits built them in.
  for (const lane of [...w.graph.lanelets.values()].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0))) {
    const box = lane.centre.bbox;
    if (box.maxX < x0 - pad || box.minX > x1 + pad || box.maxY < y0 - pad || box.minY > y1 + pad) continue;
    for (let i = 0; i < poses.length; i += 2) {
      const p = poses[i]!;
      const c = Math.cos(p.angle), s = Math.sin(p.angle);
      const back = length / 2 - rear, front = length / 2 + rear, hw = width / 2;
      for (const [u, v] of [[-back, -hw], [-back, hw], [front, -hw], [front, hw], [(front - back) / 2, -hw], [(front - back) / 2, hw]] as const) {
        const q = { x: p.x + c * u - s * v, y: p.y + s * u + c * v };
        const hit = lane.centre.closestPoint(q);
        if (hit.distance > LANE_HALF) continue;
        const span = spans.get(lane.id);
        if (span) { span.from = Math.min(span.from, hit.s); span.to = Math.max(span.to, hit.s); }
        else spans.set(lane.id, { from: hit.s, to: hit.s });
      }
    }
  }
  return [...spans].map(([lanelet, span]) => ({ lanelet, from: Math.max(0, span.from - CLOSURE_MARGIN), to: span.to + CLOSURE_MARGIN, owner }));
}

function works(seed: number): { doc: RoadDoc; net: Network; w: SimWorld; refused: Set<number> } {
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
  doc.lots.forEach((l, i) => zoneLots(doc, [l.id], i % 3 === 0 ? { use: 'commercial', density: 'low' } : { use: 'industrial', density: 'medium' }));
  const refused = new Set<number>();
  for (let k = 0; k < doc.lots.length; k++) growOnLot({ doc, net, groundAt: () => 0 }, refused, seed + k);
  const w = new SimWorld(doc, net, seed);
  w.rebuildTopology();
  return { doc, net, w, refused };
}

/** A yard made to the end. */
function made<T>(steps: Generator<void, T, void>): T {
  for (;;) { const next = steps.next(); if (next.done) return next.value; }
}

const LORRY = lorryOf(ARCHETYPES.find((a) => a.id === 'truck')!);

/** What a yard is: its grid, its clearance, its gates and docks. */
function yardText(y: Yard | OldYard): string {
  return JSON.stringify({
    ring: y.ring, gates: y.gates, docks: y.docks.map((d) => ({ dock: d.dock, docked: d.docked, pre: d.pre, order: d.order })),
    solid: Array.from(y.solid.blocked).join(''), clear: Array.from(y.field.clear).join(','),
  });
}

describe('the lorries read what is near', () => {
  it('the yards, kept from the diary, are the old loop\'s, in its order, through edits', () => {
    const { doc, net, w, refused } = works(0x10221);
    const list = new YardList();
    const rng = new Rng(77);
    const gone: { id: BuildingId; record: Building }[] = [];
    let most = 0;
    for (let k = 0; k < 30; k++) {
      const all = [...doc.buildings.all()];
      const roll = rng.float();
      if (roll < 0.3) growOnLot({ doc, net, groundAt: () => 0 }, refused, k * 13);
      else if (roll < 0.5 && all.length) {
        const b = all[rng.int(0, all.length - 1)]!;
        doc.buildings.put({ ...b, decay: (b.decay ?? 0) + 0.05 });
      } else if (roll < 0.65 && all.length) {
        // A gate or a dock taken out: the yard goes, or keeps fewer docks.
        const b = all[rng.int(0, all.length - 1)]!;
        const at = (b.elements ?? []).findIndex((el) => el.kind === 'gate' || /dock/.test(el.kind));
        if (at >= 0) doc.buildings.put({ ...b, elements: b.elements!.filter((_, i) => i !== at) });
      } else if (roll < 0.8 && all.length) {
        const b = all[rng.int(0, all.length - 1)]!;
        doc.buildings.remove(b.id);
        gone.push({ id: b.id, record: b });
      } else if (gone.length) {
        const { id, record } = gone.splice(rng.int(0, gone.length - 1), 1)[0]!;
        doc.buildings.restore(id, record);
      }
      const now = list.read(w);
      expect(now).toEqual(oldYards(doc));
      most = Math.max(most, now.length);
    }
    expect(most).toBeGreaterThan(2);
  });

  it('the lanes a lorry sweeps, from the lanes\' grid, are the old loop\'s, through road edits', () => {
    const { doc, net, w } = works(0x5eed);
    const rng = new Rng(99);
    let found = 0;
    for (let edit = 0; edit < 4; edit++) {
      for (let k = 0; k < 40; k++) {
        // A run of poses along a random lane, and across it.
        const lanes = [...w.graph.lanelets.values()];
        const lane = lanes[rng.int(0, lanes.length - 1)]!;
        const poses: Waypoint[] = [];
        const n = rng.int(1, 9);
        for (let i = 0; i < n; i++) {
          const f = lane.centre.sampleAt(rng.range(0, lane.length));
          poses.push({ x: f.p.x + rng.range(-m(4), m(4)), y: f.p.y + rng.range(-m(4), m(4)), angle: rng.range(-Math.PI, Math.PI), reverse: false });
        }
        const a = closures(w, poses, 7, m(2), m(9.8), m(2.5));
        expect(a).toEqual(oldClosures(w, poses, 7, m(2), m(9.8), m(2.5)));
        found += a.length;
      }
      const y = m(rng.range(-100, 100));
      doc.addSegment(doc.addNode({ x: m(-200), y }).id, doc.addNode({ x: m(200), y }).id, 1);
      net.rebuild();
      w.rebuildTopology();
    }
    expect(found).toBeGreaterThan(100);
  });

  it('a yard made with the buildings near it by place is the yard of the old index', () => {
    const { doc, net, w, refused } = works(0x0be9);
    let yards = 0;
    for (let round = 0; round < 2; round++) {
      // Two yards a round: each is a grid of a third of a million cells and its clearance, twice.
      for (const b of [...doc.buildings.all()].filter((o) => gatedProperty(o) && lorryDocks(o).length).slice(0, 2)) {
        const now = made(buildYard(trafficBuilding(b), yardKey(w), w, LORRY));
        const old = made(oldBuildYard(b, yardKey(w), w, LORRY, oldYardNeighbours(w, null)));
        expect(yardText(now)).toBe(yardText(old));
        yards++;
      }
      // More buildings round the yards: their walls shut cells of the grids.
      for (let k = 0; k < 6; k++) growOnLot({ doc, net, groundAt: () => 0 }, refused, 31 * k + round);
    }
    expect(yards).toBeGreaterThan(1);
  });

  it('a yard reads its lots again for a lot laid on its grid, never for one laid elsewhere', () => {
    const { doc, w } = works(0x0be9);
    const b = [...w.buildings.all()].find((o) => gatedProperty(o) && o.docks.length);
    expect(b).toBeDefined();
    const yard = yardOf(w, b!, LORRY)!;
    expect(knownYard(w, b!)).toBe(yard);
    // The lots a yard's check reads, counted.
    const lotsIn = doc.lotsIn.bind(doc);
    let asked = 0;
    doc.lotsIn = (rect) => { asked++; return lotsIn(rect); };
    const square = (x: number, y: number, side: number) => [{ x, y }, { x: x + side, y }, { x: x + side, y: y + side }, { x, y: y + side }];
    // Far off: the yard stands without a look at its inputs, and has read the diary up to now.
    doc.lotStore.apply({ add: [{ corners: square(m(5000), m(5000), m(20)) }] }, 'test: a lot far off');
    expect(knownYard(w, b!)).toBe(yard);
    expect(asked).toBe(0);
    expect(yard.seen).toBe(doc.changes.version);
    // Asked again with nothing new: no look either.
    expect(knownYard(w, b!)).toBe(yard);
    expect(asked).toBe(0);
    // On its grid: its inputs read again, and they changed.
    const [x0, y0] = yard.reach;
    doc.lotStore.apply({ add: [{ corners: square(x0 + m(1), y0 + m(1), m(3)) }] }, 'test: a lot on the yard');
    expect(knownYard(w, b!)).toBeUndefined();
    expect(asked).toBe(1);
  });
});

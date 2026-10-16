import { beforeAll, describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { solidFootprints, worldToLocal } from '@world/buildings/geometry';
import type { Building } from '@world/buildings/types';
import { growOnLot } from '@world/growth/zoning';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { createAgentWalkEngine, inspectAgentWalkers } from '@sim/agents/walk';
import { doorWay, personGates } from '@sim/agents/lotDoors';
import { trafficBuilding } from '@sim/agents/trafficBuildings';
import { streetDoors } from '@world/buildings/streetDoors';

/** People use the lots' people's gates (the player, 2026-10-09: every lot has one, nobody walked through it) */

const BOUNDARY = new Set(['wall', 'fence', 'hedge', 'railing']);

/** Distance from a local point to a boundary part's box (0 inside it). */
function toBoundary(b: Building, p: { x: number; y: number }): number {
  let best = Infinity;
  for (const el of b.elements ?? []) {
    if (!BOUNDARY.has(el.kind) || el.h < m(0.3)) continue;
    const alongY = el.facing === 0 || el.facing === 2;
    const hx = (alongY ? el.w : el.d) / 2, hy = (alongY ? el.d : el.w) / 2;
    const c = Math.cos(-(el.angle ?? 0)), s = Math.sin(-(el.angle ?? 0));
    const dx = p.x - el.x, dy = p.y - el.y;
    const lx = dx * c - dy * s, ly = dx * s + dy * c;
    const ox = Math.max(0, Math.abs(lx) - hx), oy = Math.max(0, Math.abs(ly) - hy);
    best = Math.min(best, Math.hypot(ox, oy));
  }
  return best;
}

function inside(ring: readonly { x: number; y: number }[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, c = ring[j]!;
    if ((a.y > y) !== (c.y > y) && x < ((c.x - a.x) * (y - a.y)) / (c.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

let doc: RoadDoc;
let net: Network;

beforeAll(() => {
  doc = new RoadDoc();
  const a = doc.addNode({ x: m(-220), y: 0 }).id, b = doc.addNode({ x: m(220), y: 0 }).id;
  doc.addSegment(a, b, 1);
  net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  const zones = [
    { use: 'residential', density: 'low' }, { use: 'residential', density: 'medium' }, { use: 'commercial', density: 'low' },
    { use: 'residential', density: 'low' }, { use: 'commercial', density: 'high' }, { use: 'residential', density: 'high' },
  ] as const;
  doc.lots.forEach((l, i) => zoneLots(doc, [l.id], zones[i % zones.length]!));
  const refused = new Set<number>();
  for (let k = 0; k < doc.lots.length * 3; k++) {
    if (growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
  }
});

describe('the way from a lot door out through its people gate', () => {
  it('is found for the lots with a gate, and keeps clear of walls, fences and the building', () => {
    let gated = 0, found = 0;
    const missing: string[] = [];
    for (const b of doc.buildings.all()) {
      // A gate in front of the building (`lotPlan.ts`: on the path to the door)
      const front = personGates(trafficBuilding(b)).some((g) => b.volumes.some((v) => !v.open && v.base === 0 && g.x > v.x && g.x < v.x + v.w && v.y > g.y + m(1)));
      if (!front) continue;
      gated++;
      const way = doorWay(trafficBuilding(b));
      if (!way) {
        missing.push(`${b.id}:${b.function}`);
        continue;
      }
      found++;
      const local = way.out.map((p) => worldToLocal(b, p));
      const rings = solidFootprints(b).map((r) => r.map((p) => worldToLocal(b, p)));
      let nearest = Infinity;
      for (let i = 1; i < local.length; i++) {
        const p = local[i - 1]!, q = local[i]!;
        const len = Math.hypot(q.x - p.x, q.y - p.y);
        for (let t = 0; t <= len; t += m(0.05)) {
          const s = { x: p.x + ((q.x - p.x) * t) / len, y: p.y + ((q.y - p.y) * t) / len };
          nearest = Math.min(nearest, toBoundary(b, s));
          expect(rings.some((r) => inside(r, s.x, s.y)), `building ${b.id}: the way runs into the building`).toBe(false);
        }
      }
      // The body's radius is 0.27 m: its centre never comes nearer a wall or fence.
      expect(nearest, `building ${b.id} (${b.function}): the way passes ${nearest.toFixed(2)} from a boundary`).toBeGreaterThanOrEqual(m(0.27));
      // From the door (in front of the building) to outside the lot's front.
      expect(local[local.length - 1]!.y).toBeLessThan(0);
    }
    expect(gated).toBeGreaterThan(10);
    // Not all: a part standing in the gate itself (a bollard in a tower's forecourt gate, measured) shuts it.
    expect(found / gated, `${found} of ${gated} lots with a people's gate in front have a way to the door: ${missing.join(' ')}`).toBeGreaterThan(0.9);
  });
});

describe('a shop on the footway', () => {
  it('is walked into by its street door: the way is the step out of it onto the footway', () => {
    let shops = 0;
    for (const b of doc.buildings.all()) {
      if (personGates(trafficBuilding(b)).length || !streetDoors(b).length) continue;
      shops++;
      const way = doorWay(trafficBuilding(b));
      expect(way, `building ${b.id} (${b.function}): a way from its street door`).not.toBeNull();
      const local = way!.out.map((p) => worldToLocal(b, p));
      const rings = solidFootprints(b).map((r) => r.map((p) => worldToLocal(b, p)));
      // Both ends outside the building, the second further out into the street.
      for (const q of local) expect(rings.some((r) => inside(r, q.x, q.y)), `building ${b.id}: the way starts inside the building`).toBe(false);
      expect(local[local.length - 1]!.y).toBeLessThan(local[0]!.y);
      expect(way!.frontage).toBeGreaterThanOrEqual(m(6));
    }
    expect(shops).toBeGreaterThan(0);
  });
});

describe('the scenery uses the gates', () => {
  it('walkers come out of doors and go in at them, and never walk through a boundary', () => {
    const sim = new SimWorld(doc, net, 0x6a7e);
    sim.rebuildTopology();
    sim.pedestrianCount = 30;
    sim.clock.paused = false;
    sim.usePedestrianEngine(createAgentWalkEngine());
    sim.ambient.enabled = true;
    sim.ambient.source = 'edges';
    const buildings = [...doc.buildings.all()];
    let lotSeconds = 0, worst = Infinity;
    const outOfDoor = new Set<number>(), inAtDoor = new Set<number>();
    // Standing still on a lot's path: two meeting in single file pass each other (SUMO's narrow jam, 1 s).
    const standing = new Map<number, number>();
    let longestStand = 0;
    // Spinning on the spot: the heading round more than a whole turn in 2 s while the body stays within half a metre
    const windows = new Map<number, { x: number; y: number; heading: number; t: number }>();
    const spinning = new Set<number>();
    let spinDetail = '';
    const ticks = Math.round(150 / DT);
    for (let i = 0; i < ticks; i++) {
      step(sim, { traffic: false, pedestrians: true });
      if (i % 5) continue;
      for (const p of inspectAgentWalkers(sim)) {
        if (p.inside) continue;
        const w = windows.get(p.id);
        if (!w || i - w.t >= Math.round(2 / DT)) windows.set(p.id, { x: p.x, y: p.y, heading: p.heading, t: i });
        else if (Math.abs(p.heading - w.heading) > 2 * Math.PI && Math.hypot(p.x - w.x, p.y - w.y) < m(0.5) && !spinning.has(p.id)) {
          spinning.add(p.id);
          spinDetail ||= `walker ${p.id} on a ${p.kind} step at ${p.x.toFixed(1)},${p.y.toFixed(1)}: ${(p.heading - w.heading).toFixed(1)} rad in ${((i - w.t) * DT).toFixed(1)} s`;
        }
        if (p.fromLot) outOfDoor.add(p.id);
        if (p.toLot) inAtDoor.add(p.id);
        if (p.kind !== 'lot') { standing.delete(p.id); continue; }
        lotSeconds += DT * 5;
        const still = p.v < m(0.1) ? (standing.get(p.id) ?? 0) + DT * 5 : 0;
        standing.set(p.id, still);
        longestStand = Math.max(longestStand, still);
        for (const b of buildings) {
          if (Math.hypot(b.x - p.x, b.y - p.y) > m(60)) continue;
          worst = Math.min(worst, toBoundary(b, worldToLocal(b, { x: p.x, y: p.y })));
        }
      }
    }
    const g = sim.ambient.gateWalks;
    expect(g.made).toBeGreaterThan(10);
    expect(g.fromGate + g.toGate, `${g.fromGate} out of doors, ${g.toGate} in at doors of ${g.made}`).toBeGreaterThan(g.made * 0.2);
    expect(outOfDoor.size).toBeGreaterThan(0);
    expect(inAtDoor.size).toBeGreaterThan(0);
    expect(lotSeconds).toBeGreaterThan(10);
    expect(longestStand, `longest standing on a lot's path: ${longestStand.toFixed(1)} s`).toBeLessThan(4);
    expect(spinning.size, spinDetail).toBe(0);
    // A body's centre stays a body's radius from any wall or fence (the pursuit cuts a corner a little).
    expect(worst, `nearest a boundary: ${worst.toFixed(2)}`).toBeGreaterThan(m(0.2));
  });
});

import { beforeAll, describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { lotEntrances } from '@world/parkingLayout';
import { localToWorld, worldToLocal } from '@world/buildings/geometry';
import type { Building } from '@world/buildings/types';
import { growOnLot } from '@editor/zoning';
import { SimWorld } from '@sim/world';
import { type Bay, carGates, collectBays, gateExits, gatedProperty, wallsOf } from '@sim/agents/parking';
import { arrival, departure } from '@sim/agents/manoeuvre';

/**
 * A lot with a car park behind its building is entered and left by its car
 * gate (the player, 2026-10-09: "the car gate that leads to the parking at
 * the back must be FUNCTIONAL"): every stall is reached from the lane in front
 * of the gate, the way in and out passes through the gate and through no
 * wall or fence, and no kerb bay is painted across the gate.
 */

/** Whether a local point lies in a boundary part (wall, fence, hedge, railing) of the building, grown by `pad`. */
function inBoundary(b: Building, p: { x: number; y: number }, pad: number): boolean {
  for (const el of b.elements ?? []) {
    if (el.kind !== 'wall' && el.kind !== 'fence' && el.kind !== 'hedge' && el.kind !== 'railing') continue;
    if (el.h < m(0.8)) continue;
    const alongY = el.facing === 0 || el.facing === 2;
    const hx = (alongY ? el.w : el.d) / 2 + pad, hy = (alongY ? el.d : el.w) / 2 + pad;
    const c = Math.cos(-(el.angle ?? 0)), s = Math.sin(-(el.angle ?? 0));
    const dx = p.x - el.x, dy = p.y - el.y;
    const lx = dx * c - dy * s, ly = dx * s + dy * c;
    if (Math.abs(lx) <= hx && Math.abs(ly) <= hy) return true;
  }
  return false;
}

describe('every grown lot closed by its boundary', () => {
  it('walls, fences or the building close the whole edge of every lot, with a gate to come in by', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: m(-220), y: 0 }).id, b = doc.addNode({ x: m(220), y: 0 }).id;
    doc.addSegment(a, b, 1);
    const net = new Network(doc);
    net.rebuild();
    applyLots(doc, planLots(doc, net));
    const zones = [
      { use: 'residential', density: 'low' }, { use: 'residential', density: 'medium' }, { use: 'residential', density: 'high' },
      { use: 'commercial', density: 'low' }, { use: 'commercial', density: 'high' }, { use: 'industrial', density: 'medium' },
    ] as const;
    doc.lots.forEach((l, i) => zoneLots(doc, [l.id], zones[i % zones.length]!));
    const refused = new Set<number>();
    for (let k = 0; k < doc.lots.length * 3; k++) {
      if (growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
    }
    let lots = 0;
    for (const lot of doc.lots) {
      const bld = lot.building === undefined ? undefined : doc.buildings.get(lot.building as Building['id']);
      if (!bld) continue;
      lots++;
      const ring = lot.corners.map((c) => worldToLocal(bld, c));
      const solid = bld.volumes.filter((v) => !v.open && v.base === 0);
      let open = 0, total = 0;
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i]!, q = ring[(i + 1) % ring.length]!;
        const len = Math.hypot(q.x - p.x, q.y - p.y);
        for (let t = m(0.5); t < len - m(0.5); t += m(0.5)) {
          const s = { x: p.x + ((q.x - p.x) * t) / len, y: p.y + ((q.y - p.y) * t) / len };
          // A hair inside the lot.
          const c = { x: s.x + ((ring[2]!.x + ring[0]!.x) / 2 - s.x) * 0.01, y: s.y + ((ring[2]!.y + ring[0]!.y) / 2 - s.y) * 0.01 };
          total++;
          const byWall = (bld.elements ?? []).some((e) => (BOUNDARY.has(e.kind)) && inBox(e, c, m(0.45)));
          const byBuilding = solid.some((v) => c.x >= v.x - m(0.6) && c.x <= v.x + v.w + m(0.6) && c.y >= v.y - m(0.6) && c.y <= v.y + v.d + m(0.6));
          if (!byWall && !byBuilding) open++;
        }
      }
      expect(open / total, `lot ${lot.id} (${bld.function}) open ${open}/${total}`).toBeLessThan(0.02);
    }
    expect(lots).toBeGreaterThan(10);
  }, 120_000);
});

const BOUNDARY = new Set(['wall', 'fence', 'hedge', 'railing', 'gate']);
function inBox(el: { x: number; y: number; w: number; d: number; facing: number; angle?: number }, p: { x: number; y: number }, pad: number): boolean {
  const alongY = el.facing === 0 || el.facing === 2;
  const hx = (alongY ? el.w : el.d) / 2 + pad, hy = (alongY ? el.d : el.w) / 2 + pad;
  const c = Math.cos(-(el.angle ?? 0)), s = Math.sin(-(el.angle ?? 0));
  const dx = p.x - el.x, dy = p.y - el.y;
  return Math.abs(dx * c - dy * s) <= hx && Math.abs(dx * s + dy * c) <= hy;
}

describe('a lot car park reached through its car gate', () => {
  let doc: RoadDoc;
  let w: SimWorld;
  let parks: Building[] = [];
  let bays: Bay[] = [];

  beforeAll(() => {
    // A long street with open land on both sides, flats zoned along it (their lots have car parks).
    doc = new RoadDoc();
    const a = doc.addNode({ x: m(-160), y: 0 }).id, b = doc.addNode({ x: m(160), y: 0 }).id;
    doc.addSegment(a, b, 1);
    const net = new Network(doc);
    net.rebuild();
    applyLots(doc, planLots(doc, net));
    zoneLots(doc, doc.lots.map((l) => l.id), { use: 'residential', density: 'medium' });
    const refused = new Set<number>();
    for (let k = 0; k < doc.lots.length * 3; k++) {
      if (growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
    }
    w = new SimWorld(doc, net, 7);
    w.rebuildTopology();
    parks = [...doc.buildings.all()].filter((b) => (b.elements ?? []).some((e) => e.kind === 'parking'));
    bays = collectBays(w).filter((bay) => !bay.kerb && parks.some((b) => b.id === bay.building));
  }, 120_000);

  it('grows lots with car parks and car gates, each gate with its way out to the lane', () => {
    expect(parks.length).toBeGreaterThan(2);
    for (const b of parks) expect(carGates(b).length).toBeGreaterThan(0);
    // Every one but a lot at the very end of the street, whose gate is short of the lane's end.
    const out = parks.filter((b) => gateExits(w, b, gatedProperty(b)!, wallsOf(w)).length > 0).length;
    expect(out / parks.length).toBeGreaterThan(0.85);
  });

  it('reaches most stalls from the lane in front of the gate', () => {
    expect(bays.length).toBeGreaterThan(0);
    const reached = bays.filter((bay) => bay.lane?.entryAt !== undefined && bay.via.length > 0);
    // A lot with a way out through its gate reaches every one of its stalls:
    // nothing stands in its drive or across the turn into the aisle (a
    // cabinet left at the drive's mouth cut off all eight stalls of a lot).
    for (const b of parks) {
      if (!gateExits(w, b, gatedProperty(b)!, wallsOf(w)).length) continue;
      const mine = bays.filter((bay) => bay.building === b.id);
      expect(mine.filter((bay) => reached.includes(bay)).length, `lot ${b.id}`).toBe(mine.length);
    }
    expect(reached.length / bays.length).toBeGreaterThan(0.8);
    for (const bay of reached) {
      const b = doc.buildings.get(bay.building)!;
      // The way out ends just outside a car gate.
      const last = worldToLocal(b, bay.via[bay.via.length - 1]!);
      expect(carGates(b).some((g) => Math.hypot(last.x - g.x, last.y - g.y) < m(2))).toBe(true);
      // The stop before the gate and the join past it, on the same lane.
      expect(bay.lane!.entryAt!).toBeLessThan(bay.lane!.at);
    }
  });

  it('drives in and out without crossing a wall or a fence', () => {
    const reached = bays.filter((bay) => bay.lane?.entryAt !== undefined && bay.via.length > 0);
    for (const bay of reached.slice(0, 40)) {
      const b = doc.buildings.get(bay.building)!;
      const lane = w.lanelet(bay.lane!.lanelet)!;
      const stop = lane.centre.sampleAt(bay.lane!.entryAt!);
      const out = departure(bay, bay.lane!);
      const into = arrival({ x: stop.p.x, y: stop.p.y, angle: Math.atan2(stop.t.y, stop.t.x) }, bay);
      for (const path of [out, into]) {
        // The car's centre line keeps half a metre off every wall and fence.
        const hit = path.samples.find((q) => inBoundary(b, worldToLocal(b, q), m(0.5)));
        expect(hit, `building ${b.id}`).toBeUndefined();
      }
    }
  }, 60_000);

  it('paints no kerb bay across a car gate', () => {
    const entrances = lotEntrances(doc);
    for (const b of parks) {
      for (const g of carGates(b)) {
        const c = localToWorld(b, g.x, g.y);
        expect(entrances.some(([p, q]) => Math.hypot((p.x + q.x) / 2 - c.x, (p.y + q.y) / 2 - c.y) < m(0.5))).toBe(true);
      }
    }
  });
});

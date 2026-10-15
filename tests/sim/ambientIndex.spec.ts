import { beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { solidFootprints } from '@world/buildings/geometry';
import type { Building } from '@world/buildings/types';
import { growOnLot } from '@editor/zoning';
import { BuildingMix, SightWalls, ambientIndexWork, crosses, StreetLength, atRoll } from '@sim/ambient/ambientIndex';
import { kindOf, type Mix } from '@sim/ambient/demand';

/** The scenery's indexes (`sim/ambient/ambientIndex.ts`) answer as the walks over the whole map they replace */

const ZONES = [
  { use: 'residential', density: 'medium' }, { use: 'commercial', density: 'low' },
  { use: 'residential', density: 'low' }, { use: 'industrial', density: 'medium' },
  { use: 'commercial', density: 'high' }, { use: 'residential', density: 'high' },
] as const;

/** A grid of `n` x `n` blocks of `block` m, its lots grown. */
function town(n: number, block: number): RoadDoc {
  const doc = new RoadDoc();
  const ids: number[][] = [];
  for (let i = 0; i <= n; i++) {
    ids.push([]);
    for (let j = 0; j <= n; j++) ids[i]!.push(doc.addNode({ x: m(block) * (i - n / 2), y: m(block) * (j - n / 2) }).id);
  }
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      if (i < n) doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, 1);
      if (j < n) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, 1);
    }
  }
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  doc.lots.forEach((l, k) => zoneLots(doc, [l.id], ZONES[k % ZONES.length]!));
  const refused = new Set<number>();
  for (let k = 0; k < doc.lots.length * 3; k++) {
    if (growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
  }
  return doc;
}

/** A random edit of the buildings: one removed, one moved, one aged, or one removed put back. */
function editBuildings(doc: RoadDoc, rng: Rng, removed: Building[]): void {
  const all = [...doc.buildings.all()];
  const roll = rng.float();
  if (roll < 0.25 && all.length) {
    const b = all[Math.floor(rng.float() * all.length)]!;
    removed.push(b);
    doc.buildings.remove(b.id);
  } else if (roll < 0.5 && all.length) {
    const b = all[Math.floor(rng.float() * all.length)]!;
    doc.buildings.put({ ...b, x: b.x + m(rng.range(-20, 20)), y: b.y + m(rng.range(-20, 20)) });
  } else if (roll < 0.75 && all.length) {
    const b = all[Math.floor(rng.float() * all.length)]!;
    doc.buildings.put({ ...b, decay: rng.float() });
  } else if (removed.length) {
    const b = removed.pop()!;
    doc.buildings.restore(b.id, b);
  }
}

let doc: RoadDoc;
beforeAll(() => {
  doc = town(2, 120);
});

describe('the walls between the eye and a point', () => {
  /** The old `AmbientWorld.blocked`, over every wall of the map gathered again (the oracle). */
  function oldBlocked(d: RoadDoc, ax: number, ay: number, bx: number, by: number): boolean {
    const walls: { ring: readonly { x: number; y: number }[]; x0: number; y0: number; x1: number; y1: number }[] = [];
    for (const b of d.buildings.all()) {
      for (const ring of solidFootprints(b)) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of ring) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
        walls.push({ ring, x0, y0, x1, y1 });
      }
    }
    const lx = Math.min(ax, bx), ly = Math.min(ay, by), hx = Math.max(ax, bx), hy = Math.max(ay, by);
    for (const wl of walls) {
      if (wl.x1 < lx || wl.x0 > hx || wl.y1 < ly || wl.y0 > hy) continue;
      const r = wl.ring;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        if (crosses(ax, ay, bx, by, r[j]!.x, r[j]!.y, r[i]!.x, r[i]!.y)) return true;
      }
    }
    return false;
  }

  it('answers as the walk over every wall, through edits of the buildings', () => {
    expect(doc.buildings.size).toBeGreaterThan(20);
    const rng = new Rng(0x5167);
    const walls = new SightWalls();
    const removed: Building[] = [];
    const full = ambientIndexWork.full;
    let hits = 0, asked = 0;
    for (let round = 0; round < 40; round++) {
      if (round) for (let k = 0; k < 3; k++) editBuildings(doc, rng, removed);
      walls.sync(doc.buildings, doc.changes);
      for (let q = 0; q < 60; q++) {
        // Lines of sight of every length and slope, some along a cell's edge (32 m).
        const ax = m(rng.range(-160, 160)), ay = m(rng.range(-160, 160));
        const along = rng.float() < 0.15;
        const bx = along ? ax + m(rng.range(-200, 200)) : m(rng.range(-160, 160));
        const by = along ? m(32) * Math.round(ay / m(32)) : m(rng.range(-160, 160));
        const ay2 = along ? by : ay;
        const want = oldBlocked(doc, ax, ay2, bx, by);
        expect(walls.blocked(ax, ay2, bx, by), `${ax},${ay2} -> ${bx},${by}`).toBe(want);
        if (want) hits++;
        asked++;
      }
    }
    // Read whole once; every edit after that taken in by the diary's ids.
    expect(ambientIndexWork.full - full).toBe(1);
    // Both answers were asked about, often.
    expect(hits).toBeGreaterThan(asked * 0.2);
    expect(hits).toBeLessThan(asked * 0.95);
  });
});

describe('the mix of the buildings round a place', () => {
  /** The old `AmbientWorld.mixAround` without its one-slot cache: every building of the map counted (the oracle). */
  function oldMix(d: RoadDoc, x: number, y: number, r: number): Mix {
    const count: Record<keyof Mix, number> = { home: 0, shop: 0, work: 0, civic: 0 };
    let total = 0;
    for (const b of d.buildings.all()) {
      if (Math.hypot(b.x - x, b.y - y) > r * 1.2) continue;
      count[kindOf(b)]++;
      total++;
    }
    return total === 0 ? { home: 0.6, shop: 0.2, work: 0.1, civic: 0.1 }
      : { home: count.home / total, shop: count.shop / total, work: count.work / total, civic: count.civic / total };
  }

  it('counts as the walk over every building, through edits, round any place and over the whole map', () => {
    const rng = new Rng(0x313);
    const mix = new BuildingMix();
    const removed: Building[] = [];
    const full = ambientIndexWork.full;
    for (let round = 0; round < 40; round++) {
      if (round) for (let k = 0; k < 3; k++) editBuildings(doc, rng, removed);
      mix.sync(doc.buildings, doc.changes);
      expect(mix.around(0, 0, Infinity)).toEqual(oldMix(doc, 0, 0, Infinity));
      for (let q = 0; q < 40; q++) {
        const x = m(rng.range(-250, 250)), y = m(rng.range(-250, 250));
        // Radii from inside one cell to past the map.
        const r = m(rng.float() < 0.5 ? rng.range(0, 60) : rng.range(60, 600));
        expect(mix.around(x, y, r), `${x},${y} r ${r}`).toEqual(oldMix(doc, x, y, r));
      }
    }
    expect(ambientIndexWork.full - full).toBe(1);
  });
});

describe('the street length round a place', () => {
  /** The old `AmbientWorld.roadAround` without its one-slot cache: every ribbon of the map walked (the oracle). */
  function oldRoad(net: Network, x: number, y: number, r: number): number {
    let total = 0;
    for (const ribbon of net.ribbons.values()) {
      const bb = ribbon.full.bbox;
      if (bb.maxX < x - r || bb.minX > x + r || bb.maxY < y - r || bb.minY > y + r) continue;
      const pts = ribbon.full.toPoints();
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!, b = pts[i]!;
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        if (Math.hypot(mx - x, my - y) <= r) total += Math.hypot(b.x - a.x, b.y - a.y);
      }
    }
    return total;
  }

  it('sums as the walk over every ribbon, through edits of the roads', () => {
    const roads = new RoadDoc();
    const rng = new Rng(0x40ad);
    const nodes: number[] = [];
    for (let k = 0; k < 12; k++) nodes.push(roads.addNode({ x: m(rng.range(-400, 400)), y: m(rng.range(-400, 400)) }).id);
    const segments: number[] = [];
    const join = (): void => {
      const a = nodes[Math.floor(rng.float() * nodes.length)]!, b = nodes[Math.floor(rng.float() * nodes.length)]!;
      if (a === b) return;
      const made = roads.addSegment(a as never, b as never, 1);
      if (made) segments.push(made.id);
    };
    for (let k = 0; k < 14; k++) join();
    const net = new Network(roads);
    net.rebuild();
    const street = new StreetLength();
    const streetLength = (n: Network, x: number, y: number, r: number): number => street.around(n, x, y, r);
    const wholes = new Set<number>();
    for (let round = 0; round < 30; round++) {
      if (round) {
        // A road added, one taken away, or a node moved; the network rebuilt as the game does.
        const roll = rng.float();
        if (roll < 0.35) join();
        else if (roll < 0.6 && segments.length) {
          const id = segments.splice(Math.floor(rng.float() * segments.length), 1)[0]!;
          if (roads.segment(id as never)) roads.removeSegment(id as never);
        } else {
          const id = nodes[Math.floor(rng.float() * nodes.length)]!;
          if (roads.node(id as never)) roads.moveNode(id as never, { x: m(rng.range(-400, 400)), y: m(rng.range(-400, 400)) });
        }
        net.rebuild();
      }
      expect(net.ribbons.size).toBeGreaterThan(0);
      // The whole map's is kept by the edits (`world/networkLength.ts`), summed exactly in millionths of a unit
      const whole = oldRoad(net, 0, 0, Infinity);
      expect(Math.abs(streetLength(net, 0, 0, Infinity) - whole)).toBeLessThanOrEqual(1e-6 * net.ribbons.size + 1e-9 * whole);
      wholes.add(streetLength(net, 0, 0, Infinity));
      for (let q = 0; q < 40; q++) {
        const x = m(rng.range(-500, 500)), y = m(rng.range(-500, 500));
        const r = m(rng.float() < 0.5 ? rng.range(0, 80) : rng.range(80, 900));
        expect(streetLength(net, x, y, r), `${x},${y} r ${r}`).toBe(oldRoad(net, x, y, r));
      }
    }
    // The roads did change between the questions.
    expect(wholes.size).toBeGreaterThan(10);
  });
});

describe('a lane drawn by its length', () => {
  it('is the lane the walk subtracting lengths picked, for every roll', () => {
    const rng = new Rng(0x1a7e);
    let rolls = 0;
    for (let list = 0; list < 200; list++) {
      // Lane lengths as the map's: 12 m to 400 m, some lists of one lane.
      const lengths = Array.from({ length: 1 + Math.floor(rng.float() * 300) }, () => m(rng.range(12, 400)));
      let total = 0;
      for (const l of lengths) total += l;
      const at = new Float64Array(lengths.length);
      let sum = 0;
      lengths.forEach((l, k) => { sum += l; at[k] = sum; });
      expect(at[at.length - 1]).toBe(total);
      for (let q = 0; q < 500; q++) {
        const roll = rng.float() * total;
        // The old `openCars` walk (the oracle).
        let left = roll, want = lengths.length - 1;
        for (let k = 0; k < lengths.length; k++) { left -= lengths[k]!; if (left < 0) { want = k; break; } }
        expect(atRoll(at, roll)).toBe(want);
        rolls++;
      }
      // The ends: nothing, and the whole length.
      expect(atRoll(at, 0)).toBe(0);
      expect(atRoll(at, total)).toBe(lengths.length - 1);
    }
    expect(rolls).toBe(100_000);
  });
});

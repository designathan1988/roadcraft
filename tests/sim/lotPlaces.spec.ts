import { beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import type { Building } from '@world/buildings/types';
import { growOnLot } from '@world/growth/zoning';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { createAgentWalkEngine, joinsFootway } from '@sim/agents/walk';
import { type DoorWay, doorWay, personGates } from '@sim/agents/lotDoors';
import { busy, kindOf, outShare, PEOPLE, type Mix } from '@sim/ambient/demand';
import { ambientIndexWork } from '@sim/ambient/ambientIndex';
import { LotPlaces, PLACE_KINDS } from '@sim/ambient/lotPlaces';
import type { TrafficBuilding } from '@sim/agents/trafficBuildings';

/** The lots people walk into (`sim/ambient/lotPlaces.ts`), drawn in O(log n) and worked out only when drawn */

const ZONES = [
  { use: 'residential', density: 'medium' }, { use: 'commercial', density: 'low' },
  { use: 'residential', density: 'low' }, { use: 'industrial', density: 'medium' },
  { use: 'commercial', density: 'high' }, { use: 'residential', density: 'high' },
] as const;

/** A grid of `n` x `n` blocks of `block` m, every node joined to two roads or more, its lots grown. */
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

function worldOf(doc: RoadDoc, seed = 0x0be9): SimWorld {
  const net = new Network(doc);
  net.rebuild();
  const w = new SimWorld(doc, net, seed);
  w.rebuildTopology();
  w.usePedestrianEngine(createAgentWalkEngine());
  return w;
}

const WALK_DECAY = m(470);
const newPlaces = (): LotPlaces<DoorWay> => new LotPlaces<DoorWay>({ wayOf: doorWay, gatesOf: personGates });

/** The old `AmbientWorld.refreshPlaces` with every way worked out (no time budget): the oracle's places. */
function oldPlaces(w: SimWorld): { b: TrafficBuilding; kind: keyof Mix; way: DoorWay | null }[] {
  const out: { b: TrafficBuilding; kind: keyof Mix; way: DoorWay | null }[] = [];
  for (const b of w.buildings.all()) {
    const way = doorWay(b);
    const footless = !!way?.street && !joinsFootway(w, way.out[way.out.length - 1]!);
    out.push({ b, kind: kindOf(b), way: footless ? null : way });
  }
  return out;
}

/** The old `AmbientWorld.pickPlace` weight of a place (the oracle). */
function oldWeight(p: { kind: keyof Mix; way: DoorWay | null }, hour: number, out: boolean, not: DoorWay | null): number {
  if (!p.way || p.way === not) return 0;
  let near = 1;
  if (not) {
    const a = p.way.out[p.way.out.length - 1]!, b = not.out[not.out.length - 1]!;
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d < m(40)) return 0;
    near = Math.exp(-d / WALK_DECAY);
  }
  const share = outShare(p.kind, hour);
  return PEOPLE[p.kind] * busy(p.kind, hour) * p.way.frontage * (out ? share : 1 - share) * near;
}

const coefOf = (hour: number, out: boolean): number[] => PLACE_KINDS.map((kind) => {
  const share = outShare(kind, hour);
  return PEOPLE[kind] * busy(kind, hour) * (out ? share : 1 - share);
});

/** Pearson's chi-square of `draws` (by building id) against the oracle's weights */
function chiSquare(counts: Map<number, number>, weights: Map<number, number>, draws: number): { chi: number; df: number; stray: number } {
  let total = 0;
  for (const v of weights.values()) total += v;
  let chi = 0, df = -1, poolE = 0, poolO = 0, stray = 0;
  for (const [id, n] of counts) if (!(weights.get(id)! > 0)) stray += n;
  for (const [id, wt] of weights) {
    if (!(wt > 0)) continue;
    const e = (draws * wt) / total, o = counts.get(id) ?? 0;
    if (e < 5) { poolE += e; poolO += o; continue; }
    chi += ((o - e) ** 2) / e;
    df++;
  }
  if (poolE > 0) { chi += ((poolO - poolE) ** 2) / poolE; df++; }
  return { chi, df, stray };
}

/** The chi-square a fit exceeds with a chance of one in a million */
const chiCritical = (df: number): number => df * (1 - 2 / (9 * df) + 4.75 * Math.sqrt(2 / (9 * df))) ** 3;

let doc: RoadDoc;
let w: SimWorld;
beforeAll(() => {
  doc = town(3, 120);
  w = worldOf(doc);
});

describe('the lots people walk into', () => {
  it('have the ways the oracle works out, through edits of the buildings and of the roads', () => {
    expect(doc.buildings.size).toBeGreaterThan(40);
    const rng = new Rng(0x9a7e);
    const places = newPlaces();
    const joins = (p: { x: number; y: number }): boolean => joinsFootway(w, p);
    const broken = ambientIndexWork.boundBroken;
    const removed: Building[] = [];
    let streetDoors = 0, nulls = 0, flips = 0;
    /** Whether each street door's foot was on a footway, by record: one that changes with the roads is a flip. */
    const footOn = new Map<TrafficBuilding, boolean>();
    for (let round = 0; round < 12; round++) {
      if (round) {
        // Buildings removed, moved, aged, put back; a road node moved (footways move with it).
        for (let k = 0; k < 3; k++) {
          const all = [...doc.buildings.all()];
          const roll = rng.float();
          const b = all[Math.floor(rng.float() * all.length)]!;
          if (roll < 0.3) { removed.push(b); doc.buildings.remove(b.id); }
          else if (roll < 0.55) doc.buildings.put({ ...b, x: b.x + m(rng.range(-6, 6)) });
          else if (roll < 0.8) doc.buildings.put({ ...b, decay: rng.float() });
          else if (removed.length) { const back = removed.pop()!; doc.buildings.restore(back.id, back); }
        }
        if (round % 3 === 0) {
          const nodes = [...doc.nodes.values()];
          const node = nodes[Math.floor(rng.float() * nodes.length)]!;
          doc.moveNode(node.id, { x: node.x + m(rng.range(-8, 8)), y: node.y + m(rng.range(-8, 8)) });
        }
        if (round % 4 === 2) {
          // A street taken away: the shops on its footway are left with no footway at their door.
          const segments = [...doc.segments.keys()];
          doc.removeSegment(segments[Math.floor(rng.float() * segments.length)]!);
        }
        w.net.rebuild();
        w.rebuildTopology();
      }
      places.sync(w.buildings, doc.changes);
      // Ways asked about before every one is known, a few only, as the draws do.
      for (const p of oldPlaces(w).slice(0, round)) places.wayOf(p.b.id, joins);
      const oracle = oldPlaces(w);
      const frontage = [0, 0, 0, 0];
      for (const p of oracle) {
        expect(places.wayOf(p.b.id, joins), `building ${p.b.id}`).toBe(p.way);
        if (p.way) frontage[PLACE_KINDS.indexOf(p.kind)]! += p.way.frontage;
        if (p.way?.street) streetDoors++;
        if (!p.way) nulls++;
        if (doorWay(p.b)?.street) {
          const on = p.way !== null;
          if (footOn.has(p.b) && footOn.get(p.b) !== on) flips++;
          footOn.set(p.b, on);
        }
      }
      // Every place known: the frontage the people are counted from is the oracle's.
      places.frontages().forEach((f, k) => expect(f).toBeCloseTo(frontage[k]!, 4));
      expect(places.ready()).toBe(oracle.some((p) => p.way));
    }
    // Street doors and lots nobody walks into were among them; no bound was broken.
    expect(streetDoors).toBeGreaterThan(0);
    expect(nulls).toBeGreaterThan(0);
    // A road edit did take a footway from under a street door (or give one), and the index followed.
    expect(flips).toBeGreaterThan(0);
    expect(ambientIndexWork.boundBroken - broken).toBe(0);
  });

  it('are drawn with the chances of the walk over every lot, from a town not yet worked out', () => {
    const joins = (p: { x: number; y: number }): boolean => joinsFootway(w, p);
    const oracle = oldPlaces(w);
    const broken = ambientIndexWork.boundBroken;
    const verified = ambientIndexWork.verified;
    const rng = new Rng(0xd1ce);
    const DRAWS = 40_000;
    // Lots whose way fronts less than its bound (a gate other than the widest one)
    const cut = (id: number): number => 0.3 + 0.7 * new Rng(id * 7919).float();
    const shrunk = new WeakMap<DoorWay, DoorWay>();
    const narrower = (b: TrafficBuilding): DoorWay | null => {
      const way = doorWay(b);
      if (!way) return null;
      let small = shrunk.get(way);
      if (!small) shrunk.set(way, small = { ...way, frontage: way.frontage * cut(b.id) });
      return small;
    };
    for (const [hour, out, cutting] of [[8.5, true, false], [18, false, false], [12, true, true]] as const) {
      const fresh = (): LotPlaces<DoorWay> => {
        const made = cutting ? new LotPlaces<DoorWay>({ wayOf: narrower, gatesOf: personGates }) : newPlaces();
        made.sync(w.buildings, doc.changes);
        return made;
      };
      let places = fresh();
      const coef = coefOf(hour, out);
      const counts = new Map<number, number>();
      for (let k = 0; k < DRAWS; k++) {
        // A town not yet worked out every 40 draws: many draws are of lots drawn by their bound.
        if (k % 40 === 0) places = fresh();
        const way = places.pick(rng, coef, null, joins, WALK_DECAY, m(40));
        expect(way).not.toBeNull();
        counts.set(way!.building, (counts.get(way!.building) ?? 0) + 1);
      }
      const weights = new Map(oracle.map((p) => [p.b.id as number,
        oldWeight(cutting && p.way ? { kind: p.kind, way: narrower(p.b) } : p, hour, out, null)]));
      const { chi, df, stray } = chiSquare(counts, weights, DRAWS);
      expect(stray, 'drawn with no chance in the oracle').toBe(0);
      // p < 1e-6 under the oracle's distribution; with a fixed seed the test is not flaky.
      expect(chi, `chi-square ${chi.toFixed(1)} on ${df} df`).toBeLessThan(chiCritical(df));
      expect(df).toBeGreaterThan(15);
    }
    expect(ambientIndexWork.boundBroken - broken).toBe(0);
    // Only lots drawn are worked out: a few for each draw at most.
    expect(ambientIndexWork.verified - verified).toBeLessThanOrEqual(3 * DRAWS * 1.5);
  });

  it('are drawn, from the other end of a walk, with the chances of the walk over every lot', () => {
    const joins = (p: { x: number; y: number }): boolean => joinsFootway(w, p);
    const oracle = oldPlaces(w);
    const broken = ambientIndexWork.boundBroken;
    const rng = new Rng(0xfa7);
    const DRAWS = 100_000;
    const froms = oracle.filter((p) => p.way).map((p) => p.way!);
    for (const [hour, out, from] of [[9, false, froms[0]!], [13, true, froms[Math.floor(froms.length / 2)]!]] as const) {
      const places = newPlaces();
      places.sync(w.buildings, doc.changes);
      const coef = coefOf(hour, out);
      const counts = new Map<number, number>();
      let none = 0;
      for (let k = 0; k < DRAWS; k++) {
        const way = places.pick(rng, coef, from, joins, WALK_DECAY, m(40));
        if (!way) { none++; continue; }
        counts.set(way.building, (counts.get(way.building) ?? 0) + 1);
      }
      expect(none).toBe(0);
      const weights = new Map(oracle.map((p) => [p.b.id as number, oldWeight(p, hour, out, from)]));
      const { chi, df, stray } = chiSquare(counts, weights, DRAWS);
      expect(stray, 'drawn with no chance in the oracle (itself, or nearer than 40 m)').toBe(0);
      expect(chi, `chi-square ${chi.toFixed(1)} on ${df} df`).toBeLessThan(chiCritical(df));
      expect(df).toBeGreaterThan(15);
    }
    expect(ambientIndexWork.boundBroken - broken).toBe(0);
  });
});

describe('the scenery with its lots drawn this way', () => {
  /** Where everybody on foot is and how many walks went through a gate: equal for the same seed. */
  function fingerprint(sim: SimWorld): string {
    const people = [...sim.pedViews].map((p) => `${p.id}:${Math.round(p.x * 100)},${Math.round(p.y * 100)}`).sort();
    return `${JSON.stringify(sim.ambient.gateWalks)}|${people.join(';')}`;
  }

  it('runs the same for the same seed', () => {
    const run = (): SimWorld => {
      const sim = worldOf(town(2, 120));
      sim.driveModel = 'v2';
      sim.trafficCount = 20;
      sim.pedestrianCount = 40;
      sim.ambient.enabled = true;
      sim.ambient.source = 'edges';
      for (let i = 0; i < Math.round(20 / DT); i++) step(sim, { traffic: true, pedestrians: true });
      return sim;
    };
    const a = run(), b = run();
    expect(a.ambient.gateWalks.toGate + a.ambient.gateWalks.fromGate).toBeGreaterThan(0);
    expect(fingerprint(a)).toBe(fingerprint(b));
  }, 10_000);
});

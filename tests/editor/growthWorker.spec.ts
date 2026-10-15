import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { PLATE_SIZE } from '@world/bounds';
import { applyLots, planLots } from '@world/lots';
import { latticeHeight } from '@world/groundPatch';
import { planCity, DEFAULT_CITY } from '@world/cityGen/plan';
import { layCity, zoneCity } from '@editor/cityGenerator';
import { LOT_PLAN_VERSION, growOnLot } from '@editor/zoning';
import { type GrowthHost, type GrowthLane, GrowthSession } from '@editor/growthFeed';
import { type GrowAnswer, type GrowAsk, GrowthReplica } from '@editor/growthReplica';
import { validateBuilding } from '@world/buildings/validate';
import type { Building, BuildingId } from '@world/buildings/types';

/**
 * THE GROWTH OFF THE PAGE (`editor/growthFeed.ts`, `growthReplica.ts`): a
 * generated city grown with each building made in a stand-in for the worker
 * - the asks and the answers copied as `postMessage` copies them
 * (`structuredClone`), the replica keeping only what it was sent - is the
 * city the page grows itself (`growOnLot`, as `main.ts` grew it): every
 * record, in the same order, with the same ids, and every lot. And a
 * building made while the document moved is checked again on the page and
 * asked for again, never written over what took its place.
 */

/** The terrain's cell (`render/terrain.ts`: a plate of 320 cells). */
const CELL = PLATE_SIZE / 320;
/** A hilly ground as the terrain draws it: its corners' heights, each cell split along its diagonal. */
const hill = (x: number, y: number): number => 6 * Math.sin(x / 140) + 4 * Math.cos(y / 110);
const ground = (x: number, y: number): number => latticeHeight(x, y, CELL, (i, j) => hill(i * CELL, -j * CELL));
/** Paving here and there, at the ground and a kerb over it. */
const paved = (x: number, y: number): number => (Math.abs(Math.sin(x * 0.37 + y * 0.11)) < 0.4 ? ground(x, y) + 0.15 : NaN);

interface City { doc: RoadDoc; net: Network; zoned: number }
/** The city as `main.ts` `generateCity` lays it, before its buildings. */
function laid(seed: number): City {
  const plan = planCity({ ...DEFAULT_CITY, size: 'small', seed });
  const doc = layCity(plan);
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  return { doc, net, zoned: zoneCity(doc, net, plan) };
}

/** What `main.ts` writes on a building grown (`growthAnswered`). */
const stamp = (doc: RoadDoc, id: number): void => {
  const fresh = doc.buildings.get(id as BuildingId)!;
  doc.buildings.put({ ...fresh, builtAt: 0, decay: 0, lotPlan: LOT_PLAN_VERSION });
};

/** Grown on the page, one building after another (`growOnLot`). */
function grownHere(city: City, host: Omit<GrowthHost, 'doc' | 'net' | 'cell'>): Set<number> {
  const { doc, net } = city;
  const refused = new Set<number>();
  for (let guard = 0; guard < city.zoned * 3 + 50; guard++) {
    const id = growOnLot({ doc, net, groundAt: host.groundAt, ...(host.pavedAt ? { pavedAt: host.pavedAt } : {}) }, refused, 0x5eed);
    if (id !== null) stamp(doc, id);
    else if (doc.openLots.count(refused) === 0) break;
  }
  return refused;
}

/** A worker here: the ask copied in, answered by its own replica, the answer copied out. */
class StandIn implements GrowthLane {
  replica = new GrowthReplica();
  answer: GrowAnswer | null = null;
  asks: GrowAsk[] = [];
  /** Changes an ask before the replica reads it (a test of the misses). */
  meddle: ((ask: GrowAsk) => GrowAsk) | null = null;
  post(ask: GrowAsk): void {
    this.asks.push(ask);
    const sent = structuredClone(ask);
    this.answer = structuredClone(this.replica.handle(this.meddle ? this.meddle(sent) : sent));
  }
}

/** Grown with each building made by the stand-in (`GrowthSession`), as `main.ts` grows a city. */
function grownOff(city: City, host: Omit<GrowthHost, 'doc' | 'net' | 'cell'>, lane = new StandIn(), between?: (k: number, session: GrowthSession) => void): { refused: Set<number>; lane: StandIn; outcomes: string[] } {
  const { doc, net } = city;
  const refused = new Set<number>();
  const session = new GrowthSession(lane, () => ({ doc, net, cell: CELL, ...host }));
  const outcomes: string[] = [];
  for (let guard = 0; guard < city.zoned * 3 + 50; guard++) {
    if (!session.ask(refused, 0x5eed)) break;
    between?.(guard, session);
    const answer = lane.answer!;
    lane.answer = null;
    const out = session.receive(answer);
    outcomes.push(out.kind);
    if (out.kind === 'grown') stamp(doc, out.id);
  }
  return { refused, lane, outcomes };
}

/** Every record and every lot, as text. */
const textOf = (doc: RoadDoc): string[] => [...[...doc.buildings.all()].map((b) => JSON.stringify(b)), ...doc.lots.map((l) => JSON.stringify(l))];

describe('the growth in its worker', () => {
  for (const [seed, host] of [
    [2, { groundAt: ground, pavedAt: paved }],
    [5, { groundAt: () => 0 }],
  ] as const) it(`grows the city of seed ${seed} as the page grows it, record for record`, () => {
    const here = laid(seed), off = laid(seed);
    const refusedHere = grownHere(here, host);
    const { refused, lane, outcomes } = grownOff(off, host);
    expect(off.doc.buildings.size).toBeGreaterThan(here.zoned * 0.8);
    expect(textOf(off.doc)).toEqual(textOf(here.doc));
    expect([...refused].sort()).toEqual([...refusedHere].sort());
    expect(outcomes.filter((o) => o === 'again')).toEqual([]);
    // Each building was sent to the worker once at most (they did not change after), never the town per lot.
    const sent = lane.asks.reduce((n, a) => n + a.sync.buildings.put.length, 0);
    expect(sent).toBeLessThanOrEqual(off.doc.buildings.size);
    expect(lane.asks.filter((a) => a.sync.buildings.reset || a.sync.roads?.reset).length).toBe(1);
    expect(Math.max(...lane.asks.map((a) => a.sync.buildings.put.length))).toBeLessThan(off.doc.buildings.size / 4);
  });

  it('asks again with more round the lot when the worker reads outside what it was sent', () => {
    const here = laid(2), off = laid(2);
    const host = { groundAt: ground, pavedAt: paved };
    grownHere(here, host);
    const lane = new StandIn();
    // Every fifth ask told to the worker as reaching nothing round its lot.
    let k = 0;
    lane.meddle = (ask) => (k++ % 5 === 0 ? { ...ask, reach: { lot: [0, 0, 0, 0], around: [0, 0, 0, 0] } } : ask);
    const { outcomes } = grownOff(off, host, lane);
    expect(outcomes.filter((o) => o === 'again').length).toBeGreaterThan(10);
    expect(textOf(off.doc)).toEqual(textOf(here.doc));
  });

  it('sends all again to a worker started anew', () => {
    const here = laid(2), off = laid(2);
    const host = { groundAt: ground, pavedAt: paved };
    grownHere(here, host);
    const lane = new StandIn();
    grownOff(off, host, lane, (k, session) => {
      if (k % 97 !== 40) return;
      lane.replica = new GrowthReplica();
      session.restart();
    });
    expect(lane.asks.filter((a) => a.sync.buildings.reset).length).toBeGreaterThan(2);
    expect(textOf(off.doc)).toEqual(textOf(here.doc));
  });

  it('checks a building again when the document moved meanwhile, and never writes one that no longer stands', () => {
    const city = laid(2);
    const { doc, net } = city;
    const lane = new StandIn();
    const refused = new Set<number>();
    const host = { groundAt: ground, pavedAt: paved };
    const session = new GrowthSession(lane, () => ({ doc, net, cell: CELL, ...host }));
    let blocked = 0, grown = 0;
    for (let k = 0; k < 60; k++) {
      if (!session.ask(refused, 0x5eed)) break;
      const answer = lane.answer!;
      if (k % 3 === 1 && 'record' in answer && answer.record) {
        // Meanwhile, on the page, a building stands where the answer's would (not on its lot).
        doc.buildings.add({ ...answer.record, elements: [] });
        const out = session.receive(answer);
        expect(out.kind).toBe('again');
        blocked++;
        continue;
      }
      const out = session.receive(answer);
      if (out.kind === 'grown') {
        grown++;
        stamp(doc, out.id);
      }
    }
    expect(blocked).toBeGreaterThan(5);
    expect(grown).toBeGreaterThan(10);
    // Every building grown stands, against all the others (the ones put in its way among them).
    for (const b of doc.buildings.all()) {
      const lot = doc.lots.find((l) => l.building === b.id);
      if (!lot) continue;
      expect(validateBuilding({ doc, net, groundAt: ground, pavedAt: paved }, b as Building, b.id), `building ${b.id}`).toBeNull();
    }
  });
});

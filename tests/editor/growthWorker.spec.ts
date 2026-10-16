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
import { BATCH_MOST, type GrowAnswer, type GrowAsk, GrowthReplica } from '@editor/growthReplica';
import { validateBuilding } from '@world/buildings/validate';
import { RecordTable, encodeRecords, tableRecords } from '@world/buildings/recordTable';
import type { Building, BuildingId } from '@world/buildings/types';
import { GROUND_ONLY, buildRoadElevation } from '@world/elevation';
import { type PavingSource, pavedHeightFrom } from '@world/paving';
import { footwayRiseAt, packFlush } from '@world/roads/footwayRise';

/** THE GROWTH OFF THE PAGE (`editor/growthFeed.ts`, `growthReplica.ts`): a generated city grown with each building made in a stand-in for the worker - the asks and the answers copied as `postMessage` copies them (`structuredClone`), the replica keeping only what it was sent - is the city the page grows itself (`growOnLot`, as `main.ts` grew it): every record, in the same order, with the same ids, and every lot. And a building made while the document moved is checked again on the page and asked for again, never written over what took its place. */

/** The terrain's cell (`render/terrain.ts`: a plate of 320 cells). */
const CELL = PLATE_SIZE / 320;
/** A hilly ground as the terrain draws it: its corners' heights, each cell split along its diagonal. */
const hill = (x: number, y: number): number => 6 * Math.sin(x / 140) + 4 * Math.cos(y / 110);
const ground = (x: number, y: number): number => latticeHeight(x, y, CELL, (i, j) => hill(i * CELL, -j * CELL));
/** Paving here and there, at the ground and a kerb over it. */
const paved = (x: number, y: number): number => (Math.abs(Math.sin(x * 0.37 + y * 0.11)) < 0.4 ? ground(x, y) + 0.15 : NaN);
/** The city's own paving, as the renderer reads it and packs it for a worker (`renderer.ts` `pavedHeightAt`). */
function streets(net: Network): PavingSource {
  const elevation = buildRoadElevation(net, ground);
  const rise = (x: number, y: number): number => footwayRiseAt(net, x, y);
  return Object.assign(
    (x: number, y: number): number => (elevation.has(GROUND_ONLY) ? pavedHeightFrom(elevation, GROUND_ONLY, rise, x, y) : NaN),
    { pack: (rect: readonly [number, number, number, number]) => {
      const field = elevation.fieldFor!([rect], []), flush = packFlush(net, [rect]);
      return { data: { rect, field: field.data, flush: flush.data }, transfer: [...field.transfer, ...flush.transfer] };
    } });
}

interface City { doc: RoadDoc; net: Network; zoned: number }
type Host = Omit<GrowthHost, 'doc' | 'net' | 'cell'>;
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

/** Grown on the page, one building after another (`growOnLot`), until `upTo` buildings stand. */
function grownHere(city: City, host: Omit<GrowthHost, 'doc' | 'net' | 'cell'>, upTo = Infinity): Set<number> {
  const { doc, net } = city;
  const refused = new Set<number>();
  for (let guard = 0; guard < city.zoned * 3 + 50; guard++) {
    if (doc.buildings.size >= upTo) break;
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
function grownOff(city: City, host: Omit<GrowthHost, 'doc' | 'net' | 'cell'>, most: number, lane = new StandIn(), between?: (k: number, session: GrowthSession) => void): { refused: Set<number>; lane: StandIn; again: number } {
  const { doc, net } = city;
  const refused = new Set<number>();
  const session = new GrowthSession(lane, () => ({ doc, net, cell: CELL, ...host }));
  let again = 0;
  for (let guard = 0; guard < city.zoned * 3 + 50; guard++) {
    if (!session.ask(refused, 0x5eed, most)) break;
    between?.(guard, session);
    const answer = lane.answer!;
    lane.answer = null;
    // Each building stamped as it is written, before the next (`main.ts` `growthAnswered`).
    const out = session.receive(answer, (id) => stamp(doc, id));
    if (out.kind === 'answered' && (out.again || session.busy)) again++;
  }
  return { refused, lane, again };
}

/** Every record and every lot, as text. */
const textOf = (doc: RoadDoc): string[] => [...[...doc.buildings.all()].map((b) => JSON.stringify(b)), ...doc.lots.map((l) => JSON.stringify(l))];

describe('the growth in its worker', () => {
  for (const [seed, hostOf, most] of [
    [2, (): Host => ({ groundAt: ground, pavedAt: paved }), BATCH_MOST],
    [5, (): Host => ({ groundAt: () => 0 }), BATCH_MOST],
    [7, (net: Network): Host => ({ groundAt: ground, pavedAt: streets(net) }), BATCH_MOST],
    [2, (): Host => ({ groundAt: ground, pavedAt: paved }), 1],
  ] as const) it(`grows the city of seed ${seed}, ${most} lot(s) an ask, as the page grows it, record for record`, () => {
    const here = laid(seed), off = laid(seed);
    const host = hostOf(here.net);
    const refusedHere = grownHere(here, host);
    const { refused, lane, again } = grownOff(off, host, most);
    expect(off.doc.buildings.size).toBeGreaterThan(here.zoned * 0.8);
    expect(textOf(off.doc)).toEqual(textOf(here.doc));
    expect([...refused].sort()).toEqual([...refusedHere].sort());
    expect(again).toBeLessThanOrEqual(lane.asks.length / 20);
    // Several lots an ask: the street filling along in the worker (with paving to read, only where it is handed over).
    if (most > 1 && !(host.pavedAt && !('pack' in host.pavedAt))) expect(lane.asks.length).toBeLessThan(off.doc.buildings.size / 4);
    // The city's own paving handed over as its roads, read in the worker (`world/paving.ts`), not read here.
    if (host.pavedAt && 'pack' in host.pavedAt) expect(lane.asks.filter((a) => a.paving && !a.paved).length).toBeGreaterThan(lane.asks.length * 0.9);
    // Each building was sent to the worker once at most (they did not change after), never the town per lot.
    const sent = lane.asks.reduce((n, a) => n + a.sync.buildings.put.length, 0);
    expect(sent).toBeLessThanOrEqual(off.doc.buildings.size);
    expect(lane.asks.filter((a) => a.sync.buildings.reset || a.sync.roads?.reset).length).toBe(1);
    expect(Math.max(...lane.asks.map((a) => a.sync.buildings.put.length))).toBeLessThan(off.doc.buildings.size / 4);
    // Each sent as where it is read (`recordTable.ts` `refOf`): a shared table and its row, never the record.
    expect(lane.asks.every((a) => a.sync.buildings.put.every((r) => r.buffer instanceof SharedArrayBuffer && Number.isInteger(r.row)))).toBe(true);
  });

  it('sends a tile\'s buildings as rows of its one shared table, and grows on them as the page does', () => {
    const here = laid(2), off = laid(2);
    const host = { groundAt: ground, pavedAt: paved };
    const half = Math.floor(here.zoned / 2);
    // Half the town grown alike on both, then its buildings read back from one table, as a streamed tile's are (`tileStore.ts` `tableRecords`).
    const tableOf = (city: City): ArrayBufferLike => {
      grownHere(city, host, half);
      const table = encodeRecords([...city.doc.buildings.all()]).buffer;
      city.doc.buildings.loadPrepared(tableRecords(table));
      return table;
    };
    tableOf(here);
    const table = tableOf(off);
    grownHere(here, host);
    const { lane } = grownOff(off, host, BATCH_MOST);
    expect(textOf(off.doc)).toEqual(textOf(here.doc));
    // The table's handle and its rows, each building once: never a record copied, never a table made again for one of its buildings.
    const fromTable = lane.asks.flatMap((a) => a.sync.buildings.put).filter((r) => r.buffer === table);
    expect(fromTable.length).toBeGreaterThan(10);
    expect(new Set(fromTable.map((r) => r.row)).size).toBe(fromTable.length);
    const rows = new RecordTable(table);
    expect(fromTable.every((r) => r.row < rows.rows && off.doc.buildings.has(rows.ids[r.row] as BuildingId))).toBe(true);
  });

  it('asks again with more round the lot when the worker reads outside what it was sent', () => {
    const here = laid(2), off = laid(2);
    const host = { groundAt: ground, pavedAt: paved };
    grownHere(here, host);
    const lane = new StandIn();
    // Every fifth ask told to the worker as reaching nothing round its lot.
    let k = 0;
    lane.meddle = (ask) => (k++ % 5 === 0 ? { ...ask, reach: { lot: [0, 0, 0, 0], around: [0, 0, 0, 0] } } : ask);
    const { again } = grownOff(off, host, BATCH_MOST, lane);
    expect(again).toBeGreaterThan(5);
    expect(textOf(off.doc)).toEqual(textOf(here.doc));
  });

  it('sends all again to a worker started anew', () => {
    const here = laid(2), off = laid(2);
    const host = { groundAt: ground, pavedAt: paved };
    grownHere(here, host);
    const lane = new StandIn();
    grownOff(off, host, BATCH_MOST, lane, (k, session) => {
      if (k % 13 !== 3) return;
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
    const host = { groundAt: ground, pavedAt: streets(net) };
    const session = new GrowthSession(lane, () => ({ doc, net, cell: CELL, ...host }));
    let blocked = 0, grown = 0;
    for (let k = 0; k < 40; k++) {
      if (!session.ask(refused, 0x5eed, BATCH_MOST)) break;
      const answer = lane.answer!;
      const made = 'grown' in answer ? answer.grown.filter((g) => g.record) : [];
      if (k % 3 === 1 && made.length > 1) {
        // Meanwhile, on the page, a building stands where the answer's second would (not on its lot).
        doc.buildings.add({ ...made[1]!.record!, elements: [] });
        const out = session.receive(answer, (id) => { grown++; stamp(doc, id); });
        expect(out.kind === 'answered' && out.again).toBe(true);
        blocked++;
        continue;
      }
      session.receive(answer, (id) => { grown++; stamp(doc, id); });
    }
    expect(blocked).toBeGreaterThan(5);
    expect(grown).toBeGreaterThan(10);
    // Every building grown stands, against all the others (the ones put in its way among them).
    for (const b of doc.buildings.all()) {
      const lot = doc.lots.find((l) => l.building === b.id);
      if (!lot) continue;
      expect(validateBuilding({ doc, net, groundAt: ground }, b as Building, b.id), `building ${b.id}`).toBeNull();
    }
  });
});

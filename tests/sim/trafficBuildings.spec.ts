import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import type { Building, BuildingId } from '@world/buildings/types';
import { growOnLot } from '@editor/zoning';
import { SimWorld } from '@sim/world';
import { collectBays } from '@sim/agents/parking';
import { YardList } from '@sim/agents/lorryTraffic';
import { doorWay } from '@sim/agents/lotDoors';
import { TrafficBuildingTable, buildingChangesOf, docBuildings, takeTrafficMap, trafficMapOf } from '@sim/agents/trafficBuildings';

/** THE SIMULATION'S WORKER IS SENT WHAT TRAFFIC READS, NEVER THE WHOLE MAP NOR A BUILDING'S RECORD (`sim/host/simClient.ts`) */

const ZONES = [
  { use: 'residential', density: 'medium' }, { use: 'commercial', density: 'low' }, { use: 'industrial', density: 'medium' },
  { use: 'residential', density: 'low' }, { use: 'commercial', density: 'high' }, { use: 'industrial', density: 'medium' },
] as const;

/** A grid of 2 x 2 blocks of 120 m, its lots grown: flats with car parks, shops on the footway, works with docks. */
function town(): { doc: RoadDoc; net: Network } {
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
  doc.lots.forEach((l, k) => zoneLots(doc, [l.id], ZONES[k % ZONES.length]!));
  const refused = new Set<number>();
  for (let k = 0; k < doc.lots.length * 3; k++) {
    if (growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed + k) === null && refused.size >= doc.lots.length) break;
  }
  return { doc, net };
}

/** What a building's record holds that traffic never reads: none of it is sent. */
const RECORD_ONLY = ['storeys', 'facade', 'materials', 'material', 'palette', 'roof', 'roofDetails', 'furnishing', 'decay', 'builtAt', 'lotPlan', 'cores'];
/** The fields of a traffic record. */
const TRAFFIC_KEYS = new Set(['id', 'x', 'y', 'rotation', 'use', 'function', 'volumes', 'elements', 'bounds', 'reach', 'footprints', 'doors', 'docks', 'entrances']);

describe('the map the simulation\'s worker is sent', () => {
  it('is the roads, the transit, the lots and each building\'s traffic record, in the store\'s order', () => {
    const { doc } = town();
    expect(doc.buildings.size).toBeGreaterThan(10);
    const map = trafficMapOf(doc);
    // No terrain, paint, scenery, poles, zones nor people; no buildings in the document part.
    for (const key of Object.keys(map.doc)) expect(['version', 'unit', 'nodes', 'segments', 'transit'], key).toContain(key);
    expect(map.doc.nodes.length).toBe(doc.nodes.size);
    expect(map.doc.segments.length).toBe(doc.segments.size);
    expect(map.lots.length).toBe(doc.lotStore.size);
    expect(map.buildings.map((b) => b.id)).toEqual([...doc.buildings.all()].map((b) => b.id));
    for (const b of map.buildings) for (const key of Object.keys(b)) expect(TRAFFIC_KEYS.has(key), `building ${b.id}: ${key}`).toBe(true);
    const text = JSON.stringify(map.buildings);
    for (const key of RECORD_ONLY) expect(text.includes(`"${key}"`), key).toBe(false);
    // What traffic reads is there: car parks, gates, docks, doors onto the footway.
    expect(map.buildings.some((b) => b.elements?.some((el) => el.kind === 'parking'))).toBe(true);
    expect(map.buildings.some((b) => b.docks.length > 0)).toBe(true);
    expect(map.buildings.some((b) => b.doors.length > 0)).toBe(true);
    expect(map.buildings.some((b) => b.entrances.length > 0)).toBe(true);
  });

  it('makes a copy on which the worker finds the page\'s bays, yards and doors, kept by the diary through edits', () => {
    const { doc, net } = town();
    const page = new SimWorld(doc, net, 7);
    page.rebuildTopology();
    // The worker's side: a document and a table made from the message alone (`postMessage` copies it).
    const copy = new RoadDoc();
    const table = new TrafficBuildingTable(copy.changes);
    takeTrafficMap(copy, table, structuredClone(trafficMapOf(doc)));
    expect(copy.buildings.size).toBe(0);
    // The lots keep their buildings (`fromJSON` alone would drop them: the copy holds no building record).
    const links = (d: RoadDoc): Map<number, number | undefined> => new Map(d.lots.map((l) => [l.id, l.building]));
    expect(links(copy)).toEqual(links(doc));
    expect([...links(doc).values()].some((b) => b !== undefined)).toBe(true);
    const worker = new SimWorld(copy, net, 7, table);
    worker.rebuildTopology();
    const yards = { page: new YardList(), worker: new YardList() };
    const same = (): void => {
      expect([...table.all()]).toEqual([...page.buildings.all()]);
      expect(collectBays(worker)).toEqual(collectBays(page));
      expect(yards.worker.read(worker)).toEqual(yards.page.read(page));
      for (const b of page.buildings.all()) expect(doorWay(table.get(b.id)!), `building ${b.id}`).toEqual(doorWay(b));
    };
    same();
    expect(collectBays(page).length).toBeGreaterThan(10);
    const rng = new Rng(0x7a1c);
    let serial = doc.changes.version;
    let gone: Building[] = [];
    let sent = 0;
    for (let round = 0; round < 8; round++) {
      // Put back only what went in an earlier round: the order of one taken and put back in the same message is not the page's.
      const going: Building[] = [];
      for (let k = 0; k < 3; k++) {
        const all = [...doc.buildings.all()];
        const b = all[rng.int(0, all.length - 1)]!;
        const roll = rng.float();
        if (roll < 0.25) { going.push(b); doc.buildings.remove(b.id); }
        else if (roll < 0.5) doc.buildings.put({ ...b, x: b.x + m(rng.range(-4, 4)), y: b.y + m(rng.range(-4, 4)) });
        // Its wear alone: nothing traffic reads, nothing sent.
        else if (roll < 0.7) doc.buildings.wear(b.id, Math.round(rng.float() * 10) / 10);
        else if (gone.length) { const back = gone.pop()!; doc.buildings.restore(back.id, back); }
      }
      gone = [...gone, ...going];
      // What `SimClient.sendChanges` sends: the buildings the diary names, as traffic records.
      const entries = doc.changes.since(serial, ['buildings'])!;
      serial = doc.changes.version;
      const ids = new Set<BuildingId>();
      for (const e of entries) for (const id of e.ids!) ids.add(id as BuildingId);
      sent += ids.size;
      table.apply(structuredClone(buildingChangesOf(doc, ids)));
      same();
    }
    expect(sent).toBeGreaterThan(5);
  });

  it('files the buildings by place: a box asks the cells it covers and answers in the store\'s order', () => {
    const { doc } = town();
    const copy = new RoadDoc();
    const table = new TrafficBuildingTable(copy.changes);
    takeTrafficMap(copy, table, trafficMapOf(doc));
    const page = docBuildings(doc);
    const rng = new Rng(0xce11);
    let found = 0;
    for (let q = 0; q < 200; q++) {
      const x = m(rng.range(-200, 200)), y = m(rng.range(-200, 200)), w = m(rng.range(0, 150)), h = m(rng.range(0, 150));
      // The page's index answers what may reach the box; the table, what its box (and anchor) meets.
      const want = page.near(x, y, x + w, y + h).filter((b) =>
        Math.min(b.bounds.minX, b.x) <= x + w && Math.max(b.bounds.maxX, b.x) >= x && Math.min(b.bounds.minY, b.y) <= y + h && Math.max(b.bounds.maxY, b.y) >= y);
      const got = table.near(x, y, x + w, y + h);
      expect(got.map((b) => b.id)).toEqual(want.map((b) => b.id));
      found += got.length;
    }
    expect(found).toBeGreaterThan(100);
  });
});

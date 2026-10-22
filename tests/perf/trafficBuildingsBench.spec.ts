import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import { preparedCity } from '@editor/preparedCity';
import { RoadDoc, type SerializedDoc } from '@world/doc';
import { tableIn } from '@world/buildings/recordTable';
import type { BuildingId } from '@world/buildings/types';
import { m } from '@world/units';
import { TrafficBuildingTable, takeTrafficMap, trafficMapOf } from '@sim/agents/trafficBuildings';
import { type DoorWay, doorWay } from '@sim/agents/lotDoors';
import { LotPlaces } from '@sim/ambient/lotPlaces';

/**
 * THE WORKER'S BUILDINGS, ASKED AS TRAFFIC ASKS THEM (queries a second, the cooked large city): a building by id (a hot few and any
 * of the city), its kind (a lot's class in the draws, `lotTraffic.ts` kindClass), the buildings near a box (`Walls.inBox`, `lorryDocks`),
 * the lots a change reaches (`parking.ts` lotsReached), the buildings near a box by id alone (`baySourcesIn`), and a lot people walk to
 * drawn (`LotPlaces.pick`, from anywhere and from the end of a walk).
 */

function cooked(name: string): RoadDoc {
  const dir = new URL('../../cooked/cities/', import.meta.url);
  const data = JSON.parse(gunzipSync(readFileSync(new URL(`${name}.json.gz`, dir))).toString('utf8')) as SerializedDoc;
  const bytes = gunzipSync(readFileSync(new URL(`${name}.table.gz`, dir)));
  const table = tableIn(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const doc = new RoadDoc();
  const city = preparedCity(data, table);
  doc.replaceFromJSON(city.data, { repair: false, buildingTable: city.table!, whole: true });
  return doc;
}

/** Calls a second of `run`, after a warm-up, over at least 300 ms. */
function rate(run: (k: number) => number): number {
  let sink = 0;
  for (let k = 0; k < 2000; k++) sink += run(k);
  let calls = 0;
  const start = performance.now();
  let now = start;
  while (now - start < 300) {
    for (let k = 0; k < 500; k++) sink += run(calls + k);
    calls += 500;
    now = performance.now();
  }
  expect(Number.isFinite(sink)).toBe(true);
  return (calls * 1000) / (now - start);
}

describe("the worker's buildings, asked as traffic asks them", () => {
  it('answers the lookups of the traffic', () => {
    const doc = cooked('large-7');
    const table = new TrafficBuildingTable(new RoadDoc().changes);
    takeTrafficMap(new RoadDoc(), table, trafficMapOf(doc));
    const ids = [...table.ids()] as BuildingId[];
    const rng = new Rng(0xbe7c);
    const anyId = Array.from({ length: 4096 }, () => ids[rng.int(0, ids.length - 1)]!);
    const hotId = anyId.slice(0, 256);
    const places = anyId.map((id) => { const b = table.get(id)!; return [b.x, b.y] as const; });
    const box = m(40), pad = m(10);
    const copy = new RoadDoc();
    const placed = new TrafficBuildingTable(copy.changes);
    takeTrafficMap(copy, placed, trafficMapOf(doc));
    const lots = new LotPlaces<DoorWay>({ wayOf: doorWay });
    lots.sync(placed, copy.changes);
    const coef = [7, 24, 9, 15], joins = (): boolean => true, draws = new Rng(0x91c4);
    // Every lot's way worked out first (once a lot, `LotPlaces.workOut`): the draws alone are timed.
    const workedFrom = performance.now();
    for (const id of ids) lots.wayOf(id, joins);
    const workOut = (ids.length * 1000) / (performance.now() - workedFrom);
    const from = lots.pick(draws, coef, null, joins, m(470), m(40))!;
    expect(from).not.toBeNull();
    const rows = {
      getHot: rate((k) => table.get(hotId[k & 255]!)!.x),
      getAny: rate((k) => table.get(anyId[k & 4095]!)!.x),
      kind: rate((k) => table.facts(anyId[k & 4095]!)!.kind.length),
      near: rate((k) => { const [x, y] = places[k & 4095]!; return table.near(x - box, y - box, x + box, y + box).length; }),
      nearIds: rate((k) => { const [x, y] = places[k & 4095]!; return table.nearIds(x - box, y - box, x + box, y + box).length; }),
      nearAny: rate((k) => {
        const [x, y] = places[k & 4095]!;
        const rects = [[x - box, y - box, x, y], [x, y, x + box, y + box]] as const;
        return table.nearAny(rects, pad, (b, r) => r[0] <= b.reach.maxX && r[2] >= b.reach.minX && r[1] <= b.reach.maxY && r[3] >= b.reach.minY).length;
      }),
      pickAny: rate(() => lots.pick(draws, coef, null, joins, m(470), m(40))?.frontage ?? 0),
      pickFrom: rate(() => lots.pick(draws, coef, from, joins, m(470), m(40))?.frontage ?? 0),
      workOut,
    };
    console.log(`[trafficBuildingsBench] ${ids.length} buildings, queries a second: ${Object.entries(rows).map(([k, v]) => `${k} ${Math.round(v)}`).join(', ')}`);
    expect(rows.getHot).toBeGreaterThan(0);
  }, 120_000);
});

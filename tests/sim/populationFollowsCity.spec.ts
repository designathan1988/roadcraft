import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { growOnLot } from '@editor/zoning';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';
import { DT, TRAFFIC_DENSITY } from '@sim/params';
import { createAgentWalkEngine } from '@sim/agents/walk';
import { trafficTarget } from '@sim/vehicles/spawn';
import { busy, PEOPLE } from '@sim/ambient/demand';

/**
 * THE CITIES ARE EMPTY (the player, 2026-10-11: "A cidade não tem trânsito
 * de carros e nem de pessoas. Todas as cidades são sempre vazias.").
 *
 * The game asked for an absolute 10 cars and 10 people (`editor/persistence.ts`,
 * the panel's default from 2026-10-06), so a crossroads and a town of hundreds
 * of buildings got the same ten (docs/investigacao-populacao.md). It now
 * follows the city (`SimWorld.followCity`): one car per `TRAFFIC_DENSITY` of
 * road times the panel's share and the demand, the scenery's people per 100 m
 * of street by use and hour (`ambient/demand.ts` `PEOPLE` x `busy`).
 *
 * Built here as `main.ts` boots: following the city at the panel's 100 %, the
 * walking engine, the scenery fed from the road ends and the lots.
 */

const ZONES = [
  { use: 'residential', density: 'medium' }, { use: 'commercial', density: 'low' },
  { use: 'residential', density: 'low' }, { use: 'industrial', density: 'medium' },
] as const;

/** A grid of `n` x `n` blocks, zoned and built on, with a road leading off the map at two corners. */
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
  const half = m(block) * (n / 2);
  doc.addSegment(ids[0]![0]! as never, doc.addNode({ x: -half - m(150), y: -half }).id as never, 1);
  doc.addSegment(ids[n]![n]! as never, doc.addNode({ x: half + m(150), y: half }).id as never, 1);
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

/** A crossroads whose four arms lead off the map: the smallest town there is. */
function crossroads(): RoadDoc {
  const doc = new RoadDoc();
  const c = doc.addNode({ x: 0, y: 0 });
  for (const [x, y] of [[-m(160), 0], [m(160), 0], [0, -m(160)], [0, m(160)]] as const) doc.addSegment(doc.addNode({ x, y }).id, c.id, 1);
  return doc;
}

/** The simulation as `main.ts` starts it: following the city, the panel at 100 %. */
function asTheGameStarts(doc: RoadDoc): SimWorld {
  const net = new Network(doc);
  net.rebuild();
  const w = new SimWorld(doc, net, 0x0be9);
  w.rebuildTopology();
  w.usePedestrianEngine(createAgentWalkEngine());
  w.driveModel = 'v2';
  w.followCity = true;
  w.ambient.enabled = true;
  w.ambient.source = 'edges';
  return w;
}

/** Road length as `trafficTarget` measures it: every ribbon's centre line. */
function roadLength(w: SimWorld): number {
  let total = 0;
  for (const ribbon of w.net.ribbons.values()) total += ribbon.full.length;
  return total;
}

describe('a city opened as a new game starts it', () => {
  it('asks for more cars the bigger the city is', () => {
    const small = asTheGameStarts(crossroads());
    const big = asTheGameStarts(town(4, 120));
    expect(roadLength(big)).toBeGreaterThan(roadLength(small) * 4);
    expect(trafficTarget(big), `cars asked for: crossroads ${trafficTarget(small)}, town of ${big.doc.buildings.size} buildings ${trafficTarget(big)}`)
      .toBeGreaterThan(trafficTarget(small));
  });

  it('is lived in for its size: cars by the simulation\'s own density, people by the scenery\'s', () => {
    const doc = town(4, 120);
    expect(doc.buildings.size).toBeGreaterThan(20);
    const w = asTheGameStarts(doc);
    // The map is filled at once on opening (`AmbientWorld.open`, 2 cars and 2 people a tick).
    for (let i = 0; i < Math.round(4 / DT); i++) step(w, { traffic: true, pedestrians: true });
    const road = roadLength(w);
    const hour = (w.city.minutes(w) % 1440) / 60;
    // One car per 45 m of road (`TRAFFIC_DENSITY`) at 100 % and the normal demand.
    const cars = Math.floor(road * TRAFFIC_DENSITY);
    // The quietest street of the scenery's table: a residential one, at this hour (people per 100 m).
    const people = Math.floor((road / m(100)) * PEOPLE.home * busy('home', hour));
    const onFoot = w.pedViews.length;
    const driving = w.vehicles.size + w.city.lots.moving();
    const detail = `${(road / 1000).toFixed(1)} km of road, ${doc.buildings.size} buildings at ${hour.toFixed(1)} h: `
      + `${driving} cars (density ${cars}), ${onFoot} people (street table ${people})`;
    expect(driving, detail).toBeGreaterThanOrEqual(Math.floor(cars * 0.8));
    expect(onFoot, detail).toBeGreaterThanOrEqual(Math.floor(people * 0.8));
  }, 120_000);
});

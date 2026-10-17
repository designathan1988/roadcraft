import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SimHost } from '@sim/host/simHost';
import { makeSharedFrames, type ToSim } from '@sim/host/protocol';
import { RoadDoc, type SerializedDoc } from '@world/doc';
import { TILE } from '@world/tiles';
import { buildingChangesOf, trafficMapOf } from '@sim/agents/trafficBuildings';

/** WHAT THE SIMULATION'S WORKER KEEPS FOR A TILE GOES WITH THE TILE: a town put in and let go again and again, in another place each time (the camera moving round the city), leaves every structure as it was after the first */

const town = JSON.parse(readFileSync('tests/fixtures/parking-town.json', 'utf8')) as SerializedDoc & { buildings: { id: number; x: number }[] };

/** The structures a tile fills, by name: what is read of the worker. */
type Inside = { readonly net: unknown; readonly sim: unknown };
/** A field of the worker read by its path (`a.b.c`). */
const at = (root: unknown, path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | null)?.[k], root);
const STRUCTURES: Readonly<Record<string, (host: Inside) => number>> = {
  walkableCells: (h) => (at(h.net, 'crossingWalkable.made') as Map<number, unknown> | undefined)?.size ?? 0,
  // The cells' versions of the filings by place (`world/cells.ts` CellFiling).
  segmentCells: (h) => versions(at(h.net, 'segmentCells')),
  junctionCells: (h) => versions(at(h.net, 'junctionCells')),
  nodePlaces: (h) => versions(at(h.net, 'build.nodePlaces')),
  junctionFiling: (h) => versions(at(h.sim, 'junctionFiling')),
  // The lights told the page, by junction (`simHost.ts` signals).
  lightsSent: (h) => (at(h, 'lightsSent') as Map<number, string>).size,
};
const versions = (filing: unknown): number => (at(filing, 'versions') as Map<number, number>).size;

async function run(): Promise<Record<string, number>[]> {
  const host = new SimHost(() => {});
  await host.handle({ type: 'init', map: trafficMapOf(new RoadDoc()), live: [], seed: 7, zones: new Map(), frames: makeSharedFrames(), zonesPrefix: null, ambient: 'edges' } as ToSim);
  const controls = { speed: 1, paused: false, traffic: true, pedestrians: true, trafficIntensity: 1, pedestrianIntensity: 1, demandMultiplier: 1, maxShare: 1, focus: null };
  const frames = async (n: number): Promise<void> => { for (let f = 0; f < n; f++) await host.handle({ type: 'frame', wall: 0.05, hold: false, controls } as ToSim); };
  const snaps: Record<string, number>[] = [];
  for (let cycle = 0; cycle < 4; cycle++) {
    // Another place and other ids each time: the town as a tile the region took in, then let go.
    const dx = cycle * TILE * 3, base = (cycle + 1) * 1_000_000;
    const segments = town.segments.map((s) => ({ ...s, id: s.id + base, a: s.a + base, b: s.b + base }));
    const nodes = town.nodes.map((n) => ({ ...n, id: n.id + base, x: n.x + dx, incident: segments.filter((s) => s.a === n.id + base || s.b === n.id + base).map((s) => s.id) }));
    const records = [...nodes.map((n) => ({ part: 'nodes', id: n.id, value: n })), ...segments.map((s) => ({ part: 'segments', id: s.id, value: s }))];
    const doc = new RoadDoc();
    for (const b of town.buildings) doc.buildings.put({ ...b, id: b.id + base, x: b.x + dx } as never);
    const buildings = buildingChangesOf(doc, [...doc.buildings.all()].map((b) => b.id));
    await host.handle({ type: 'delta', delta: { records, lists: [], values: [] }, buildings } as unknown as ToSim);
    await frames(60);
    await host.handle({ type: 'delta', delta: { records: records.map((r) => ({ ...r, value: undefined })), lists: [], values: [] }, buildings: buildings.map((b) => ({ id: b.id, ref: null })) } as unknown as ToSim);
    await frames(30);
    const inside = host as unknown as Inside;
    snaps.push(Object.fromEntries(Object.entries(STRUCTURES).map(([name, size]) => [name, size(inside)])));
  }
  return snaps;
}

describe("the simulation's worker over tiles put in and let go", () => {
  it('keeps no more of them after the fourth than after the first', async () => {
    const snaps = await run();
    expect(snaps[3]).toEqual(snaps[0]);
  }, 60_000);
});

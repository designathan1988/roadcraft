import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { applyLots, planLots, zoneLots } from '@world/lots';
import type { BuildingId } from '@world/buildings/types';
import { growOnLot } from '@editor/zoning';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import { greenCity, layCity, widenCityFootways, zoneCity } from '@editor/cityGenerator';
import { SimWorld } from '@sim/world';
import { type Bay, type BayWorkers, bayChangesSince, baysOfSource, collectBays, useBayWorkers, wallsOf } from '@sim/agents/parking';
import { type BayReads, bayRows, baysOfShare, shareOf } from '@sim/agents/lotBays';
import { lanesNear } from '@sim/agents/laneGrid';

/** THE LOTS' BAYS WORKED OUT OFF THE PAGE ARE THE PAGE'S (`bayPool.ts`, `bays.worker.ts`). */
const strip = (bays: readonly Bay[]): string[] => bays.map(({ id, building, x, y, ox, oy, depth, lane, via, room, kerb }) =>
  [id, building, x, y, ox, oy, depth, room, kerb ? 'k' : '-',
    lane ? `${lane.lanelet}:${lane.at}@${lane.x},${lane.y}>${lane.tx},${lane.ty}:${lane.entryAt ?? '-'}` : 'null',
    via.map((p) => `${p.x},${p.y}`).join(' ')].join('|'));

/** Workers in this process: the share and the bays copied as messages are; answers held until `answer`. */
function inProcess(): BayWorkers & { asked: BuildingId[]; answer(): Promise<void> } {
  let held: (() => void)[] = [];
  const workers = {
    asked: [] as BuildingId[],
    work(asks: Parameters<BayWorkers['work']>[0]) {
      workers.asked.push(...asks.map((a) => a.building.id));
      const sent = structuredClone(shareOf(asks));
      return new Promise<Bay[][]>((resolve) => held.push(() => resolve(structuredClone(baysOfShare(sent)))));
    },
    async answer() {
      const now = held;
      held = [];
      for (const go of now) go();
      // The world takes the answers in (`then`) before this returns.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
  return workers;
}

const PARK = { left: 'parallel', right: 'parallel' } as const;

function town(): { doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: m(-260), y: 0 }).id, b = doc.addNode({ x: m(260), y: 0 }).id;
  const c = doc.addNode({ x: 0, y: m(-200) }).id, d = doc.addNode({ x: 0, y: m(200) }).id;
  doc.addSegment(a, b, 1, null, 0, 'both', null, 'ground', undefined, PARK);
  doc.addSegment(c, d, 1, null, 0, 'both', null, 'ground', undefined, PARK);
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  const zones = [{ use: 'commercial', density: 'low' }, { use: 'residential', density: 'medium' }, { use: 'industrial', density: 'medium' }] as const;
  doc.lots.forEach((l, i) => zoneLots(doc, [l.id], zones[i % zones.length]!));
  return { doc, net };
}

/** A world's lots' bays now, by building, without their ids (`collectBays` numbers them across the town). */
function byLot(w: SimWorld): Map<BuildingId, string[]> {
  const out = new Map<BuildingId, string[]>();
  for (const bay of collectBays(w)) {
    if (bay.kerb) continue;
    let list = out.get(bay.building);
    if (!list) out.set(bay.building, list = []);
    list.push(strip([{ ...bay, id: 0 }])[0]!);
  }
  return out;
}
const own = (w: SimWorld, id: BuildingId): string[] => strip(baysOfSource(w, `L${id}`).map((bay) => ({ ...bay, id: 0 })));

describe('the bays worked out by the workers', () => {
  it('are the bays of the page, and a lot keeps its bays until its answer lands', async () => {
    const { doc, net } = town();
    const refused = new Set<number>();
    for (let k = 0; k < 10; k++) growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed);
    const w = new SimWorld(doc, net, 7);
    w.rebuildTopology();
    const workers = inProcess();
    useBayWorkers(w, workers);
    const fresh = (): string[] => {
      const other = new SimWorld(doc, net, 7);
      other.rebuildTopology();
      return strip(collectBays(other));
    };
    /** An edit looked at: the lots asked keep the bays they had until the workers answer */
    const look = async (edit: () => void): Promise<number> => {
      // Read before the edit (a first look asks its lots here, and has no bays for them yet).
      const start = workers.asked.length;
      const had = byLot(w);
      edit();
      const serial = bayChangesSince(w, -1).serial;
      const asked = workers.asked.slice(start);
      for (const id of asked) expect(own(w, id), `lot ${id} waiting`).toEqual(had.get(id) ?? []);
      await workers.answer();
      const { changed } = bayChangesSince(w, serial);
      for (const id of asked) if (doc.buildings.has(id)) expect(changed, `lot ${id} logged`).toContain(`L${id}`);
      expect(strip(collectBays(w))).toEqual(fresh());
      return asked.length;
    };
    expect(await look(() => {}), 'the first look asks the workers').toBeGreaterThan(3);
    let grown = 0;
    for (let k = 0; k < 30; k++) {
      let id: number | null = null;
      if (await look(() => {
        id = growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed);
        // Every few buildings, one taken away again: a removal is a change too.
        if (id !== null && k % 7 === 6) doc.buildings.remove(id as BuildingId);
      }) > 0) grown++;
      if (id === null && refused.size >= doc.lots.length) break;
    }
    expect(grown, 'growths whose lots the workers worked out').toBeGreaterThan(5);
    expect(collectBays(w).filter((bay) => !bay.kerb && bay.via.length > 0).length).toBeGreaterThan(10);
    // Roads drawn, moved and taken away beside the lots: the lots within reach asked again.
    const [a, b] = [...doc.nodes.keys()];
    const edits: (() => void)[] = [
      () => { const e = doc.addNode({ x: m(-120), y: m(140) }).id, g = doc.addNode({ x: m(120), y: m(140) }).id; doc.addSegment(e, g, 1, null, 0, 'both', null, 'ground', undefined, PARK); },
      () => { doc.moveNode(b!, { x: m(280), y: m(30) }); },
      () => { const seg = [...doc.segments.values()].find((x) => x.a === a || x.b === a); if (seg) doc.removeSegment(seg.id); },
    ];
    let again = 0;
    for (const edit of edits) again += await look(() => { edit(); net.rebuild(); w.rebuildTopology(); });
    expect(again, 'lots asked again after the roads moved').toBeGreaterThan(0);
  });

  it('drops an answer for a lot taken away while it was worked out', async () => {
    const { doc, net } = town();
    const refused = new Set<number>();
    for (let k = 0; k < 16; k++) growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed);
    const w = new SimWorld(doc, net, 7);
    const workers = inProcess();
    useBayWorkers(w, workers);
    bayChangesSince(w, -1);
    const first = [...workers.asked];
    expect(first.length).toBeGreaterThan(2);
    const gone = first[0]!;
    doc.buildings.remove(gone);
    bayChangesSince(w, -1);
    await workers.answer();
    expect(baysOfSource(w, `L${gone}`)).toEqual([]);
    expect(strip(collectBays(w))).toEqual(strip(collectBays(new SimWorld(doc, net, 7))));
  });
});

describe('a generated city', () => {
  it('has, lot by lot, the bays the page works out', async () => {
    const plan = planCity({ ...DEFAULT_CITY, size: 'small' });
    const doc = layCity(plan);
    widenCityFootways(doc);
    const net = new Network(doc);
    net.rebuild();
    applyLots(doc, planLots(doc, net));
    greenCity(doc, net, DEFAULT_CITY.seed);
    const zoned = zoneCity(doc, net, plan);
    const refused = new Set<number>();
    const grow = (count: number): void => {
      for (let guard = 0; guard < count; guard++) if (growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed) === null && refused.size >= zoned) break;
    };
    // A third of the city, looked at whole; then more grown on it, each growth's lots asked again.
    grow(Math.ceil(zoned / 3));
    const w = new SimWorld(doc, net, 7);
    w.rebuildTopology();
    const workers = inProcess();
    useBayWorkers(w, workers);
    bayChangesSince(w, -1);
    const first = workers.asked.length;
    await workers.answer();
    grow(40);
    bayChangesSince(w, -1);
    await workers.answer();
    // The page's own work on the same world (`parking.ts` pageReads), lot by lot
    const walls = wallsOf(w);
    const page: BayReads = {
      lanesNear: (x, y, reach) => lanesNear(w, x, y, reach),
      ghost: (id) => w.rt(id).ghost,
      bothWays: (segment) => w.doc.segment(segment)?.direction === 'both',
      wallsIn: (x0, y0, x1, y1) => walls.inBox(x0, y0, x1, y1),
    };
    let lots = 0, driven = 0;
    for (const b of doc.buildings.all()) {
      if (!(b.elements ?? []).some((el) => el.kind === 'parking')) continue;
      const now = strip(baysOfSource(w, `L${b.id}`)), was = strip(bayRows(page, b));
      expect(now, `lot ${b.id}`).toEqual(was);
      lots++;
      driven += baysOfSource(w, `L${b.id}`).filter((bay) => bay.lane !== null && bay.via.length > 0).length;
    }
    expect(lots, 'lots of the city').toBeGreaterThan(20);
    expect(driven, 'bays driven out of their lots').toBeGreaterThan(100);
    expect(first, 'lots asked at the first look').toBeGreaterThan(20);
    expect(workers.asked.length - first, 'lots asked again as it grew').toBeGreaterThan(10);
  });
});

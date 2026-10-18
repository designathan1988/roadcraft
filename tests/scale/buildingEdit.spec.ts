import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building, BuildingElement } from '@world/buildings/types';
import { createBuildingLayer } from '@render/buildings/layer';
import { m } from '@world/units';
import { type DerivedChangeKind, journalWork } from '@world/changes';
import type { Area, GroundRecord, Rect } from '@render/groundChanges';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { collectBays } from '@sim/agents/parking';
import { type GroundSince, cameraSolidsKeeper } from '@world/buildings/cameraSolids';
import { siteGrading } from '@world/buildings/siteGrading';
import { gardenLists } from '@render/gardenLists';

/** ONE MORE BUILDING COSTS THE SAME IN A SMALL TOWN AND A LARGE ONE (the same rule as `edit.spec.ts` for a road) */
const SPACING = m(60);

/** A blueprint's building at a place of the grid; `planted`: with a tree in its garden. */
function placed(index: number, column: number, row: number, planted = false): Omit<Building, 'id'> {
  const bp = BLUEPRINTS[index % BLUEPRINTS.length]!;
  const body = { ...JSON.parse(JSON.stringify(bp.body)), x: column * SPACING, y: row * SPACING, rotation: 0 } as Omit<Building, 'id'>;
  if (!planted) return body;
  const tree: BuildingElement = { id: 9_999, kind: 'tree', x: 0, y: 0, facing: 0, w: m(1), d: m(1), z: 0, h: m(6) };
  return { ...body, elements: [...(body.elements ?? []), tree] };
}

/** A square town of `n` buildings, and the reads of its buildings counted from now on. */
function town(n: number, planted = false): { doc: RoadDoc; reads: { count: number } } {
  const doc = new RoadDoc();
  // The ground cut and filled before the town grew on it (the opening's world).
  doc.changes.record('ground', null, { cause: 'test: the opening' });
  const side = Math.round(Math.sqrt(n));
  for (let i = 0; i < n; i++) doc.buildings.add(placed(i, i % side, Math.floor(i / side), planted));
  const reads = { count: 0 };
  const store = doc.buildings;
  const all = store.all.bind(store);
  const has = store.has.bind(store);
  const get = store.get.bind(store);
  store.all = function* () { for (const b of all()) { reads.count++; yield b; } };
  store.has = (id) => { reads.count++; return has(id); };
  store.get = (id) => { reads.count++; return get(id); };
  return { doc, reads };
}

const flat = (): number => 0;

/** The buildings layer (`render/buildings/layer.ts`) run frame by frame until it is done, as the game runs it. */
function settle(layer: ReturnType<typeof createBuildingLayer>, doc: RoadDoc): void {
  for (let frame = 0; frame < 2000; frame++) {
    layer.update(doc, flat, 'g');
    if (!layer.pending) return;
  }
  throw new Error('the layer never settled');
}

/** The kinds of change the things on the ground read (`renderer.ts` `GROUND_KINDS`). */
const GROUND_KINDS: readonly DerivedChangeKind[] = ['elevation', 'ground'];

/** The drawn ground's changes as the renderer reads them from the diary (`renderer.ts` `groundChanges`). */
function groundRecord(doc: RoadDoc): GroundRecord {
  return {
    get version() { return doc.changes.serialOf(...GROUND_KINDS); },
    touches: (since, at) => doc.changes.touches(since, at, GROUND_KINDS),
  };
}

/** Where the drawn ground changed since a serial, as the renderer reads it for the camera's solids (`renderer.ts` `groundSince`). */
function groundSince(doc: RoadDoc): GroundSince {
  return {
    get version() { return doc.changes.serialOf(...GROUND_KINDS); },
    rectsSince(since) {
      const entries = doc.changes.since(since, GROUND_KINDS);
      if (!entries || entries.some((e) => e.rects === null)) return null;
      return entries.flatMap((e) => e.rects!);
    },
  };
}

/** A thing drawn on the ground: built again only when its own key changes or the ground changes under its area. */
class GroundDependant {
  private key: string | null = null;
  private seen = -1;

  constructor(private readonly changes: GroundRecord) {}

  stale(key: string, area: Area): boolean {
    if (key === this.key && !this.changes.touches(this.seen, area)) return false;
    this.key = key;
    this.seen = this.changes.version;
    return true;
  }
}

/** The box a building's bank reaches, as the renderer's `bankBox` (a square round it here). */
const bankBox = (b: Building): Rect => [b.x - m(40), b.y - m(40), b.x + m(40), b.y + m(40)];

/** A thing standing on the ground under the whole town */
function groundReader(doc: RoadDoc, area: Rect): () => number {
  const dependant = new GroundDependant(groundRecord(doc));
  return () => {
    const before = journalWork.entries;
    const rebuilt = dependant.stale('', area) ? doc.buildings.size : 0;
    return journalWork.entries - before + rebuilt;
  };
}

/** What each product read to take in one building added beside a town of `n`. */
function addWork(n: number): Record<string, number> {
  const side = Math.round(Math.sqrt(n));
  const { doc, reads } = town(n);
  const layer = createBuildingLayer();
  settle(layer, doc);
  // Built on the town as it stands: the serial of the ground it saw is the opening's.
  const ground = groundReader(doc, [-SPACING, -SPACING, (side + 2) * SPACING, (side + 2) * SPACING]);
  ground();
  // The simulation's products of the buildings: the bays the parked cars stand in
  const net = new Network(doc);
  net.rebuild();
  const w = new SimWorld(doc, net, 0x5ca1e);
  collectBays(w);
  // The renderer's products of the buildings, out of it in modules of their own: the camera's solids
  const solids = cameraSolidsKeeper(() => 0, bankBox, m(40));
  const solidsGround = groundSince(doc);
  solids.follow(doc.buildings, solidsGround);
  solids.solids();
  const sites = siteGrading(flat, undefined, m(9.6), bankBox);
  sites.changedSites(doc.buildings);
  sites.rebuild(doc.buildings);
  // The gardens on a town of the same buildings with a tree in each garden
  const garden = town(n, true);
  const plants = gardenLists(groundRecord(garden.doc), bankBox, () => []);
  plants.update(garden.doc.buildings, true);
  /** What a product read of the buildings, and of the diary, to take the building in. */
  const workOf = (counted: { count: number }, take: () => void): number => {
    counted.count = 0;
    const entries = journalWork.entries;
    take();
    return counted.count + journalWork.entries - entries;
  };
  const work = (take: () => void): number => workOf(reads, take);
  reads.count = 0;
  doc.buildings.add(placed(n, side + 1, 0));
  settle(layer, doc);
  const layerReads = reads.count;
  garden.doc.buildings.add(placed(n, side + 1, 0, true));
  const out = {
    layer: layerReads,
    bays: work(() => collectBays(w)),
    // As the renderer asks them a frame (`draw`): the solids filed again when the camera asks
    solids: work(() => { if (solids.follow(doc.buildings, solidsGround)) solids.solids(); }),
    pads: work(() => { if (sites.changedSites(doc.buildings)) sites.rebuild(doc.buildings); }),
    gardens: workOf(garden.reads, () => plants.update(garden.doc.buildings, true)),
    // The frame after it, and the next one with nothing new
    ground: ground(),
    'ground:idle': ground(),
  };
  layer.dispose();
  return out;
}

describe('the cost of one building added', () => {
  it('does not grow with the town, but for the products still in the baseline, whose growth may only fall', () => {
    const small = addWork(16);
    const large = addWork(64);
    const baseline = JSON.parse(readFileSync(join(process.cwd(), 'tests/scale/baseline.json'), 'utf8')) as Record<string, number>;
    const report: string[] = [];
    for (const product of Object.keys(small)) {
      const key = `building+1:${product}`;
      const ratio = small[product]! > 0 ? large[product]! / small[product]! : large[product]! > 0 ? Infinity : 1;
      const allowed = baseline[key];
      if (allowed === undefined) {
        if (ratio > 1.05) report.push(`${key}: grows with the town (${small[product]} -> ${large[product]}, x${ratio.toFixed(2)})`);
      } else if (ratio > allowed * 1.001) {
        report.push(`${key}: x${ratio.toFixed(2)}, more than the baseline's x${allowed}`);
      } else if (ratio <= 1.05) {
        report.push(`${key}: no longer grows with the town (x${ratio.toFixed(2)}): take it out of tests/scale/baseline.json`);
      }
    }
    expect(report).toEqual([]);
  });
});

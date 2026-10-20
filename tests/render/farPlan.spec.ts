import { describe, expect, it } from 'vitest';

import { FarLevels, type FarRun } from '@render/buildings/farLevels';
import { planBoxes } from '@render/buildings/farPlan';
import { AGGREGATE, type FarCache, PLAN_SIG, emptyRecords, farKey, farNode, nodeSide, runFarJob } from '@render/buildings/farTiles';
import { planKey } from '@render/buildings/farGrid';
import { createBuildingKit } from '@render/buildings/kit';
import { BOX_FLOATS, emitBoxes } from '@render/buildings/massing';
import { drawsSignature } from '@render/buildings/signature';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import { migrateBuilding } from '@world/buildings/serialize';
import type { Building } from '@world/buildings/types';
import { WHOLE_MAP_DEFAULTS, type WholeMapOptions, planWholeMap } from '@world/cityGen/wholeMap';
import { TILE, tileKey } from '@world/tiles';
import type { TileRecords } from '@world/doc';
import { m } from '@world/units';

/** THE BUILDINGS OF THE TILES NEVER MADE, DRAWN FROM THE GENERATOR'S PLAN (`farPlan.ts`, `farTree.ts`) */
const OPTIONS: WholeMapOptions = { ...WHOLE_MAP_DEFAULTS, seed: 7, density: 0.6, industry: true };
const PLAN = planWholeMap(OPTIONS);
/** Heat under which a place is countryside (`wholeMap.ts` `SUBURB`). */
const COUNTRY = 0.24;

const bodyOf = (index: number): Building => JSON.parse(JSON.stringify(BLUEPRINTS[index]!.body)) as Building;
const PLAIN = BLUEPRINTS.map((_, i) => i).filter((i) => !drawsSignature({ ...bodyOf(i), id: 1, x: 0, y: 0, rotation: 0 } as Building));
function building(n: number, x: number, y: number): Building {
  return migrateBuilding({ ...bodyOf(PLAIN[n % PLAIN.length]!), id: n + 1, x, y, rotation: 0 })!;
}

interface Box { x: number; y: number; top: number; floor: number; area: number }
function boxesOf(list: Float32Array): Box[] {
  const out: Box[] = [];
  for (let o = 0; o < list.length; o += BOX_FLOATS) out.push({ x: list[o]!, y: list[o + 1]!, top: list[o + 6]!, floor: list[o + 7]!, area: list[o + 18]! });
  return out;
}
/** Built area and its area-weighted height. */
function built(list: Float32Array): { area: number; height: number } {
  let area = 0, height = 0;
  for (const b of boxesOf(list)) { area += b.area; height += (b.top - b.floor) * b.area; }
  return { area, height: area > 0 ? height / area : 0 };
}

/** A store of bakes in memory, as the browser's keeps them (a copy each). */
function memoryCache(): FarCache & { readonly kept: Map<string, unknown> } {
  const kept = new Map<string, unknown>();
  return {
    kept,
    ready: () => Promise.resolve(true),
    get: (key) => Promise.resolve(kept.get(key)),
    put: (key, value) => { kept.set(key, structuredClone(value)); return Promise.resolve(); },
  };
}
/** A node's bake whatever the world's prefix. */
const entryOf = (cache: ReturnType<typeof memoryCache>, key: string): { sig: string; boxes: Float32Array } | undefined =>
  [...cache.kept].find(([k]) => k.endsWith(`:${key}`))?.[1] as { sig: string; boxes: Float32Array } | undefined;

const runner = (cache: FarCache): FarRun => (job, done) => {
  let live = true;
  void runFarJob(job, cache).then((reply) => { if (live) done(reply); });
  return () => { live = false; };
};

async function until(look: () => void, done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 2000; turn++) {
    look();
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('the far levels never came');
}

/** A level-2 node (4 km) all countryside: no point of it at a town's heat. */
function countryNode(): { i: number; j: number } {
  const side = nodeSide(2);
  for (let r = 1; r < 40; r++) {
    for (let i = -r; i <= r; i++) {
      for (const j of [-r, r]) {
        let cold = true;
        for (let a = 0; a <= 4 && cold; a++) for (let b = 0; b <= 4 && cold; b++) cold = PLAN.heatAt((i + a / 4) * side, (j + b / 4) * side) < COUNTRY;
        if (cold) return { i, j };
      }
    }
  }
  throw new Error('no countryside found');
}

describe("the plan's boxes", () => {
  const side = nodeSide(2), square = side / AGGREGATE;
  const centre = PLAN.centresNear({ x: 0, y: 0 })[0]!;
  const town = { i: Math.floor(centre.x / side), j: Math.floor(centre.y / side) };
  const country = countryNode();

  it('are a pure function of the seed and the place', () => {
    const a = planBoxes(OPTIONS, town.i, town.j, 2), b = planBoxes(OPTIONS, town.i, town.j, 2);
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
    const other = planBoxes({ ...OPTIONS, seed: 8 }, town.i, town.j, 2);
    expect(Buffer.from(other.buffer).equals(Buffer.from(a.buffer))).toBe(false);
  });

  it('are denser and taller at a downtown than in the countryside', () => {
    const downtown = built(planBoxes(OPTIONS, town.i, town.j, 2)), open = built(planBoxes(OPTIONS, country.i, country.j, 2));
    expect(downtown.area).toBeGreaterThan(0);
    expect(downtown.area).toBeGreaterThan(3 * open.area);
    expect(downtown.height).toBeGreaterThan(2 * open.height);
    expect(Math.max(...boxesOf(planBoxes(OPTIONS, town.i, town.j, 2)).map((b) => b.top - b.floor))).toBeGreaterThan(m(40));
  });

  it('leave empty the squares the plan makes parks or open land', () => {
    for (const node of [town, country]) {
      const ox = node.i * side, oy = node.j * side;
      // One point a square at this level: the box of a square stands where its point is.
      for (const b of boxesOf(planBoxes(OPTIONS, node.i, node.j, 2))) {
        const p = { x: ox + (Math.floor((b.x - ox) / square) + 0.5) * square, y: oy + (Math.floor((b.y - oy) / square) + 0.5) * square };
        expect(PLAN.zoneAt(p, false)).not.toBe('park');
      }
    }
    // The countryside has such squares (the test reads something).
    let open = 0;
    for (let a = 0; a < AGGREGATE; a += 8) for (let b = 0; b < AGGREGATE; b += 8) if (PLAN.zoneAt({ x: (country.i * AGGREGATE + a + 0.5) * square, y: (country.j * AGGREGATE + b + 0.5) * square }, false) === 'park') open++;
    expect(open).toBeGreaterThan(0);
  });
});

/** No stand-in where no tile is made (1e0731ce, "the fake far plan is off"): every node is baked from stored tiles, never from the plan. */
describe('the far levels where no tile was made', () => {
  it("draw nothing of the plan, and a node draws its stored tiles' boxes as they come, nothing for the rest", async () => {
    const kit = createBuildingKit();
    const cache = memoryCache();
    const tiles = new Map<number, TileRecords>();
    const sigs: string[] = [];
    const run = runner(cache);
    const far = new FarLevels(kit, (job, done) => { sigs.push(job.sig); return run(job, done); }, 'test:');
    far.setSource({ records: (key) => Promise.resolve(tiles.get(key) ?? null), plan: OPTIONS }, () => false);
    // 2 km over the middle of node f2:0,0, the view reaching 6 km, at a scale its 4 km level is what the view asks for.
    const look = (): void => far.choose(0.5 * nodeSide(2), 0.5 * nodeSide(2), m(2_000), 150, null, m(6_000));
    const lookNear = (): void => far.choose(0.5 * nodeSide(2), 0.5 * nodeSide(2), m(2_000), 1000, null, m(6_000));
    const node = farKey(2, 0, 0);
    await until(look, () => far.waiting === 0);
    // Nothing made: nothing drawn, no plan baked.
    expect(far.shownKeys()).toEqual([]);
    expect(entryOf(cache, planKey(node))).toBeUndefined();

    // Two tiles of it made: their buildings in it, nothing of the plan for the rest.
    const placed = [building(0, 0.5 * TILE, 0.5 * TILE), building(1, 1.5 * TILE, 0.5 * TILE)];
    placed.forEach((b, n) => {
      const key = tileKey(n, 0);
      tiles.set(key, { ...emptyRecords(key, 1), buildings: [JSON.parse(JSON.stringify(b)) as unknown] });
      far.stored(key, 1);
    });
    await until(look, () => far.waiting === 0 && entryOf(cache, node) !== undefined);
    expect(entryOf(cache, node)?.sig).not.toBe(PLAN_SIG);
    expect(far.shownKeys()).toContain(node);
    // The boxes kept apart from the mesh (`farGrid.ts` NODE_BOX_KEY, R20).
    const boxes = boxesOf(entryOf(cache, `${node}#boxes`)!.boxes);
    const inStored = (b: Box): boolean => b.x >= 0 && b.x < 2 * TILE && b.y >= 0 && b.y < TILE;
    const real: number[] = [];
    for (const b of placed) emitBoxes(b, undefined, () => 0, undefined, real);
    const realArea = boxesOf(new Float32Array(real)).reduce((s, b) => s + b.area, 0);
    const storedArea = boxes.filter(inStored).reduce((s, b) => s + b.area, 0);
    expect(realArea).toBeGreaterThan(0);
    expect(Math.abs(storedArea - realArea) / realArea).toBeLessThan(1e-3);
    expect(boxes.filter((b) => !inStored(b))).toEqual([]);

    // Every tile of it made: it gives way to its tiles and plates.
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const key = tileKey(i, j);
        if (!tiles.has(key)) { tiles.set(key, emptyRecords(key, 1)); far.stored(key, 1); }
      }
    }
    await until(lookNear, () => far.waiting === 0 && !far.shownKeys().includes(node));
    const under = far.shownKeys().map(farNode).filter((n) => n.i * nodeSide(n.k) >= 0 && (n.i + 1) * nodeSide(n.k) <= nodeSide(2) && n.j * nodeSide(n.k) >= 0 && (n.j + 1) * nodeSide(n.k) <= nodeSide(2));
    expect(under.length).toBeGreaterThan(0);
    for (const n of under) expect(n.k).toBeLessThanOrEqual(1);
    expect(sigs).not.toContain(PLAN_SIG);
    far.dispose();
    kit.dispose();
  }, 10_000);

  it('draw nothing over a view of 40 km with no tile made, at the standing level neither: no bake asked', async () => {
    const kit = createBuildingKit();
    const cache = memoryCache();
    const sigs: string[] = [];
    const run = runner(cache);
    const far = new FarLevels(kit, (job, done) => { sigs.push(job.sig); return run(job, done); }, 'test:');
    far.setSource({ records: () => Promise.resolve(null), plan: OPTIONS }, () => false);
    const look = (): void => far.choose(0, 0, m(10_000), 50, null, m(20_000));
    await until(look, () => far.waiting === 0);
    // The view jumps to the other corner: nothing stands in for it either.
    await until(() => far.choose(m(4_000), m(4_000), m(300), 1000, null, m(1_500)), () => far.waiting === 0);
    expect(far.shownKeys()).toEqual([]);
    expect(sigs).toEqual([]);
    expect([...cache.kept.keys()]).toEqual([]);
    far.dispose();
    kit.dispose();
  }, 10_000);

  it("ask a node with a tile made as its tiles' bake, never as the plan's, while that bake has not come", async () => {
    const kit = createBuildingKit();
    const cache = memoryCache();
    const sigs: string[] = [];
    // The workers never answer (they wait behind other work).
    const far = new FarLevels(kit, (job) => { sigs.push(job.sig); return () => undefined; }, 'test:');
    const key = tileKey(0, 0);
    far.setSource({ records: () => Promise.resolve({ ...emptyRecords(key, 1), buildings: [JSON.parse(JSON.stringify(building(0, 0.5 * TILE, 0.5 * TILE))) as unknown] }), plan: OPTIONS }, () => false);
    far.stored(key, 1);
    const look = (): void => far.choose(0.5 * nodeSide(2), 0.5 * nodeSide(2), m(2_000), 150, null, m(6_000));
    await until(look, () => sigs.length > 0);
    expect(sigs).not.toContain(PLAN_SIG);
    expect(entryOf(cache, planKey(farKey(2, 0, 0)))).toBeUndefined();
    far.dispose();
    kit.dispose();
  }, 10_000);

  it("leave no made tile bare round the page's region: a node with a tile of the document under it is drawn by its quarters", async () => {
    const kit = createBuildingKit();
    const cache = memoryCache();
    const loaded = tileKey(0, 0);
    const tiles = new Map<number, TileRecords>();
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const key = tileKey(i, j);
        tiles.set(key, { ...emptyRecords(key, 1), buildings: [JSON.parse(JSON.stringify(building(4 * i + j, (i + 0.5) * TILE, (j + 0.5) * TILE))) as unknown] });
      }
    }
    const far = new FarLevels(kit, runner(cache), 'test:');
    far.setSource({ records: (key) => Promise.resolve(tiles.get(key) ?? null), plan: OPTIONS }, (key) => key === loaded);
    // The page holds tile (0, 0); every other tile of node f2:0,0 is made.
    for (const key of tiles.keys()) far.stored(key, 1);
    const look = (): void => far.choose(0.5 * nodeSide(2), 0.5 * nodeSide(2), m(2_000), 1000, null, m(6_000));
    await until(look, () => far.waiting === 0);
    const shown = far.shownKeys().map(farNode);
    for (let x = 0.5; x < 4; x++) {
      for (let y = 0.5; y < 4; y++) {
        if (x < 1 && y < 1) continue;
        const over = shown.filter((n) => x * TILE >= n.i * nodeSide(n.k) && x * TILE < (n.i + 1) * nodeSide(n.k) && y * TILE >= n.j * nodeSide(n.k) && y * TILE < (n.j + 1) * nodeSide(n.k));
        expect(over.length).toBe(1);
      }
    }
    far.dispose();
    kit.dispose();
  }, 10_000);

  it('let go of the meshes asked for a view the camera left: nothing it no longer wants waits ahead of the new view in the queue', () => {
    const kit = createBuildingKit();
    // The workers busy: every job waits; its cancel told.
    const waiting = new Set<string>();
    const far = new FarLevels(kit, (job) => { waiting.add(job.node); return () => { waiting.delete(job.node); }; }, 'test:');
    // The tiles round both corners made.
    const made = new Set<number>();
    for (const c of [-4, 3]) for (let i = c - 2; i <= c + 2; i++) for (let j = c - 2; j <= c + 2; j++) made.add(tileKey(i, j));
    far.setSource({ records: (key) => Promise.resolve(made.has(key) ? emptyRecords(key, 1) : null), plan: OPTIONS }, () => false);
    for (const key of made) far.stored(key, 1);
    // A street's view at one corner of the map: its nodes asked.
    far.choose(m(-4_000), m(-4_000), m(300), 1000, null, m(1_500));
    const corner = [...waiting].filter((key) => { const n = farNode(key); return n.k < 4 && (n.i + 1) * nodeSide(n.k) <= 0 && (n.j + 1) * nodeSide(n.k) <= 0; });
    expect(corner.length).toBeGreaterThan(0);
    // The camera at the other corner: those asks let go.
    far.choose(m(4_000), m(4_000), m(300), 1000, null, m(1_500));
    expect(corner.filter((key) => waiting.has(key))).toEqual([]);
    far.dispose();
    kit.dispose();
  });
});

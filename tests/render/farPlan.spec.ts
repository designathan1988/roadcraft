import { describe, expect, it } from 'vitest';

import { FarLevels, type FarRun } from '@render/buildings/farLevels';
import { planBoxes } from '@render/buildings/farPlan';
import { AGGREGATE, type FarCache, PLAN_SIG, emptyRecords, farKey, farNode, nodeSide, runFarJob } from '@render/buildings/farTiles';
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

describe('the far levels where no tile was made', () => {
  it("draw the plan, and a node takes its stored tiles' boxes in place of the plan's as they come", async () => {
    const kit = createBuildingKit();
    const cache = memoryCache();
    const tiles = new Map<number, TileRecords>();
    const far = new FarLevels(kit, runner(cache), 'test:');
    far.setSource({ records: (key) => Promise.resolve(tiles.get(key) ?? null), plan: OPTIONS }, () => false);
    // 2 km over the middle of node f2:0,0, the view reaching 6 km.
    const look = (): void => far.choose(0.5 * nodeSide(2), 0.5 * nodeSide(2), m(2_000), 1000, null, m(6_000));
    const node = farKey(2, 0, 0);
    await until(look, () => far.waiting === 0);
    expect(far.shownKeys()).toContain(node);
    expect(entryOf(cache, node)?.sig).toBe(PLAN_SIG);

    // Two tiles of it made: the node stays (its plates not whole), their buildings in it, the plan's for the rest.
    const placed = [building(0, 0.5 * TILE, 0.5 * TILE), building(1, 1.5 * TILE, 0.5 * TILE)];
    placed.forEach((b, n) => {
      const key = tileKey(n, 0);
      tiles.set(key, { ...emptyRecords(key, 1), buildings: [JSON.parse(JSON.stringify(b)) as unknown] });
      far.stored(key, 1);
    });
    await until(look, () => far.waiting === 0 && entryOf(cache, node)?.sig !== PLAN_SIG);
    expect(far.shownKeys()).toContain(node);
    // The boxes kept apart from the mesh (`farGrid.ts` NODE_BOX_KEY, R20).
    const mixed = boxesOf(entryOf(cache, `${node}#boxes`)!.boxes);
    const inStored = (b: Box): boolean => b.x >= 0 && b.x < 2 * TILE && b.y >= 0 && b.y < TILE;
    const real: number[] = [];
    for (const b of placed) emitBoxes(b, undefined, () => 0, undefined, real);
    const realArea = boxesOf(new Float32Array(real)).reduce((s, b) => s + b.area, 0);
    const storedArea = mixed.filter(inStored).reduce((s, b) => s + b.area, 0);
    expect(realArea).toBeGreaterThan(0);
    expect(Math.abs(storedArea - realArea) / realArea).toBeLessThan(1e-3);
    expect(mixed.filter((b) => !inStored(b)).reduce((s, b) => s + b.area, 0)).toBeGreaterThan(0);

    // Every tile of it made: it gives way to its tiles and plates, nothing of the plan drawn there.
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const key = tileKey(i, j);
        if (!tiles.has(key)) { tiles.set(key, emptyRecords(key, 1)); far.stored(key, 1); }
      }
    }
    await until(look, () => far.waiting === 0 && !far.shownKeys().includes(node));
    const under = far.shownKeys().map(farNode).filter((n) => n.i * nodeSide(n.k) >= 0 && (n.i + 1) * nodeSide(n.k) <= nodeSide(2) && n.j * nodeSide(n.k) >= 0 && (n.j + 1) * nodeSide(n.k) <= nodeSide(2));
    expect(under.length).toBeGreaterThan(0);
    for (const n of under) expect(n.k).toBeLessThanOrEqual(1);
    far.dispose();
    kit.dispose();
  }, 10_000);

  it('draw a view of 40 km all the way out with no tile made', async () => {
    const kit = createBuildingKit();
    const cache = memoryCache();
    const far = new FarLevels(kit, runner(cache), 'test:');
    far.setSource({ records: () => Promise.resolve(null), plan: OPTIONS }, () => false);
    const look = (): void => far.choose(0, 0, m(10_000), 50, null, m(20_000));
    await until(look, () => far.waiting === 0);
    const shown = far.shownKeys().map(farNode);
    for (let x = -19; x <= 19; x += 2) {
      for (let y = -19; y <= 19; y += 2) {
        const p = { x: m(x * 1000), y: m(y * 1000) };
        const over = shown.filter((n) => p.x >= n.i * nodeSide(n.k) && p.x < (n.i + 1) * nodeSide(n.k) && p.y >= n.j * nodeSide(n.k) && p.y < (n.j + 1) * nodeSide(n.k));
        expect(over.length).toBe(1);
      }
    }
    expect(far.top()).toBeGreaterThan(0);
    far.dispose();
    kit.dispose();
  }, 10_000);

  it('stand in at once where the view jumps to a part of the map nothing of was baked (the standing level)', async () => {
    const kit = createBuildingKit();
    const cache = memoryCache();
    // The workers stalled after the first view: nothing asked after the jump comes.
    let stalled = false;
    const run = runner(cache);
    const far = new FarLevels(kit, (job, done) => (stalled ? () => undefined : run(job, done)), 'test:');
    far.setSource({ records: () => Promise.resolve(null), plan: OPTIONS }, () => false);
    // A street's view at one corner of the map, reaching 1.5 km: nothing near the other corner wanted.
    const at = (x: number, y: number) => (): void => far.choose(m(x), m(y), m(300), 1000, null, m(1_500));
    await until(at(-4_000, -4_000), () => far.waiting === 0);
    expect(far.shownKeys().some((key) => { const n = farNode(key); return n.i >= 0 && n.j >= 0; })).toBe(false);
    stalled = true;
    at(4_000, 4_000)();
    // The 16 km node over the other corner stands for it, baked before the jump.
    expect(far.shownKeys()).toContain(farKey(4, 0, 0));
    far.dispose();
    kit.dispose();
  }, 10_000);

  it("leave no part of the map bare in a map's view where only part of a 16 km node came (the standing level stands for all of it)", async () => {
    const kit = createBuildingKit();
    const cache = memoryCache();
    let stalled = false;
    const run = runner(cache);
    const far = new FarLevels(kit, (job, done) => (stalled ? () => undefined : run(job, done)), 'test:');
    far.setSource({ records: () => Promise.resolve(null), plan: OPTIONS }, () => false);
    // A view near one corner of the 16 km node over the map's north east: what it draws there came; then the workers stalled.
    await until(() => far.choose(m(1_000), m(1_000), m(800), 1000, null, m(3_000)), () => far.waiting === 0);
    stalled = true;
    // The map's view: what came near that corner, nothing else of the node.
    far.choose(m(2_500), m(2_500), m(9_000), 300, null, m(12_000));
    const shown = far.shownKeys().map(farNode);
    for (let x = 250; x < 5_000; x += 500) {
      for (let y = 250; y < 5_000; y += 500) {
        const over = shown.filter((n) => m(x) >= n.i * nodeSide(n.k) && m(x) < (n.i + 1) * nodeSide(n.k) && m(y) >= n.j * nodeSide(n.k) && m(y) < (n.j + 1) * nodeSide(n.k));
        expect(over.length).toBe(1);
      }
    }
    far.dispose();
    kit.dispose();
  }, 10_000);
});

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MeshBasicMaterial, type BufferGeometry, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { m } from '@world/units';
import { Network } from '@world/network';
import { buildRoadElevation } from '@world/elevation';
import { planCity, DEFAULT_CITY } from '@world/cityGen/plan';
import { layCity } from '@editor/cityGenerator';
import type { SceneMaterials } from '@render/materials';
import { buildRoadSurfaces, roadSurfaceSteps, type RoadSurfaces } from '@render/roadSurfaces';
import { TileMesher, type TileMeshes } from '@render/roadTileMesh';
import type { RoadTiler, TileJob } from '@render/roadTilePool';

/**
 * THE ROADS' TILES MADE OFF THE PAGE (`roadTilePool.ts`): the steps with a
 * tiler that does what the workers do - each share handed the roads near its
 * tiles (`TileJob.dataFor`) copied as `postMessage` copies them
 * (`structuredClone`), shaped AND meshed there (`TileMesher`, every vertex's
 * height, frame, tint and section read off those roads alone), the ground's
 * heights asked of the page at the points read, the tiles copied back - build
 * the same surfaces as the page building every tile itself: every attribute
 * and index, byte for byte.
 */
const materials = new Proxy({}, {
  get: (_target, key) => key === 'scale' ? new Proxy({}, { get: () => 4 }) : new MeshBasicMaterial(),
}) as unknown as SceneMaterials;
const ground = (x: number, y: number): number => 2 * Math.sin(x / 90) + 1.5 * Math.cos(y / 70);

function bytesOf(root: Object3D): string {
  const hash = createHash('sha256');
  let meshes = 0;
  root.traverse((object) => {
    const geometry = (object as { geometry?: BufferGeometry }).geometry;
    if (!geometry) return;
    meshes++;
    hash.update(object.name);
    for (const name of ['position', 'normal', 'uv', 'color', 'roadSection']) {
      const array = geometry.getAttribute(name).array as Float32Array;
      hash.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    }
    const index = geometry.getIndex()!.array as Uint32Array;
    hash.update(new Uint8Array(index.buffer, index.byteOffset, index.byteLength));
  });
  return `${meshes} ${hash.digest('hex')}`;
}

/** Shares a batch is cut into, as the pool cuts it between its workers: each reads only the roads handed to it. */
const SHARES = 3;

/** A tiler that does what the pool and its workers do, here: everything crossing a thread copied as messages are. */
function workerTiler(): RoadTiler & { asked: number; groundAsked: number } {
  const tiler = {
    asked: 0,
    groundAsked: 0,
    tiles: (job: TileJob) => {
      tiler.asked += job.tiles.length;
      const per = Math.ceil(job.tiles.length / SHARES);
      const made: TileMeshes[] = [];
      for (let k = 0; k * per < job.tiles.length; k++) {
        const share = job.tiles.slice(k * per, (k + 1) * per);
        const mesher = new TileMesher(structuredClone({ pass: job.pass, tiles: share, data: job.dataFor(share.map((t) => t.rect)).data }));
        let need = mesher.need();
        for (;;) {
          const asked = structuredClone(need);
          tiler.groundAsked += asked.length / 2;
          mesher.give(need, Float64Array.from({ length: asked.length / 2 }, (_, i) => job.terrainAt(asked[i * 2]!, asked[i * 2 + 1]!)));
          const done = mesher.run();
          if ('tiles' in done) { made.push(...structuredClone(done.tiles)); break; }
          need = done.need;
        }
      }
      return Promise.resolve(made.map((tile) => new Map(tile)));
    },
    check: () => {},
  };
  return tiler;
}

/**
 * The grid and bends with what only some maps have: a node lifted by the player (its roads drawn as an
 * alignment of their own, read by segment), a footway laid flush with stone and a cobbled carriageway.
 */
function authored(): RoadDoc {
  const file = JSON.parse(readFileSync('tests/fixtures/grid-and-bends.json', 'utf8')) as { document: {
    nodes: { id: number; heightOffset?: number }[]; segments: { id: number; structure: string; section?: unknown }[] } };
  const { nodes, segments } = file.document;
  const ground = segments.filter((s) => s.structure === 'ground');
  ground[0]!.section = { laneWidth: m(3), sidewalk: m(4), sidewalkLeft: m(2), sidewalkRight: m(4), median: 0, speedKmh: 50, priority: 1,
    flushLeft: true, materials: { footwayLeft: 'stone', carriageway: 'cobble' } };
  ground[3]!.section = { laneWidth: m(3.2), sidewalk: m(3), median: 0, speedKmh: 50, priority: 1, materials: { carriageway: 'concrete', footwayRight: 'concrete' } };
  nodes[5]!.heightOffset = m(4);
  return RoadDoc.fromJSON(file.document as never);
}

async function stepped(net: Network, tiler: RoadTiler, groundMaterial?: MeshBasicMaterial): Promise<RoadSurfaces> {
  const elevation = buildRoadElevation(net, ground);
  const steps = roadSurfaceSteps(net, elevation, materials, ground, undefined, groundMaterial, tiler);
  for (;;) {
    const step = steps.next();
    if (step.done) { step.value.adopt(); return step.value; }
    // Waiting on the tiler: its answer comes in a later task, as a worker's does.
    if (step.value === 'wait') await new Promise((done) => setTimeout(done, 0));
  }
}

describe('road surface tiles made off the page', () => {
  for (const [name, make, lawn] of [
    ['the grid and bends fixture', () => RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/grid-and-bends.json', 'utf8')).document), false],
    ['a generated city', () => layCity(planCity({ ...DEFAULT_CITY, seed: 2, size: 'small' })), true],
    ['the fixture with a road at authored heights, a flush footway and paving', authored, false],
  ] as const) it(`build ${name} as the page does, byte for byte`, async () => {
    const doc = make();
    const net = new Network(doc);
    net.rebuild();
    if (make === authored) expect(net.flushCells.size).toBeGreaterThan(0);
    // The ground verge on the terrain's own material (its UV in world x, y) in one of the two.
    const groundMaterial = lawn ? new MeshBasicMaterial() : undefined;
    const here = buildRoadSurfaces(net, buildRoadElevation(net, ground), materials, ground, undefined, groundMaterial);
    const tiler = workerTiler();
    const off = await stepped(net, tiler, groundMaterial);
    expect(tiler.asked).toBeGreaterThan(20);
    // Every tile made off the page, the ground read on the page only where a worker asked.
    expect(off.built).toBe(tiler.asked);
    expect(tiler.groundAsked).toBeGreaterThan(0);
    expect(bytesOf(off.group)).toBe(bytesOf(here.group));
  });
});

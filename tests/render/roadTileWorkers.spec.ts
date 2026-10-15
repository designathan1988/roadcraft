import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MeshBasicMaterial, type BufferGeometry, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { buildRoadElevation } from '@world/elevation';
import { planCity, DEFAULT_CITY } from '@world/cityGen/plan';
import { layCity } from '@editor/cityGenerator';
import type { SceneMaterials } from '@render/materials';
import { buildRoadSurfaces, roadSurfaceSteps, type RoadSurfaces } from '@render/roadSurfaces';
import { tileShapes } from '@render/roadTileShape';
import type { RoadTiler } from '@render/roadTilePool';

/**
 * THE ROADS' TILES SHAPED OFF THE PAGE (`roadTilePool.ts`): the steps with a
 * tiler that copies the tiles as `postMessage` does (`structuredClone`), shapes
 * them with the same `tileShapes` and copies the shapes back, build the same
 * surfaces as the page building every tile itself - every attribute and index,
 * byte for byte.
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

/** A tiler that does what a worker does, here: the tiles and the shapes copied as messages are. */
function pageTiler(): RoadTiler & { asked: number } {
  const tiler = {
    asked: 0,
    shapes: (tiles: Parameters<RoadTiler['shapes']>[0], specs: Parameters<RoadTiler['shapes']>[1]) => {
      tiler.asked += tiles.length;
      const sent = structuredClone({ tiles, specs });
      return Promise.resolve(structuredClone(sent.tiles.map((t) => tileShapes(t.into, t.rect, sent.specs))));
    },
    check: () => {},
  };
  return tiler;
}

async function stepped(net: Network, tiler: RoadTiler): Promise<RoadSurfaces> {
  const elevation = buildRoadElevation(net, ground);
  const steps = roadSurfaceSteps(net, elevation, materials, ground, undefined, undefined, tiler);
  for (;;) {
    const step = steps.next();
    if (step.done) { step.value.adopt(); return step.value; }
    // Waiting on the tiler: its answer comes in a later task, as a worker's does.
    if (step.value === 'wait') await new Promise((done) => setTimeout(done, 0));
  }
}

describe('road surface tiles shaped off the page', () => {
  for (const [name, make] of [
    ['the grid and bends fixture', () => RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/grid-and-bends.json', 'utf8')).document)],
    ['a generated city', () => layCity(planCity({ ...DEFAULT_CITY, seed: 2, size: 'small' }))],
  ] as const) it(`build ${name} as the page does, byte for byte`, async () => {
    const doc = make();
    const net = new Network(doc);
    net.rebuild();
    const here = buildRoadSurfaces(net, buildRoadElevation(net, ground), materials, ground);
    const tiler = pageTiler();
    const off = await stepped(net, tiler);
    expect(tiler.asked).toBeGreaterThan(20);
    expect(bytesOf(off.group)).toBe(bytesOf(here.group));
  }, 300_000);
});

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
import { buildRoadSurfaces } from '@render/roadSurfaces';

/**
 * THE ROAD SURFACES' PER-VERTEX READS (`roadSurfaces.ts`, `world/elevation.ts`):
 * every point of a tile remembered while it is read (`RoadElevation.remembering`),
 * the footway's outline filed by its straight pieces (`fromFootway`), the
 * ground read only where the height blends into it. The meshes are the bytes
 * the reads made before any of that (commit 8434df1): every attribute and
 * index, with the verge on its own material and on the terrain's.
 * DO NOT update these digests to make a change pass: a different digest is a
 * different road on screen.
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

describe('road surface reads', () => {
  for (const [name, make, plain, onTerrain] of [
    ['the grid and bends fixture',
      () => RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/grid-and-bends.json', 'utf8')).document),
      '134 7fc35c931e1b19c2d87fece26e7649c96c5899cd813009e8c8d35a720eef4db4',
      '134 d463bc490a4e57b1f73c04822c2a8d010f9553dd0ab35baf96813374513a256b'],
    ['a generated city',
      () => layCity(planCity({ ...DEFAULT_CITY, seed: 2, size: 'small', radius: 640 })),
      '144 5f9459e74ff68b075626478bd5dbebc9011225a05c74f93253c824fcb7f8130e',
      '144 c306fb5a274dd28c0979defe4f5c892b4a6a222795ef5a6833573633d849b73a'],
  ] as const) it(`build ${name} byte for byte as before`, () => {
    const net = new Network(make());
    net.rebuild();
    const elevation = buildRoadElevation(net, ground);
    const own = buildRoadSurfaces(net, elevation, materials, ground);
    expect(bytesOf(own.group)).toBe(plain);
    const terrain = buildRoadSurfaces(net, elevation, materials, ground, undefined, new MeshBasicMaterial());
    expect(bytesOf(terrain.group)).toBe(onTerrain);
    // Remembered only while a tile is read: the same point asked afterwards is searched again, and agrees.
    expect(elevation.at(10.5, 20.25)).toBe(elevation.remembering!(() => elevation.at(10.5, 20.25)));
  });
});

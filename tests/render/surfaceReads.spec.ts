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
 *
 * Moved once, 2026-10-15, with the inputs kept road by road (`roadSurfaceInputs.ts`),
 * compared mesh by mesh with the build before: the city's every mesh the same bytes,
 * only the paint's meshes in the catalogue's order (`PAINT_COLOURS`) instead of the
 * order the map first painted them in; the fixture's the same but for the grass
 * verge's heights, at most 0.034 mm apart - its fall read off the footways' outline
 * made round each cell from the footways there (`SurfaceInputs.footwayEdges`), not
 * cut out of one union of the whole town, whose far crossings moved its vertices by
 * Clipper's grid (0.04 mm, `CLIPPER_SCALE`).
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
      '134 f056a9453099d14061179d774ce4a92dbb5c828b4208d3a8db55b9e38c12ad5c',
      '134 ad369e48afa6a6838dd64f8fec0acddf6f35563b1b694d2bb9d4ab7fa911f669'],
    ['a generated city',
      () => layCity(planCity({ ...DEFAULT_CITY, seed: 2, size: 'small', radius: 640 })),
      '144 324af30c814e856dfef1b556a27e124f482722c783f64125fe3d8c6ba630482e',
      '144 4c2dda9ff281fe5336c7be02fdccfc7a0d93ecb65521bc8a6b640d3f33b8d8f5'],
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

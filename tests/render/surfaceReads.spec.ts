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
 * different road on screen. Moved a second time, 2026-10-15, with the triangles' diagonals
 * turned to Delaunay's (`tileShape.ts` `flipToDelaunay`): the same outline and vertices of
 * every piece, other diagonals inside them - photographed before and after in the same views
 * (a crossing, its curb ramps, the zebra, the footway): the same picture. A third time the same day with the
 * vertices that are the same in every attribute made one (`tileMesh.ts` `weldVertices`): the same triangles from
 * fewer vertices, proved corner by corner in `tests/render/weldVertices.spec.ts`.
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
      '134 a49be03eb61108d3f884c6692e205483e5e160b2a7488f1f9ad1cd0bd23d3c7d',
      '134 6f9da7fcfd51ca72eccda047d22aeeeb501efdcec078baf0168fedfc14082a25'],
    ['a generated city',
      () => layCity(planCity({ ...DEFAULT_CITY, seed: 2, size: 'small', radius: 640 })),
      '144 397f75d14eebe42a9caf6a829f959f91cd193487e40a13216e9c866415e6aa85',
      '144 8ad9d88d159469c4fb5d10e58b10db01ece588ac9482e01a5cdfa8ead7dbf731'],
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

import { afterAll, describe, expect, it } from 'vitest';
import { CompressedArrayTexture, type CompressedPixelFormat, type Mesh, RGBAFormat, UnsignedByteType } from 'three';

import { FINISHES, type Finish } from '@world/buildings/materials';
import { kitBoxes, meshesOf } from '@render/buildings/buildingMesh';
import { NORMAL_UNIT, PAINT_ATTRIBUTE, SHELL_MESH, cellArrays, finishId, paintShort } from '@render/buildings/cellArrays';
import type { BuildingChunk, PartBatch, ShellChunk } from '@render/buildings/chunk';
import { PART_KINDS, type PartKind, createBuildingKit } from '@render/buildings/kit';
import { createShellMaterial, finishLookTable } from '@render/buildings/finishes';
import { createFacadeMaterial } from '@render/buildings/facadeLevel';
import { FINISH_LAYER_SIZE, LOOKS, finishTiles } from '@render/bake/finishRecipes';
import { tiledTexels } from '@render/bake/catalogue';
import { disposeSurfaceTextures, primeSurfaceTextures } from '@render/surfaceTextures';
import { cascadedSunChunks, SUN_CASCADES } from '@render/sunCascades';
import { flipRows, mipChain } from '../../scripts/vite/ktx2';
import { MAX_UNITS, listed, textureUnits, total } from './_textureUnits';

/** EVERY FINISH OF A CELL'S SHELLS IN ONE MATERIAL AND ONE DRAW (`finishes.ts`, `cellArrays.ts`, `buildingMesh.ts` `meshesOf`) */

/** A quad of one finish, its x telling the finish (10 m a finish id) and the chunk (1 m each). */
function quad(finish: Finish, chunk: number): ShellChunk {
  const x = finishId(finish) * 10 + chunk;
  const white = paintShort(1), id = finishId(finish);
  return {
    position: Float32Array.of(x, 0, 0, x + 0.5, 0, 0, x + 0.5, 1, 0, x, 1, 0),
    normalDecay: Int16Array.of(0, 0, NORMAL_UNIT, 0, 0, 0, NORMAL_UNIT, 0, 0, 0, NORMAL_UNIT, 0, 0, 0, NORMAL_UNIT, 0),
    paint: Uint16Array.of(white, white, white, id, white, white, white, id, white, white, white, id, white, white, white, id),
    index: Uint32Array.of(0, 1, 2, 0, 2, 3),
  };
}

/** Each vertex's finish id, as the shell's program reads it from its paint (`finishes.ts`). */
const finishesOf = (paint: Uint16Array): number[] => Array.from({ length: paint.length / 4 }, (_, v) => paint[v * 4 + 3]!);

/** A building's chunk with shells in `finishes` and no parts. */
function chunkOf(finishes: readonly Finish[], chunk: number): BuildingChunk {
  const none: PartBatch = { matrices: new Float32Array(0), colours: null, count: 0 };
  const parts = Object.fromEntries(PART_KINDS.map((kind) => [kind, none])) as Record<PartKind, PartBatch>;
  return { shells: Object.fromEntries(finishes.map((f) => [f, quad(f, chunk)])) as BuildingChunk['shells'], parts };
}

/** Byte for byte, without a long diff on failure. */
function firstDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return -2;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

describe("a cell's shells", () => {
  const kit = createBuildingKit();
  afterAll(() => kit.dispose());
  // Five finishes over two buildings, two of them sharing brick.
  const chunks = [chunkOf(['plaster', 'brick', 'glass'], 0), chunkOf(['brick', 'slate', 'wood'], 1)];
  const take = { parts: [] as PartKind[], shells: true, furniture: false, ghost: false, dim: false };

  it('are one set of arrays, each vertex tagged with its own finish', () => {
    const shell = cellArrays(chunks, take, kitBoxes(kit)).shell!;
    const finish = finishesOf(shell.paint);
    expect(shell.position.length / 3).toBe(6 * 4);
    expect(finish.length).toBe(6 * 4);
    const seen = new Set<number>();
    for (let v = 0; v < finish.length; v++) {
      const expected = Math.floor(shell.position[v * 3]! / 10);
      expect(finish[v], `vertex ${v}`).toBe(expected);
      seen.add(expected);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual((['plaster', 'brick', 'glass', 'slate', 'wood'] as const).map(finishId).sort((a, b) => a - b));
    // Every triangle within one finish: the indices shifted with their vertices.
    for (let t = 0; t < shell.index.length; t += 3) {
      const f = finish[shell.index[t]!];
      expect(finish[shell.index[t + 1]!]).toBe(f);
      expect(finish[shell.index[t + 2]!]).toBe(f);
    }
  });

  it('are drawn in one call, lit or faded, the finish ids on the GPU as in the arrays', () => {
    for (const dim of [false, true]) {
      const arrays = cellArrays(chunks, { ...take, dim }, kitBoxes(kit));
      const meshes = meshesOf(arrays, kit, false, dim);
      const shells = meshes.group.children.filter((o) => o.name === SHELL_MESH) as Mesh[];
      expect(meshes.group.children).toHaveLength(1);
      expect(shells).toHaveLength(1);
      const mesh = shells[0]!;
      expect(mesh.material).toBe(dim ? kit.dimShell : kit.shellMaterial);
      expect(mesh.geometry.groups).toHaveLength(0);
      expect(finishesOf(mesh.geometry.getAttribute(PAINT_ATTRIBUTE).array as Uint16Array)).toEqual(finishesOf(arrays.shell!.paint));
      meshes.dispose();
    }
  });
});

describe("the finishes' texture arrays", () => {
  it('give a smaller finish the same texels a metre, tiled in its layer', () => {
    const scales = finishLookTable(true);
    for (const finish of FINISHES) {
      const look = LOOKS[finish];
      expect(FINISH_LAYER_SIZE % look.size, finish).toBe(0);
      // Texels a metre: the layer's side times the uv a metre, as the finish's own texture had them.
      expect(FINISH_LAYER_SIZE * scales[finishId(finish) * 8]!, finish).toBeCloseTo(look.size / look.worldSize, 4);
    }
    expect(FINISHES.some((f) => finishTiles(f) > 1)).toBe(true);
  });

  it('keep a tiled finish\'s every mip level its own, so the image is the one its own texture drew', () => {
    const size = 256;
    let seed = 12345;
    const texels = Uint8Array.from({ length: size * size * 4 }, () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24);
    for (const use of ['color', 'normal', 'data'] as const) {
      const own = mipChain(flipRows(texels, size), size, use);
      const layer = mipChain(flipRows(tiledTexels(texels, size, 2), size * 2), size * 2, use);
      expect(layer.length).toBe(own.length + 1);
      own.forEach((level, k) => expect(firstDifference(layer[k]!, tiledTexels(level, size >> k, 2)), `${use} level ${k}`).toBe(-1));
      expect(firstDifference(layer[own.length]!, own[own.length - 1]!), `${use} last level`).toBe(-1);
    }
  });
});

describe("the shell's programs", () => {
  cascadedSunChunks();
  // The build's arrays stood in for by one-texel ones: the programs as the game compiles them with its maps.
  const array = (): CompressedArrayTexture => new CompressedArrayTexture([{ data: new Uint8Array(4 * FINISHES.length), width: 1, height: 1 }],
    1, 1, FINISHES.length, RGBAFormat as unknown as CompressedPixelFormat, UnsignedByteType);
  primeSurfaceTextures(new Map([['building-finishes:map', array()], ['building-finishes:normal', array()], ['building-finishes:rough', array()]]), () => {});
  afterAll(() => disposeSurfaceTextures());

  it('fit 12 texture units with the 3 cascades, every finish read from 3 arrays', () => {
    const shell = createShellMaterial();
    const facade = createFacadeMaterial(shell, {
      glass: shell.clone(), glassDark: shell.clone(), door: shell.clone(), shutter: shell.clone(), frame: shell.clone(),
    }, { roomsAwake: { value: 0 }, massingNight: { value: 0 } });
    const dim = createShellMaterial({ plain: true });
    const maps = ['shellMaps', 'shellNormals', 'shellRough'];
    const lit = [...maps, 'dfgLUT', `directionalShadowMap[${SUN_CASCADES}]`, 'envMap', 'uLots'].sort();
    for (const [name, material, expected] of [['shell', shell, lit], ['facade', facade, lit], ['dim', dim, lit.filter((u) => u !== 'uLots')]] as const) {
      const units = textureUnits(material, { instanceColor: false, morph: false, instanced: false });
      expect(total(units), `${name}: ${listed(units)}`).toBeLessThanOrEqual(MAX_UNITS);
      expect(listed(units).split(' ').sort(), name).toEqual(expected);
    }
  });
});

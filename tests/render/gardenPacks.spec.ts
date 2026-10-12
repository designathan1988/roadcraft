import { describe, expect, it } from 'vitest';
import type { InstancedMesh } from 'three';
import { buildGardens, createSceneryKit, type GardenPlant } from '@render/scenery';
import { m } from '@world/units';

/**
 * The gardens are packed building by building (`scenery.ts` `gardenPack`,
 * audit M3a): the town's meshes copied from the packs must be the very
 * instances one pass over every plant in the same order places.
 */
const plant = (i: number, kind: GardenPlant['kind']): GardenPlant => ({
  kind, x: m(3) * i, y: m(2) * (i % 5), z: m(0.1) * (i % 3), w: m(2) + (i % 4) * m(0.5), d: m(1.5), h: m(2) + (i % 3), yaw: i * 0.7, seed: (i * 0.137) % 1,
});
const KINDS: GardenPlant['kind'][] = ['tree', 'shrub', 'hedge', 'flowers'];

describe('garden packs', () => {
  it('per-building packs give the instances of one list of every plant', () => {
    const kit = createSceneryKit();
    const groups = [0, 1, 2, 3].map((g) => Array.from({ length: 9 }, (_, i) => plant(g * 9 + i, KINDS[(g + i) % 4]!)));
    const split = buildGardens(groups, kit);
    const whole = buildGardens([groups.flat()], kit);
    expect(split.meshes.map((x) => x.name)).toEqual(whole.meshes.map((x) => x.name));
    split.meshes.forEach((mesh, i) => {
      const other = whole.meshes[i] as InstancedMesh;
      expect(mesh.count).toBe(other.count);
      expect(Array.from(mesh.instanceMatrix.array)).toEqual(Array.from(other.instanceMatrix.array));
      expect(mesh.instanceColor ? Array.from(mesh.instanceColor.array) : null).toEqual(other.instanceColor ? Array.from(other.instanceColor.array) : null);
      expect(mesh.castShadow).toBe(other.castShadow);
    });
    // The same list again is not placed again: its pack is kept.
    const again = buildGardens(groups, kit);
    expect(again.meshes.length).toBe(split.meshes.length);
    expect(split.triangles).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from 'vitest';
import { InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import type { CellArrays } from '@render/buildings/cellArrays';
import { createBuildingKit } from '@render/buildings/kit';
import { PartCell, type PartView } from '@render/buildings/partCells';

/** A CELL'S PARTS DRAWN BY THEIR ERROR ON THE SCREEN (`partCells.ts`) */
const kit = createBuildingKit();

/** `n` frames of one shape at a map point, as a worker sends a sub-cell's (three's world: y up, z the map's -y). */
function frames(shapes: readonly (readonly [number, number, number, number])[], x: number, y: number): NonNullable<CellArrays['parts']['frame']> {
  const count = shapes.reduce((sum, [n]) => sum + n, 0);
  const instanceMatrix = new Float32Array(count * 16);
  let at = 0;
  for (const [n, sx, sy, sz] of shapes) {
    for (let i = 0; i < n; i++, at++) new Matrix4().compose(new Vector3(x, 5 + i * 0.01, -y), new Quaternion(), new Vector3(sx, sy, sz)).toArray(instanceMatrix, at * 16);
  }
  const bounds = new Float64Array([x - 2, 0, -y - 2, x + 2, 10, -y + 2, x, 5, -y, 4]);
  return { count, instanceMatrix, instanceColor: new Float32Array(count * 3).fill(1), bounds };
}

const arrays = (part: NonNullable<CellArrays['parts']['frame']>): CellArrays => ({ shell: null, parts: { frame: part }, furniture: {} });
const view = (x: number, y: number, z: number, shadowTexel = Infinity): PartView => ({ x, y, z, pxAtMetre: 1000, orthoPx: null, shadowTexel });
const drawn = (cell: PartCell): InstancedMesh[] => cell.group.children.filter((o): o is InstancedMesh => o instanceof InstancedMesh && o.visible);

describe('the parts of a cell', () => {
  // A window's frame (6 cm deep) and a gourmet balcony's post, the same part 50 cm deep.
  const windows = [100, 1.2, 1.5, 0.06] as const, posts = [100, 0.06, 0.3, 0.5] as const;

  it('draw a window frame by its street faces once its depth is under a pixel, a deep post whole', () => {
    const cell = new PartCell('0,0', [['0,0', arrays(frames([windows, posts], 10, 10))]], kit);
    // 200 m off: the windows' 6 cm are 0.3 px, the posts' 50 cm are 2.5 px.
    cell.choose(view(10, 210, 5));
    const levels = kit.screen.frame.levels;
    const shown = drawn(cell);
    expect(shown.map((mesh) => levels.findIndex((l) => l.geometry === mesh.geometry)).sort()).toEqual([0, 1]);
    expect(shown.map((mesh) => mesh.count)).toEqual([100, 100]);
    expect(cell.triangles).toBe(100 * levels[0]!.triangles + 100 * levels[1]!.triangles);
  });

  it('draw nothing where an instance is under a pixel, and come back without being made again', () => {
    const cell = new PartCell('0,0', [['0,0', arrays(frames([windows, posts], 10, 10))]], kit);
    cell.choose(view(10, 5010, 5));
    expect(drawn(cell)).toHaveLength(0);
    const made = cell.group.children.length;
    cell.choose(view(10, 210, 5));
    cell.choose(view(10, 5010, 5));
    cell.choose(view(10, 210, 5));
    expect(drawn(cell)).toHaveLength(2);
    expect(cell.group.children.length).toBe(Math.max(made, 2));
  });

  it('cast a frame\'s shadow only where its bars span a shadow texel', () => {
    const cell = new PartCell('0,0', [['0,0', arrays(frames([windows], 10, 10))]], kit);
    cell.choose(view(10, 30, 5, 0.05));
    expect(drawn(cell).every((mesh) => mesh.castShadow)).toBe(true);
    cell.choose(view(10, 30, 5, 0.2));
    expect(drawn(cell).some((mesh) => mesh.castShadow)).toBe(false);
    // A post is the frame's model 30 cm tall and 50 cm deep: its sides' shadow spans the texel.
    const post = new PartCell('0,0', [['0,0', arrays(frames([posts], 10, 10))]], kit);
    post.choose(view(10, 30, 5, 0.2));
    expect(drawn(post).every((mesh) => mesh.castShadow)).toBe(true);
  });

  it('choose by sub-cell: the near sub-cell whole, the far one by its street faces', () => {
    // Two sub-cells 192 m apart in the same cell, the eye over the first: enough frames for a split to spare more than its draws.
    const many = [300, 1.2, 1.5, 0.06] as const;
    const near = frames([many], 10, 10), far = frames([many], 10, 202);
    const cell = new PartCell('0,0', [['0,0', arrays(near)], ['0,3', arrays(far)]], kit);
    cell.choose(view(10, 10, 20));
    const levels = kit.screen.frame.levels;
    const shown = drawn(cell).map((mesh) => levels.findIndex((l) => l.geometry === mesh.geometry)).sort();
    expect(shown).toEqual([0, 1]);
  });

  it('refuse a sub-cell outside its cell', () => {
    expect(() => new PartCell('0,0', [['4,0', arrays(frames([windows], 300, 10))]], kit)).toThrow();
  });
});

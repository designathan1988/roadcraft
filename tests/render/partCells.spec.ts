import { POSE_FLOATS } from '@render/buildings/partPose';
import { fileParts, partBandings } from '@render/buildings/partFiling';
import { describe, expect, it } from 'vitest';
import { type BufferGeometry, InstancedMesh, type InterleavedBufferAttribute } from 'three';
import { type BuildingChunk, emitChunk, kitBoxes } from '@render/buildings/buildingMesh';
import { type CellArrays, cellArrays } from '@render/buildings/cellArrays';
import { PART_KINDS, type PartKind, createBuildingKit } from '@render/buildings/kit';
import { BATCH_CELL, DETAIL_CELL, DETAIL_PARTS } from '@render/buildings/layerCells';
import { PartCell, type PartView } from '@render/buildings/partCells';
import { SHELL_PART_KINDS } from '@render/buildings/shellParts';
import { growOnLot } from '@world/growth/zoning';
import type { Building } from '@world/buildings/types';
import { RoadDoc } from '@world/doc';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { Network } from '@world/network';
import { m } from '@world/units';

/** A CELL'S PARTS DRAWN BY THEIR ERROR ON THE SCREEN (`partCells.ts`) */
const kit = createBuildingKit();

/** `n` frames of one shape at a map point, as a worker sends a sub-cell's (three's world: y up, z the map's -y). */
function frames(shapes: readonly (readonly [number, number, number, number])[], x: number, y: number): NonNullable<CellArrays['parts']['frame']> {
  const count = shapes.reduce((sum, [n]) => sum + n, 0);
  // Each one's pose (`partPose.ts`): its place in three's world, no turn, its scale.
  const poses = new Float32Array(count * POSE_FLOATS);
  let at = 0;
  for (const [n, sx, sy, sz] of shapes) {
    for (let i = 0; i < n; i++, at++) poses.set([x, 5 + i * 0.01, -y, 1, 0, sx, sy, sz], at * POSE_FLOATS);
  }
  const bounds = new Float64Array([x - 2, 0, -y - 2, x + 2, 10, -y + 2, x, 5, -y, 4]);
  return { count, poses, instanceColor: new Float32Array(count * 3).fill(1), bounds };
}

const arrays = (part: NonNullable<CellArrays['parts']['frame']>): CellArrays => ({ shells: [], parts: { frame: part }, furniture: {} });
const view = (x: number, y: number, z: number, shadowTexel = Infinity): PartView => ({ x, y, z, pxAtMetre: 1000, orthoPx: null, shadowTexel });
/** A band's widest piece as `PartCell.choose` measures it: each piece's middle side at the largest scale of the instances. */
function widest(kind: PartKind, sources: readonly { readonly poses: Float32Array; readonly count: number }[]): number {
  const scale = [0, 0, 0];
  for (const p of sources) for (let i = 0; i < p.count; i++) for (let k = 0; k < 3; k++) scale[k] = Math.max(scale[k]!, p.poses[i * POSE_FLOATS + 5 + k]!);
  let width = 0;
  for (const piece of kit.screen[kind].pieces) {
    const x = piece[0] * scale[0]!, y = piece[1] * scale[1]!, z = piece[2] * scale[2]!;
    width = Math.max(width, Math.max(Math.min(x, y), Math.min(Math.max(x, y), z)));
  }
  return width;
}

/** The level a mesh draws: its posed copy shares the level's model (`partPose.ts` `posedCopy`). */
const levelOf = (levels: readonly { readonly geometry: BufferGeometry }[], mesh: InstancedMesh): number =>
  levels.findIndex((l) => l.geometry.getAttribute('position') === mesh.geometry.getAttribute('position'));
const drawn = (cell: PartCell): InstancedMesh[] => cell.group.children.filter((o): o is InstancedMesh => o instanceof InstancedMesh && o.visible);

describe('the parts of a cell', () => {
  // A window's frame (6 cm deep) and a gourmet balcony's post, the same part 50 cm deep.
  const windows = [100, 1.2, 1.5, 0.06] as const, posts = [100, 0.06, 0.3, 0.5] as const;

  it('draw a window frame by its street faces once its depth is under a pixel, a deep post whole', () => {
    const cell = new PartCell('0,0', fileParts('0,0', [['0,0', arrays(frames([windows, posts], 10, 10))]], partBandings(kit.screen)), kit);
    // 200 m off: the windows' 6 cm are 0.3 px, the posts' 50 cm are 2.5 px.
    cell.choose(view(10, 210, 5));
    const levels = kit.screen.frame.levels;
    const shown = drawn(cell);
    expect(shown.map((mesh) => levelOf(levels, mesh)).sort()).toEqual([0, 1]);
    expect(shown.map((mesh) => mesh.count)).toEqual([100, 100]);
    expect(cell.triangles).toBe(100 * levels[0]!.triangles + 100 * levels[1]!.triangles);
  });

  it('draw nothing where an instance is under a pixel, and come back without being made again', () => {
    const cell = new PartCell('0,0', fileParts('0,0', [['0,0', arrays(frames([windows, posts], 10, 10))]], partBandings(kit.screen)), kit);
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
    const cell = new PartCell('0,0', fileParts('0,0', [['0,0', arrays(frames([windows], 10, 10))]], partBandings(kit.screen)), kit);
    cell.choose(view(10, 30, 5, 0.05));
    expect(drawn(cell).every((mesh) => mesh.castShadow)).toBe(true);
    cell.choose(view(10, 30, 5, 0.2));
    expect(drawn(cell).some((mesh) => mesh.castShadow)).toBe(false);
    // A post is the frame's model 30 cm tall and 50 cm deep: its sides' shadow spans the texel.
    const post = new PartCell('0,0', fileParts('0,0', [['0,0', arrays(frames([posts], 10, 10))]], partBandings(kit.screen)), kit);
    post.choose(view(10, 30, 5, 0.2));
    expect(drawn(post).every((mesh) => mesh.castShadow)).toBe(true);
  });

  it('choose by sub-cell: the near sub-cell whole, the far one by its street faces', () => {
    // Two sub-cells 192 m apart in the same cell, the eye over the first: enough frames for a split to spare more than its draws.
    const many = [300, 1.2, 1.5, 0.06] as const;
    const near = frames([many], 10, 10), far = frames([many], 10, 202);
    const cell = new PartCell('0,0', fileParts('0,0', [['0,0', arrays(near)], ['0,3', arrays(far)]], partBandings(kit.screen)), kit);
    cell.choose(view(10, 10, 20));
    const levels = kit.screen.frame.levels;
    const shown = drawn(cell).map((mesh) => levelOf(levels, mesh)).sort();
    expect(shown).toEqual([0, 1]);
  });

  it('refuse a sub-cell outside its cell', () => {
    expect(() => new PartCell('0,0', fileParts('0,0', [['4,0', arrays(frames([windows], 300, 10))]], partBandings(kit.screen)), kit)).toThrow();
  });
});

const groundAt = (x: number, y: number): number => x * 0.031 - y * 0.017 + Math.sin(x * 0.05) * m(0.4);

/** A small town grown on its lots, every use and density: gates, fences, bins and pavings. */
function grownTown(): Building[] {
  const doc = new RoadDoc();
  const ids: number[][] = [];
  for (let i = 0; i <= 2; i++) { ids.push([]); for (let j = 0; j <= 2; j++) ids[i]!.push(doc.addNode({ x: m(120) * (i - 1), y: m(120) * (j - 1) }).id); }
  for (let i = 0; i <= 2; i++) {
    for (let j = 0; j <= 2; j++) {
      if (i < 2) doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, 1);
      if (j < 2) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, 1);
    }
  }
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  doc.lots.forEach((l, k) => zoneLots(doc, [l.id], { use: (['residential', 'commercial', 'industrial'] as const)[k % 3]!, density: (['low', 'medium', 'high'] as const)[(k >> 1) % 3]! }));
  const refused = new Set<number>();
  for (let k = 0; k < doc.lots.length * 3; k++) {
    if (growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
  }
  return [...doc.buildings.all()];
}

/** A cell's key, or a sub-cell's, from a point of the map. */
const keyAt = (x: number, y: number, side: number): string => `${Math.floor(x / side)},${Math.floor(y / side)}`;

/** Each instance's place (its matrix's translation), sorted: the instances a set of ranges draws, whatever their order. */
function places(ranges: readonly { array: ArrayLike<number>; stride: number; offset: number; count: number }[]): string[] {
  const out: string[] = [];
  for (const { array, stride, offset, count } of ranges) {
    for (let i = 0; i < count; i++) out.push([0, 1, 2].map((k) => array[i * stride + offset + k]!.toFixed(4)).join(' '));
  }
  return out.sort();
}

describe("the shell's parts of a grown town's cells", () => {
  const town = grownTown();
  const boxes = kitBoxes(kit);
  const detailParts = PART_KINDS.filter((p) => DETAIL_PARTS.has(p));

  for (const far of [false, true]) {
    it(`draw each kind in one mesh a cell with every instance, near, far, under a pixel and into any cascade (${far ? 'facade level' : 'detail'})`, () => {
      // The town by cell, then by sub-cell, as the workers file it (`cellWork.ts`).
      const byCell = new Map<string, Map<string, BuildingChunk[]>>();
      for (const b of town) {
        const cell = keyAt(b.x, b.y, BATCH_CELL), sub = keyAt(b.x, b.y, DETAIL_CELL);
        let subs = byCell.get(cell);
        if (!subs) byCell.set(cell, subs = new Map());
        const chunk = emitChunk(b, groundAt, undefined, groundAt, undefined, far);
        const list = subs.get(sub);
        if (list) list.push(chunk);
        else subs.set(sub, [chunk]);
      }
      let seen = 0;
      for (const [key, subs] of byCell) {
        const details = [...subs].map(([sub, chunks]) => [sub, cellArrays(chunks, { parts: detailParts, shells: false, furniture: false, ghost: false, dim: false }, boxes)] as const);
        const cell = new PartCell(key, fileParts(key, details, partBandings(kit.screen)), kit);
        const comma = key.indexOf(',');
        const cx = (Number(key.slice(0, comma)) + 0.5) * BATCH_CELL, cy = (Number(key.slice(comma + 1)) + 0.5) * BATCH_CELL;
        // Over the cell, beside it with shadows, far off, and from above at a tiny scale where every other part is under a pixel.
        const eyes: PartView[] = [view(cx, cy, 2), view(cx + 300, cy, 50, 0.1), view(cx + 3000, cy + 3000, 400, 2), { ...view(cx, cy, 500), orthoPx: 0.02 }];
        for (const eye of eyes) {
          cell.choose(eye);
          // As a frame casts into the eye's cascade (`castInto`): the coarse cascades cast into before left their own choice.
          cell.castInto(eye.shadowTexel);
          for (const kind of SHELL_PART_KINDS) {
            const sources = details.flatMap(([, a]) => { const p = a.parts[kind]; return p ? [p] : []; });
            const total = sources.reduce((n, p) => n + p.count, 0);
            const meshes = drawn(cell).filter((mesh) => mesh.name === `building-${kind}`);
            if (total === 0) { expect(meshes, `${key} ${kind}`).toHaveLength(0); continue; }
            seen++;
            expect(meshes, `${key} ${kind}`).toHaveLength(1);
            const mesh = meshes[0]!;
            expect(mesh.count).toBe(total);
            // Into a cascade whose texel its widest piece spans (`choose`): a shell's part's rail out of the coarse ones.
            expect(mesh.castShadow).toBe(Number.isFinite(eye.shadowTexel) && widest(kind, sources) >= eye.shadowTexel);
            // The same instances as the sub-cells sent, every one.
            const attribute = mesh.geometry.getAttribute('instancePoseA') as InterleavedBufferAttribute;
            const got = places([{ array: attribute.data.array, stride: attribute.data.stride, offset: attribute.offset, count: mesh.count }]);
            expect(got).toEqual(places(sources.map((p) => ({ array: p.poses, stride: POSE_FLOATS, offset: 0, count: p.count }))));
          }
          // Into the finest cascade a shell's part casts; into one whose texel is wider than its widest piece it does not (drawn all the same).
          for (const [texel, casts] of [[0.05, true], [1e6, false]] as const) {
            cell.castInto(texel);
            for (const mesh of drawn(cell)) if ((SHELL_PART_KINDS as readonly string[]).includes(mesh.name.slice('building-'.length))) expect(mesh.castShadow).toBe(casts);
          }
        }
        cell.dispose();
      }
      expect(seen).toBeGreaterThan(0);
    });
  }
});

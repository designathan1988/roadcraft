import { POSE_FLOATS } from '@render/buildings/partPose';
import { fileParts, partBandings } from '@render/buildings/partFiling';
import { describe, expect, it } from 'vitest';
import { type BufferGeometry, DataUtils, InstancedMesh, type InterleavedBufferAttribute, type Mesh } from 'three';
import { type BuildingChunk, emitChunk, kitBoxes } from '@render/buildings/buildingMesh';
import { type CellArrays, cellArrays } from '@render/buildings/cellArrays';
import { PART_KINDS, createBuildingKit } from '@render/buildings/kit';
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
  return { count, poses, instanceColor: new Uint16Array(count * 3).fill(DataUtils.toHalfFloat(1)), bounds };
}

const arrays = (part: NonNullable<CellArrays['parts']['frame']>): CellArrays => ({ shells: [], parts: { frame: part }, furniture: {} });
const view = (x: number, y: number, z: number, shadowTexel = Infinity): PartView => ({ x, y, z, pxAtMetre: 1000, orthoPx: null, shadowTexel });
/** The level a mesh draws: its posed copy shares the level's model (`partPose.ts` `posedCopy`). */
const levelOf = (levels: readonly { readonly geometry: BufferGeometry }[], mesh: InstancedMesh): number =>
  levels.findIndex((l) => l.geometry.getAttribute('position') === mesh.geometry.getAttribute('position'));
const drawn = (cell: PartCell): InstancedMesh[] => cell.group.children.filter((o): o is InstancedMesh => o instanceof InstancedMesh && o.visible);

describe('the parts of a cell', () => {
  // A window's frame (6 cm deep) and a gourmet balcony's post, the same part 50 cm deep.
  // Enough of each for its own band and draw (`partFiling.ts` `DRAW_TRIANGLES`).
  const windows = [400, 1.2, 1.5, 0.06] as const, posts = [400, 0.06, 0.3, 0.5] as const;

  it('draw a window frame by its street faces once its depth is under a pixel, a deep post whole', () => {
    const cell = new PartCell('0,0', fileParts('0,0', [['0,0', arrays(frames([windows, posts], 10, 10))]], partBandings(kit.screen)), kit);
    // 100 m off: the windows' 6 cm deep are 0.6 px (their bars, 6 cm and more, still half a pixel: drawn), the posts' 50 cm are 5 px.
    cell.choose(view(10, 110, 5));
    const levels = kit.screen.frame.levels;
    const shown = drawn(cell);
    expect(shown.map((mesh) => levelOf(levels, mesh)).sort()).toEqual([0, 1]);
    expect(shown.map((mesh) => mesh.count)).toEqual([400, 400]);
    expect(cell.triangles).toBe(400 * levels[0]!.triangles + 400 * levels[1]!.triangles);
  });

  it('leave a frame out once its bars span under half a pixel, its box however large: a deep post stays', () => {
    const cell = new PartCell('0,0', fileParts('0,0', [['0,0', arrays(frames([windows, posts], 10, 10))]], partBandings(kit.screen)), kit);
    // 200 m off: the windows' bars are a third of a pixel (shimmer, not detail); their 1.9 m diagonal would have kept them to 1.9 km. The posts' bars stand.
    cell.choose(view(10, 210, 5));
    const shown = drawn(cell);
    expect(shown.map((mesh) => mesh.count)).toEqual([400]);
    expect(cell.triangles).toBe(400 * kit.screen.frame.levels[0]!.triangles);
  });

  it('draw nothing where an instance is under a pixel, and come back without being made again', () => {
    const cell = new PartCell('0,0', fileParts('0,0', [['0,0', arrays(frames([windows, posts], 10, 10))]], partBandings(kit.screen)), kit);
    cell.choose(view(10, 5010, 5));
    expect(drawn(cell)).toHaveLength(0);
    // The runs alone: each band's caster stands in the group from the start (`PartCell.castInto`).
    const runs = (): number => cell.group.children.filter((o) => o.userData['shadowOnly'] !== true).length;
    const made = runs();
    cell.choose(view(10, 110, 5));
    cell.choose(view(10, 5010, 5));
    cell.choose(view(10, 110, 5));
    expect(drawn(cell)).toHaveLength(2);
    expect(runs()).toBe(Math.max(made, 2));
  });

  it('cast a frame\'s shadow only where its bars span a shadow texel, by a caster of its own, never by the runs the camera chose', () => {
    // The band's caster: drawn into the cascades alone (hidden between the passes), every instance of the band.
    const casters = (c: PartCell): Mesh[] => c.group.children.filter((o) => o.userData['shadowOnly'] === true) as Mesh[];
    const cell = new PartCell('0,0', fileParts('0,0', [['0,0', arrays(frames([windows], 10, 10))]], partBandings(kit.screen)), kit);
    cell.choose(view(10, 30, 5, 0.05));
    expect(drawn(cell).some((mesh) => mesh.castShadow)).toBe(false);
    // Every instance the runs draw at this view, all of the band's: the caster holds them all.
    const all = drawn(cell).reduce((n, mesh) => n + mesh.count, 0);
    cell.castInto(0.05);
    expect(casters(cell)).toHaveLength(1);
    expect(casters(cell).map((mesh) => [mesh.castShadow, mesh.visible, (mesh as InstancedMesh).count])).toEqual([[true, true, all]]);
    cell.castInto(0.2);
    expect(casters(cell).some((mesh) => mesh.castShadow || mesh.visible)).toBe(false);
    // Between the passes: hidden from the colour pass, as the casters' signature reads it.
    cell.castInto(null);
    expect(casters(cell).every((mesh) => !mesh.visible && mesh.castShadow)).toBe(true);
    // A post is the frame's model 30 cm tall and 50 cm deep: its sides' shadow spans the texel.
    const post = new PartCell('0,0', fileParts('0,0', [['0,0', arrays(frames([posts], 10, 10))]], partBandings(kit.screen)), kit);
    post.choose(view(10, 30, 5, 0.2));
    post.castInto(0.2);
    expect(casters(post).every((mesh) => mesh.castShadow && mesh.visible)).toBe(true);
  });

  it('choose by sub-cell: the near sub-cell whole, the far one by its street faces', () => {
    // Two sub-cells 100 m apart in the same cell, the eye over the first: enough frames for a split to spare more than its draws (the far frames' bars still half a pixel: drawn by their street faces).
    const many = [600, 1.2, 1.5, 0.06] as const;
    const near = frames([many], 10, 10), far = frames([many], 10, 110);
    const cell = new PartCell('0,0', fileParts('0,0', [['0,0', arrays(near)], ['0,1', arrays(far)]], partBandings(kit.screen)), kit);
    cell.choose(view(10, 10, 20));
    const levels = kit.screen.frame.levels;
    const shown = drawn(cell).map((mesh) => levelOf(levels, mesh)).sort();
    expect(shown).toEqual([0, 1]);
  });

  it('draw two runs at one level as one where the sub-cell between draws nothing and costs less than a draw', () => {
    // Posts in the first and third sub-cells (Morton order), equally far from the eye; between them a few frames under a pixel.
    const posts = [10, 0.06, 0.3, 0.5] as const, specks = [3, 0.001, 0.001, 0.001] as const;
    const cell = new PartCell('0,0', fileParts('0,0', [
      ['0,0', arrays(frames([posts], 10, 10))], ['1,0', arrays(frames([specks], 74, 10))], ['0,1', arrays(frames([posts], 10, 74))],
    ], partBandings(kit.screen)), kit);
    cell.choose(view(10, 42, 5));
    const shown = drawn(cell);
    expect(shown.map((mesh) => mesh.count)).toEqual([23]);
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
    it(`draw every instance of each kind that spans a pixel, none twice, and leave out those under one (${far ? 'facade level' : 'detail'})`, () => {
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
      let seen = 0, left = 0;
      for (const [key, subs] of byCell) {
        const details = [...subs].map(([sub, chunks]) => [sub, cellArrays(chunks, { parts: detailParts, shells: false, furniture: false, ghost: false, dim: false }, boxes)] as const);
        const cell = new PartCell(key, fileParts(key, details, partBandings(kit.screen)), kit);
        const comma = key.indexOf(',');
        const cx = (Number(key.slice(0, comma)) + 0.5) * BATCH_CELL, cy = (Number(key.slice(comma + 1)) + 0.5) * BATCH_CELL;
        // Over the cell, beside it with shadows, far off, and from above at a tiny scale where every lot part is under a pixel.
        const eyes: PartView[] = [view(cx, cy, 2), view(cx + 300, cy, 50, 0.1), view(cx + 3000, cy + 3000, 400, 2), { ...view(cx, cy, 500), orthoPx: 0.02 }];
        for (const eye of eyes) {
          cell.choose(eye);
          cell.castInto(eye.shadowTexel);
          for (const kind of SHELL_PART_KINDS) {
            const sources = details.flatMap(([, a]) => { const p = a.parts[kind]; return p ? [p] : []; });
            const meshes = drawn(cell).filter((mesh) => mesh.name === `building-${kind}`);
            const got = places(meshes.map((mesh) => {
              const attribute = mesh.geometry.getAttribute('instancePoseA') as InterleavedBufferAttribute;
              return { array: attribute.data.array, stride: attribute.data.stride, offset: attribute.offset, count: mesh.count };
            }));
            // None drawn twice, none but the sub-cells sent.
            expect(new Set(got).size, `${key} ${kind}`).toBe(got.length);
            const all = places(sources.map((p) => ({ array: p.poses, stride: POSE_FLOATS, offset: 0, count: p.count })));
            const known = new Set(all);
            for (const place of got) expect(known.has(place), `${key} ${kind}`).toBe(true);
            // Every instance a pixel or more across its diagonal where it stands is drawn (`levelAt`).
            const extent = kit.screen[kind].extent, drawnAt = new Set(got);
            for (const p of sources) {
              for (let i = 0; i < p.count; i++) {
                const o = i * POSE_FLOATS, e = p.poses;
                const across = Math.hypot(extent[0] * e[o + 5]!, extent[1] * e[o + 6]!, extent[2] * e[o + 7]!);
                const perMetre = eye.orthoPx ?? eye.pxAtMetre / Math.max(Math.hypot(e[o]! - eye.x, -e[o + 2]! - eye.y, e[o + 1]! - eye.z), 1);
                const at = [0, 1, 2].map((k) => e[o + k]!.toFixed(4)).join(' ');
                if (across * perMetre >= 1) expect(drawnAt.has(at), `${key} ${kind} ${at}`).toBe(true);
                else if (!drawnAt.has(at)) left++;
                seen++;
              }
            }
          }
          // Into no cascade whose texel is wider than its widest piece.
          cell.castInto(1e6);
          for (const mesh of drawn(cell)) if ((SHELL_PART_KINDS as readonly string[]).includes(mesh.name.slice('building-'.length))) expect(mesh.castShadow).toBe(false);
        }
        cell.dispose();
      }
      expect(seen).toBeGreaterThan(0);
      // Some left out: those under a pixel.
      expect(left).toBeGreaterThan(0);
    });
  }
});

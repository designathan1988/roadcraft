import { type BufferGeometry, Group, InstancedBufferAttribute, InstancedInterleavedBuffer, InstancedMesh, type Material } from 'three';

import { COLOURED_PARTS } from './cellArrays';
import { partLook } from './fade';
import { PART_KINDS, type BuildingKit, type PartKind } from './kit';
import type { PartCell } from './partCells';
import type { PartFiling } from './partFiling';
import { POSE_FLOATS, letGoPosed, partPoseDepth, posedCopy } from './partPose';
import { SHELL_PARTS } from './shellParts';

/** THE FACADE LEVEL'S DETAIL PARTS, ONE DRAW A KIND FOR THE WHOLE TOWN */
// A cell at its facade level (L1, `emitChunk` far) drew every part kind from its own filing: one draw a kind a cell, and twenty
// a cell over the view (the player's lab, 2026-10-20: 257 draws and 5.7 ms of the scene at a small city). The kinds the facade
// shader does not draw (frames, sills, fins, railings, awnings, props) are collected here instead: one InstancedMesh a kind over
// every facade cell, drawn at the kind's coarsest level (the level that far view is made for), its instances added and taken out
// as cells come and go. The shell's own parts (lot boxes, rails, slabs) stay per cell: their coarse level is a top face, and a
// yard's wall at a facade cell is still tens of pixels tall.

/** A cell's instances of one kind in the batch: a contiguous run of the kind's buffers. */
interface Run {
  readonly cell: string;
  start: number;
  count: number;
}

/** One kind over every facade cell: its master buffers, its mesh, and each cell's run. */
interface KindBatch {
  readonly kind: PartKind;
  readonly model: BufferGeometry;
  readonly material: Material;
  readonly mesh: InstancedMesh;
  poses: InstancedInterleavedBuffer;
  colours: InstancedBufferAttribute | null;
  capacity: number;
  used: number;
  readonly runs: Run[];
  /** Its coarsest level's triangles an instance, for the view's budget. */
  readonly triangles: number;
}

export class FarPartBatch {
  readonly group = new Group();
  private readonly kinds = new Map<PartKind, KindBatch>();
  private readonly cells = new Set<string>();
  private readonly drawn = new Map<string, number>();
  private faded = false;
  private casting = true;

  constructor(private readonly kit: BuildingKit) {
    this.group.name = 'building-far-parts';
    this.group.matrixAutoUpdate = false;
    this.group.updateMatrix();
    for (const kind of PART_KINDS) {
      if (SHELL_PARTS.has(kind)) continue;
      const level = kit.screen[kind].levels.at(-1)!;
      const capacity = 256;
      const poseBuffer = new InstancedInterleavedBuffer(new Float32Array(capacity * POSE_FLOATS), POSE_FLOATS);
      const material = partLook(kit, kind, false).material;
      const geometry = posedCopy(level.geometry, poseBuffer, 0);
      const mesh = new InstancedMesh(geometry, material, 0);
      mesh.name = `building-${kind}`;
      mesh.castShadow = kit.castsShadow.has(kind);
      mesh.receiveShadow = true;
      mesh.customDepthMaterial = partPoseDepth(material);
      // One draw a kind over the whole town: it is not culled by a piece's bounds (the pieces stand everywhere).
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.count = 0;
      mesh.visible = false;
      if (COLOURED_PARTS.has(kind)) {
        mesh.instanceColor = new InstancedBufferAttribute(new Uint16Array(capacity * 3), 3);
        (mesh.instanceColor as unknown as { isFloat16BufferAttribute: boolean }).isFloat16BufferAttribute = true;
      }
      this.group.add(mesh);
      this.kinds.set(kind, {
        kind, model: level.geometry, material, mesh, poses: poseBuffer,
        colours: mesh.instanceColor, capacity, used: 0, runs: [], triangles: level.triangles,
      });
    }
  }

  /** The cells of `cells` the view draws at their facade level (`shown`) are in the batch: those that came are copied in, those gone taken out. */
  sync(cells: ReadonlyMap<string, PartCell>, shown: (key: string) => boolean): void {
    for (const key of this.cells) if (!cells.has(key) || !shown(key)) this.remove(key);
    for (const [key, cell] of cells) if (!this.cells.has(key) && shown(key)) this.add(key, cell.filing);
  }

  /** Every instance let go (a lost context's cells asked again): the buffers kept, nothing drawn until cells land. */
  clear(): void {
    for (const batch of this.kinds.values()) {
      batch.used = 0;
      batch.runs.length = 0;
      batch.mesh.count = 0;
      batch.mesh.visible = false;
    }
    this.cells.clear();
    this.drawn.clear();
  }

  /** Its instances drawn at the coarsest level the far view was made for. */
  setFaded(faded: boolean): void {
    if (faded === this.faded) return;
    this.faded = faded;
    for (const batch of this.kinds.values()) {
      const look = partLook(this.kit, batch.kind, faded);
      batch.mesh.material = look.material;
      batch.mesh.customDepthMaterial = partPoseDepth(look.material);
      batch.mesh.renderOrder = look.renderOrder;
      batch.mesh.visible = batch.used > 0 && look.visible;
    }
  }

  /** The far cascades take the buildings by their masses alone: the batch casts nothing (`layer.ts` `castInto`). */
  castShadow(cast: boolean): void {
    if (cast === this.casting) return;
    this.casting = cast;
    this.group.visible = cast;
  }

  /** The triangles the batch draws of a cell, for the view's budget. */
  trianglesOf(cell: string): number {
    return this.drawn.get(cell) ?? 0;
  }

  dispose(): void {
    for (const batch of this.kinds.values()) {
      letGoPosed(batch.mesh.geometry, batch.model);
      batch.mesh.geometry.dispose();
      batch.mesh.dispose();
    }
    this.group.clear();
    this.cells.clear();
    this.drawn.clear();
  }

  /** A cell drawn at its facade level: its instances of every batched kind, each at the kind's coarsest level. */
  private add(cell: string, filing: PartFiling): void {
    this.cells.add(cell);
    let triangles = 0;
    for (const band of filing.bands) {
      const batch = this.kinds.get(band.kind);
      if (!batch) continue;
      const count = band.start[band.start.length - 1]!;
      if (!count) continue;
      const start = batch.used;
      this.grow(batch, start + count);
      (batch.poses.array as Float32Array).set(band.poses, start * POSE_FLOATS);
      if (batch.colours && band.colours) (batch.colours.array as Uint16Array).set(band.colours, start * 3);
      batch.runs.push({ cell, start, count });
      batch.used += count;
      batch.mesh.count = batch.used;
      batch.mesh.visible = true;
      dirty(batch, start, count);
      triangles += count * batch.triangles;
    }
    this.drawn.set(cell, triangles);
    this.group.visible = this.casting;
  }

  /** A cell gone from the facade level: its runs taken out and the runs after each moved down (the buffers kept compact). */
  private remove(cell: string): void {
    if (!this.cells.delete(cell)) return;
    this.drawn.delete(cell);
    for (const batch of this.kinds.values()) {
      for (let i = batch.runs.length - 1; i >= 0; i--) {
        const run = batch.runs[i]!;
        if (run.cell !== cell) continue;
        const end = run.start + run.count;
        const tail = batch.used - end;
        if (tail > 0) {
          (batch.poses.array as Float32Array).copyWithin(run.start * POSE_FLOATS, end * POSE_FLOATS, batch.used * POSE_FLOATS);
          if (batch.colours) (batch.colours.array as Uint16Array).copyWithin(run.start * 3, end * 3, batch.used * 3);
          for (const other of batch.runs) if (other !== run && other.start >= end) other.start -= run.count;
        }
        batch.runs.splice(i, 1);
        batch.used -= run.count;
        batch.mesh.count = batch.used;
        batch.mesh.visible = batch.used > 0;
        dirty(batch, run.start, Math.max(0, batch.used - run.start));
        if (tail < 0) break;
      }
    }
  }

  /** Room for `need` instances: the buffers made again, what is drawn kept. */
  private grow(batch: KindBatch, need: number): void {
    if (need <= batch.capacity) return;
    let capacity = batch.capacity;
    while (capacity < need) capacity *= 2;
    const poses = new Float32Array(capacity * POSE_FLOATS);
    poses.set(batch.poses.array as Float32Array);
    const poseBuffer = new InstancedInterleavedBuffer(poses, POSE_FLOATS);
    letGoPosed(batch.mesh.geometry, batch.model);
    batch.mesh.geometry.dispose();
    batch.mesh.geometry = posedCopy(batch.model, poseBuffer, 0);
    batch.poses = poseBuffer;
    if (batch.colours) {
      const colours = new Uint16Array(capacity * 3);
      colours.set(batch.colours.array as Uint16Array);
      batch.mesh.instanceColor = new InstancedBufferAttribute(colours, 3);
      (batch.mesh.instanceColor as unknown as { isFloat16BufferAttribute: boolean }).isFloat16BufferAttribute = true;
      batch.colours = batch.mesh.instanceColor;
    }
    batch.capacity = capacity;
  }
}

/** The run's poses and colours sent to the GPU, its range only. */
function dirty(batch: KindBatch, start: number, count: number): void {
  if (count <= 0) return;
  const poses = batch.poses;
  poses.clearUpdateRanges();
  poses.addUpdateRange(start * POSE_FLOATS, count * POSE_FLOATS);
  poses.needsUpdate = true;
  if (batch.colours) {
    batch.colours.clearUpdateRanges();
    batch.colours.addUpdateRange(start * 3, count * 3);
    batch.colours.needsUpdate = true;
  }
}

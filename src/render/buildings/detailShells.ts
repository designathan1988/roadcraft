import { type BufferGeometry, Group, InstancedBufferAttribute, InstancedInterleavedBuffer, InstancedMesh, InterleavedBufferAttribute } from 'three';

import { COLOURED_PARTS, FINISH_ATTRIBUTE } from './cellArrays';
import { partLook } from './fade';
import { type BuildingKit, type PartKind } from './kit';
import type { PartCell } from './partCells';
import { POSE_FLOATS, letGoPosed, partPoseDepth, posedCopy } from './partPose';
import { GROUND_ATTRIBUTE, LOOK_FLOATS, SHELL_PART_KINDS, SHELL_PARTS } from './shellParts';

/** A CELL LEVEL'S LOT WALLS AS ONE BATCH: the shells of a lot its rail and its slab, drawn by the cell's own parts a run a kind
 *  (thirty-nine draws of `building-lotBox` in the street's frame, 2026-10-20), one InstancedMesh a kind over the whole town.
 *  The finest level only: the cells drawn in detail stand at the eye, where those runs were the finest already. */

interface Run {
  readonly cell: string;
  start: number;
  readonly count: number;
}

interface KindBatch {
  readonly kind: PartKind;
  readonly mesh: InstancedMesh;
  poses: InstancedInterleavedBuffer;
  looks: InstancedInterleavedBuffer;
  posesArray: Float32Array;
  looksArray: Float32Array;
  colours: InstancedBufferAttribute | null;
  capacity: number;
  used: number;
  readonly runs: Run[];
  readonly triangles: number;
}

export class DetailShellBatch {
  readonly group = new Group();
  private readonly kinds = new Map<PartKind, KindBatch>();
  private readonly cells = new Set<string>();
  private readonly drawn = new Map<string, number>();
  private faded = false;

  constructor(private readonly kit: BuildingKit) {
    this.group.name = 'building-detail-shells';
    this.group.matrixAutoUpdate = false;
    this.group.updateMatrix();
    for (const kind of SHELL_PART_KINDS) {
      const level = kit.screen[kind].levels[0]!;
      const capacity = 128;
      const posesArray = new Float32Array(capacity * POSE_FLOATS);
      const looksArray = new Float32Array(capacity * LOOK_FLOATS);
      const poses = new InstancedInterleavedBuffer(posesArray, POSE_FLOATS);
      const looks = new InstancedInterleavedBuffer(looksArray, LOOK_FLOATS);
      const material = partLook(kit, kind, false).material;
      const geometry = this.posed(level.geometry, poses, looks);
      const mesh = new InstancedMesh(geometry, material, 0);
      mesh.name = `building-lot-${kind}`;
      mesh.castShadow = kit.castsShadow.has(kind);
      mesh.receiveShadow = true;
      mesh.customDepthMaterial = partPoseDepth(material);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.count = 0;
      mesh.visible = false;
      let colours: InstancedBufferAttribute | null = null;
      if (COLOURED_PARTS.has(kind)) {
        colours = new InstancedBufferAttribute(new Uint16Array(capacity * 3), 3);
        (colours as unknown as { isFloat16BufferAttribute: boolean }).isFloat16BufferAttribute = true;
        mesh.instanceColor = colours;
      }
      this.group.add(mesh);
      this.kinds.set(kind, { kind, mesh, poses, looks, posesArray, looksArray, colours, capacity, used: 0, runs: [], triangles: level.triangles });
    }
  }

  /** The kit's model with the batch's poses and looks bound at instance 0. */
  private posed(model: BufferGeometry, poses: InstancedInterleavedBuffer, looks: InstancedInterleavedBuffer): BufferGeometry {
    const geometry = posedCopy(model, poses, 0);
    geometry.setAttribute(FINISH_ATTRIBUTE, new InterleavedBufferAttribute(looks, 1, 0));
    geometry.setAttribute('aDecay', new InterleavedBufferAttribute(looks, 1, 1));
    geometry.setAttribute(GROUND_ATTRIBUTE, new InterleavedBufferAttribute(looks, 1, 2));
    return geometry;
  }

  /** The detail cells the view shows (`shown`): those that came are copied in, those gone taken out. */
  sync(cells: ReadonlyMap<string, PartCell>, shown: (key: string) => boolean): void {
    for (const key of this.cells) if (!cells.has(key) || !shown(key)) this.remove(key);
    for (const [key, cell] of cells) if (!this.cells.has(key) && shown(key)) this.add(key, cell);
  }

  /** A cell's lot walls of every kind appended; its triangles kept for the view's budget. */
  private add(cell: string, part: PartCell): void {
    this.cells.add(cell);
    let triangles = 0;
    for (const band of part.filing.bands) {
      if (!SHELL_PARTS.has(band.kind)) continue;
      const batch = this.kinds.get(band.kind);
      if (!batch) continue;
      const count = band.start[band.start.length - 1]!;
      if (!count) continue;
      this.grow(batch, batch.used + count);
      batch.posesArray.set(band.poses, batch.used * POSE_FLOATS);
      if (band.looks) batch.looksArray.set(band.looks, batch.used * LOOK_FLOATS);
      if (batch.colours && band.colours) (batch.colours.array as Uint16Array).set(band.colours, batch.used * 3);
      batch.runs.push({ cell, start: batch.used, count });
      batch.used += count;
      batch.mesh.count = batch.used;
      batch.mesh.visible = true;
      dirty(batch, batch.runs[batch.runs.length - 1]!.start, count);
      triangles += count * batch.triangles;
    }
    this.drawn.set(cell, triangles);
  }

  /** A cell gone: its runs compacted away. */
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
          batch.posesArray.copyWithin(run.start * POSE_FLOATS, end * POSE_FLOATS, batch.used * POSE_FLOATS);
          batch.looksArray.copyWithin(run.start * LOOK_FLOATS, end * LOOK_FLOATS, batch.used * LOOK_FLOATS);
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
    batch.posesArray = new Float32Array(capacity * POSE_FLOATS);
    batch.posesArray.set(batch.poses.array as Float32Array);
    batch.poses = new InstancedInterleavedBuffer(batch.posesArray, POSE_FLOATS);
    batch.looksArray = new Float32Array(capacity * LOOK_FLOATS);
    batch.looksArray.set(batch.looks.array as Float32Array);
    batch.looks = new InstancedInterleavedBuffer(batch.looksArray, LOOK_FLOATS);
    // Three frees an InstancedMesh's instance buffers only on its dispose (r186 `WebGLObjects` onInstancedMeshDispose): let the old colour buffer go before it is replaced, or its GPU buffer is never freed.
    batch.mesh.dispose();
    letGoPosed(batch.mesh.geometry, this.kit.screen[batch.kind].levels[0]!.geometry);
    batch.mesh.geometry.dispose();
    batch.mesh.geometry = this.posed(this.kit.screen[batch.kind].levels[0]!.geometry, batch.poses, batch.looks);
    if (batch.colours) {
      const colours = new Uint16Array(capacity * 3);
      colours.set(batch.colours.array as Uint16Array);
      batch.colours = new InstancedBufferAttribute(colours, 3);
      (batch.colours as unknown as { isFloat16BufferAttribute: boolean }).isFloat16BufferAttribute = true;
      batch.mesh.instanceColor = batch.colours;
    }
    batch.capacity = capacity;
  }

  /** The triangles the batch draws of a cell, for the view's budget. */
  trianglesOf(cell: string): number {
    return this.drawn.get(cell) ?? 0;
  }

  /** The cell's levels shown faded (`layer.ts` `setFaded`). */
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

  /** Every run let go (a lost context's cells asked again): the buffers kept, nothing drawn until cells land. */
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

  dispose(): void {
    for (const batch of this.kinds.values()) {
      letGoPosed(batch.mesh.geometry, this.kit.screen[batch.kind].levels[0]!.geometry);
      batch.mesh.geometry.dispose();
      batch.mesh.dispose();
    }
    this.group.clear();
    this.cells.clear();
    this.drawn.clear();
  }
}

/** A run's poses and looks sent to the GPU, its range only. DO NOT clear the ranges a change already added: every cell added or taken out this frame adds its own, and three merges and clears them once, after the upload (r186 `WebGLAttributes.updateBuffer`). */
function dirty(batch: KindBatch, start: number, count: number): void {
  if (count <= 0) return;
  batch.poses.addUpdateRange(start * POSE_FLOATS, count * POSE_FLOATS);
  batch.poses.needsUpdate = true;
  batch.looks.addUpdateRange(start * LOOK_FLOATS, count * LOOK_FLOATS);
  batch.looks.needsUpdate = true;
  if (batch.colours) {
    batch.colours.addUpdateRange(start * 3, count * 3);
    batch.colours.needsUpdate = true;
  }
}

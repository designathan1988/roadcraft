import { Box3, BufferAttribute, BufferGeometry, type Camera, Group, type InterleavedBufferAttribute, type Material, Matrix4, type Mesh } from 'three';

import { SHELL_MESH } from './cellArrays';
import type { BuildingKit } from './kit';
import type { BuildingMeshes } from './buildingMesh';
import { GpuBatchedMesh } from './gpuBatchedMesh';

/** THE CELLS' WALLS, ONE MULTI-DRAW A MATERIAL */
// Every cell landed its shells as meshes of its own: a cell at its facade level drew a piece a group of buildings (`cellArrays.ts`
// shellPieces), and the view counted dozens of draws of the same two materials (the player's lab, 2026-10-20: 52 draws of
// `building-shell` at a small city). Three's BatchedMesh draws many geometries with one material in one multi-draw call (three.js
// BatchedMesh: "reduce the number of draw calls"); its instances take identity matrices, the pieces' vertices already in the
// world, and a piece is hidden as its cell is.

/** The three attribute sets a cell's shells come in: the detail level's plain walls, the facade level's plain ones, and its runs
 *  of bays with openings (their own window grid attributes). One batch each, one draw each. */
type ShellSet = 'detail' | 'facade' | 'runs';

const IDENTITY = new Matrix4();

/** A batch whose drawn pieces changed (one added, taken out, shown or hidden): its `castVersion` stepped, read by the shadows' signature of their still casters (`renderer.ts` casterChanges), and the world box of the pieces changed joined into its `castBox`, so the sun's stores are drawn again under that box alone (`sunCascades.ts` patches), not the whole town. DO NOT leave it to a timed redraw: a batch's pieces shown or hidden change none of its attributes, and only the cascades' safety redraw caught them (a whole cascade every ten frames, the frames that missed their vsync). */
function castChanged(mesh: GpuBatchedMesh, box: Box3): void {
  mesh.userData['castVersion'] = ((mesh.userData['castVersion'] as number | undefined) ?? 0) + 1;
  const kept = mesh.userData['castBox'] as Box3 | undefined;
  if (kept) kept.union(box); else mesh.userData['castBox'] = box.clone();
}

interface Batch {
  readonly set: ShellSet;
  mesh: GpuBatchedMesh;
  vertices: number;
  indices: number;
  instances: number;
}

export class ShellBatch {
  /** The batches' meshes live under these, in the layer's roots (the effect switches hide a root whole). */
  readonly detailGroup = new Group();
  readonly facadeGroup = new Group();
  private batches: Batch[];
  private readonly cells = new Map<string, { batch: Batch; id: number; geometryId: number }[]>();
  private readonly visible = new Map<string, boolean>();
  /** Each cell's shells' box in the world (their vertices are world vertices): what the occlusion tests (`hideOccluded`). */
  private readonly boxes = new Map<string, Box3>();
  private faded = false;
  private casting = true;

  constructor(private readonly kit: BuildingKit) {
    this.detailGroup.name = 'building-shells-batched';
    this.facadeGroup.name = 'building-facades-batched';
    for (const group of [this.detailGroup, this.facadeGroup]) {
      group.matrixAutoUpdate = false;
      group.updateMatrix();
    }
    this.batches = this.makeBatches();
  }

  /** A cell's shells (every mesh of `SHELL_MESH` in its batch) taken into the batches; the meshes let go. */
  add(kind: 'cell' | 'facade', key: string, batch: BuildingMeshes): void {
    const id = `${kind}|${key}`;
    const made: { batch: Batch; id: number; geometryId: number }[] = [];
    const box = new Box3();
    for (const child of [...batch.group.children]) {
      const mesh = child as Mesh;
      if (!mesh.isMesh || mesh.name !== SHELL_MESH) continue;
      // Its arrays may have been let go once on the GPU (`gpuOnly`): the batch copies them, so they are made again first, and a piece whose source is gone (a context lost meanwhile) is left out rather than crashing the draw.
      (mesh.userData['refillArrays'] as (() => void) | undefined)?.();
      const source = mesh.geometry;
      const arraysGone = Object.values(source.attributes).some((attribute) => {
        const array = (attribute as BufferAttribute).array ?? (attribute as InterleavedBufferAttribute).data?.array;
        return array === null || array === undefined;
      });
      if (arraysGone) {
        console.warn(`[buildings] a shell of ${kind} ${key} has no arrays to copy: left out`);
        continue;
      }
      const runs = source.hasAttribute('facadeCell');
      const set: ShellSet = kind === 'cell' ? 'detail' : runs ? 'runs' : 'facade';
      const target = this.batches.find((one) => one.set === set)!;
      const geometry = worldGeometry(mesh);
      const vertices = geometry.getAttribute('position').count;
      const indices = geometry.getIndex()?.count ?? vertices;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      box.union(geometry.boundingBox!);
      this.ensure(target, vertices, indices);
      const geometryId = target.mesh.addGeometry(geometry);
      const instanceId = target.mesh.addInstance(geometryId);
      target.mesh.setMatrixAt(instanceId, IDENTITY);
      target.mesh.setVisibleAt(instanceId, this.visible.get(id) ?? true);
      made.push({ batch: target, id: instanceId, geometryId });
      batch.group.remove(mesh);
      source.dispose();
      if (geometry !== source) geometry.dispose();
    }
    if (made.length) {
      this.cells.set(id, made);
      this.boxes.set(id, box);
      for (const target of new Set(made.map((entry) => entry.batch))) castChanged(target.mesh, box);
    }
  }

  /** A cell's shells taken out: its geometries (and their instances) deleted from their batch. */
  remove(kind: 'cell' | 'facade', key: string): void {
    const id = `${kind}|${key}`;
    const made = this.cells.get(id);
    if (!made) return;
    const box = this.boxes.get(id) ?? new Box3();
    this.cells.delete(id);
    this.visible.delete(id);
    this.boxes.delete(id);
    for (const entry of made) { entry.batch.mesh.deleteGeometry(entry.geometryId); castChanged(entry.batch.mesh, box); }
    for (const batch of new Set(made.map((entry) => entry.batch))) this.squeeze(batch);
  }

  /** A batch with more room than it uses made smaller (cells let go leave their ranges reserved for no one, `GpuBatchedMesh.usedCounts`): its live geometries packed into storage of what stands, a quarter more. */
  private squeeze(batch: Batch): void {
    const mesh = batch.mesh;
    const used = mesh.usedCounts();
    if (batch.vertices - used.vertices > Math.max(1 << 15, used.vertices) || batch.indices - used.indices > Math.max(1 << 15, used.indices)) {
      batch.vertices = Math.max(Math.ceil(used.vertices * 1.25), 1 << 14);
      batch.indices = Math.max(Math.ceil(used.indices * 1.25), 1 << 15);
      mesh.compact(batch.vertices, batch.indices);
    }
    // DO NOT shrink the instance count: three's BatchedMesh throws when an id past the new count is still in use, and deleting a cell's geometries leaves holes past `instanceCount` (the active count) until its own trailing holes are popped. The batch keeps its capacity; the instances of a cell let go are deleted above.
  }

  /** A cell's level shown or hidden (a cell still on another level is not drawn, and its pieces cost nothing). */
  setVisible(kind: 'cell' | 'facade', key: string, visible: boolean): void {
    const id = `${kind}|${key}`;
    if (this.visible.get(id) === visible) return;
    this.visible.set(id, visible);
    const box = this.boxes.get(id) ?? new Box3();
    for (const entry of this.cells.get(id) ?? []) { entry.batch.mesh.setVisibleAt(entry.id, visible); castChanged(entry.batch.mesh, box); }
  }

  /** The colour pass about to be drawn from `camera`: the shells of every cell shown whose box `hidden` says is behind the walls laid
   *  (`render/occlusion.ts`) left out of its draws alone, the shadows' draws untouched (`GpuBatchedMesh.colourHidden`); how many cells. */
  hideOccluded(camera: Camera, hidden: (box: Box3) => boolean): number {
    for (const batch of this.batches) batch.mesh.colourHidden = { camera, ids: [] };
    let n = 0;
    for (const [id, made] of this.cells) {
      if (this.visible.get(id) === false) continue;
      const box = this.boxes.get(id);
      if (!box || !hidden(box)) continue;
      n++;
      for (const entry of made) entry.batch.mesh.colourHidden!.ids.push(entry.id);
    }
    return n;
  }

  /** The colour pass drawn: every shell drawn again from any camera. */
  restoreOccluded(): void {
    for (const batch of this.batches) batch.mesh.colourHidden = null;
  }

  /** The far cascades take the buildings by their masses alone: the walls cast nothing into them. */
  castShadow(cast: boolean): void {
    if (cast === this.casting) return;
    this.casting = cast;
    for (const batch of this.batches) batch.mesh.castShadow = cast;
  }

  setFaded(faded: boolean): void {
    if (faded === this.faded) return;
    this.faded = faded;
    const material = faded ? this.kit.dimShell : this.kit.shellMaterial;
    const facadeMaterial = faded ? this.kit.dimShell : this.kit.facade;
    for (const batch of this.batches) {
      batch.mesh.material = batch.set === 'detail' ? material : facadeMaterial;
      // Faded (transparent) shells drawn back to front; opaque ones unsorted (`makeBatches`).
      batch.mesh.sortObjects = faded;
    }
  }

  /** Every instance let go (a lost context's cells asked again): the batches made again, their meshes put back in the groups. */
  reset(): void {
    for (const batch of this.batches) batch.mesh.dispose();
    this.detailGroup.clear();
    this.facadeGroup.clear();
    this.cells.clear();
    this.visible.clear();
    this.boxes.clear();
    this.batches = this.makeBatches();
    this.casting = true;
    if (this.faded) this.setFaded(true);
  }

  dispose(): void {
    for (const batch of this.batches) batch.mesh.dispose();
    this.detailGroup.clear();
    this.facadeGroup.clear();
    this.cells.clear();
    this.visible.clear();
    this.boxes.clear();
  }

  private makeBatches(): Batch[] {
    const make = (set: ShellSet, group: Group, material: Material): Batch => {
      // Small at first: a set the view never fills (the detail level from afar) held 65k vertices of nothing before (measured 2026-10-20).
      // Its buffers on the GPU only (`gpuBatchedMesh.ts`): DO NOT go back to three's BatchedMesh, whose arrays of the batch's whole size held a large city's walls a second time on the page (333 MB).
      const mesh = new GpuBatchedMesh(64, 1 << 14, 1 << 15, material);
      mesh.name = `building-shell-batch-${set}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.frustumCulled = false;
      // DO NOT sort opaque walls by depth: three's BatchedMesh sorts every instance in every pass when `sortObjects` (the colour pass and each
      // of the 3 cascades, opaque too: BatchedMesh.js onBeforeRender), and depth testing gives opaque walls the same picture unsorted. A
      // transparent set (the faded shells) keeps its back-to-front order.
      mesh.sortObjects = material.transparent;
      group.add(mesh);
      return { set, mesh, vertices: 1 << 14, indices: 1 << 15, instances: 64 };
    };
    return [
      make('detail', this.detailGroup, this.kit.shellMaterial),
      make('facade', this.facadeGroup, this.kit.facade),
      make('runs', this.facadeGroup, this.kit.facade),
    ];
  }

  /** Room in a batch for a geometry and an instance: its live geometries packed into storage a quarter more than they and the new one hold (the drawn pieces kept, the holes of cells let go gone: `GpuBatchedMesh.compact`; doubling left up to half the reserved space empty, tens of MB of arrays, measured 2026-10-20). */
  private ensure(batch: Batch, vertices: number, indices: number): void {
    const mesh = batch.mesh;
    if (vertices > mesh.unusedVertexCount || indices > mesh.unusedIndexCount) {
      const used = mesh.usedCounts();
      const storedVertices = batch.vertices - mesh.unusedVertexCount, storedIndices = batch.indices - mesh.unusedIndexCount;
      // Packed only when the holes are worth it (a quarter of what lives): packing reads the indices back from the GPU, growing does not.
      const pack = storedVertices - used.vertices > used.vertices / 4 || storedIndices - used.indices > used.indices / 4;
      batch.vertices = Math.max(Math.ceil(((pack ? used.vertices : storedVertices) + vertices) * 1.25), 1 << 14);
      batch.indices = Math.max(Math.ceil(((pack ? used.indices : storedIndices) + indices) * 1.25), 1 << 15);
      if (pack) mesh.compact(batch.vertices, batch.indices);
      else mesh.setGeometrySize(batch.vertices, batch.indices);
    }
    if (mesh.instanceCount >= batch.instances) {
      batch.instances *= 2;
      mesh.setInstanceCount(batch.instances);
    }
  }
}

/** The mesh's shell as world vertices: the far level's positions come quantized on the cell's grid, the mesh's place putting them
 *  in the world (`buildingMesh.ts` `place`). The batch takes identity matrices, so they are written out here. */
function worldGeometry(mesh: Mesh): BufferGeometry {
  const source = mesh.geometry;
  const position = source.getAttribute('position') as BufferAttribute;
  if (position.itemSize !== 4 || !position.normalized) return source;
  const g = new BufferGeometry();
  const count = position.count;
  const out = new Float32Array(count * 3);
  const sx = mesh.scale.x, sy = mesh.scale.y, sz = mesh.scale.z;
  const ox = mesh.position.x, oy = mesh.position.y, oz = mesh.position.z;
  // `getX` denormalises a normalized attribute already (r186 `BufferAttribute.getX`): its value is the 0..1 of the cell's grid.
  for (let i = 0; i < count; i++) {
    out[i * 3] = ox + position.getX(i) * sx;
    out[i * 3 + 1] = oy + position.getY(i) * sy;
    out[i * 3 + 2] = oz + position.getZ(i) * sz;
  }
  g.setAttribute('position', new BufferAttribute(out, 3));
  for (const name of Object.keys(source.attributes)) if (name !== 'position') g.setAttribute(name, source.attributes[name]!);
  g.setIndex(source.getIndex());
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

import { Box3, type BufferAttribute, type BufferGeometry, Group, type Material, type Mesh, type Object3D } from 'three';
import { GpuBatchedMesh } from '../buildings/gpuBatchedMesh';

/** THE ROAD BLOCKS' FAR LEVELS DRAWN IN BATCHES, ONE A LOOK (material, order, shadows, attributes) */
// A block's far level (`surfaceTiles.ts` attachFarLevel) stays the mesh the residency shows, hides, lets go and makes again
// (`roadResidency.ts`); it is never drawn itself (its layers none) and its geometry is copied into its look's batch, its instance there
// shown as the mesh is. DO NOT draw each far block a mesh a material: the street view of a large city drew 11 far blocks of six
// materials, ~80 draw calls of the 600 (`npm run diagnose` byCalls, 2026-10-22), where one batch a material draws them all.

/** One far level adopted: where its geometry is in its batch, and the geometry stored there (another one on the mesh: stored again). */
interface Entry {
  readonly level: Mesh;
  readonly key: string;
  stored: BufferGeometry | null;
  geometryId: number;
  instanceId: number;
  shown: boolean;
}

interface Batch {
  readonly mesh: GpuBatchedMesh;
  vertices: number;
  indices: number;
  instances: number;
}

const ADOPTED = 'farBlockBatched';

/** Whether a far level is drawn by its batch (`FarBlockBatches.adopt`): nothing to upload or warm for it. */
export function batchedFar(level: Object3D): boolean {
  return level.userData[ADOPTED] === true;
}

/** The batch's storage left out of the memory counters (`memoryCounters.ts`): its bytes are counted on the far levels it holds, as
 *  `gpuOnly.ts` keeps them, which the road residency's budget reads (`roadResidency.ts`). */
function uncounted(mesh: GpuBatchedMesh): void {
  const g = mesh.geometry;
  for (const a of [...Object.values(g.attributes), g.getIndex()]) delete (a as unknown as { keptBytes?: number } | null)?.keptBytes;
}

/** A geometry's arrays let go once in its batch, their size kept as `gpuOnly.ts` keeps it (`memoryCounters.ts`, `gpuLedger.ts`). */
function letGoArrays(geometry: BufferGeometry): void {
  for (const a of [...Object.values(geometry.attributes), geometry.getIndex()]) {
    const own = a as unknown as { array: (ArrayLike<number> & { byteLength?: number }) | null; keptBytes?: number } | null;
    if (!own?.array) continue;
    if (own.array.byteLength !== undefined) own.keptBytes = own.array.byteLength;
    own.array = null;
  }
}

export class FarBlockBatches {
  readonly group = new Group();
  private readonly batches = new Map<string, Batch>();
  private readonly entries = new Map<Mesh, Entry>();

  constructor() {
    this.group.name = 'road-far-blocks';
    this.group.matrixAutoUpdate = false;
  }

  /** A block's far level drawn by its look's batch from now on: never drawn itself, its geometry copied there at the next `sync`. */
  adopt(level: Mesh): void {
    if (this.entries.has(level)) return;
    const material = level.material as Material;
    const g = level.geometry;
    const names = Object.keys(g.attributes).sort().join(',');
    const key = `${material.uuid}|${level.renderOrder}|${level.castShadow}|${level.receiveShadow}|${names}`;
    level.userData[ADOPTED] = true;
    level.layers.disableAll();
    this.entries.set(level, { level, key, stored: null, geometryId: -1, instanceId: -1, shown: false });
  }

  /** Each far level's instance shown as the level is (in the scene, its parents shown), its geometry stored again where the mesh has a new
   *  one (`restoreFarLevel`) and let go where the level's was disposed (`roadResidency.ts` dropCell, a block retired). Every frame. */
  sync(): void {
    const root = this.rootOf(this.group);
    for (const entry of this.entries.values()) {
      const level = entry.level;
      const g = level.geometry;
      if (entry.stored !== g && entry.stored !== null) this.release(entry);
      const shown = this.shownIn(level, root);
      if (entry.stored === null) {
        // Stored only once it is shown with arrays to copy: a level let go and not made again has none.
        if (!shown || !(g.getAttribute('position') as BufferAttribute | undefined)?.array) continue;
        this.store(entry);
      }
      if (shown !== entry.shown) {
        entry.shown = shown;
        this.batches.get(entry.key)?.mesh.setVisibleAt(entry.instanceId, shown);
      }
    }
  }

  /** The batches' buffers lost with the WebGL context: every level stored again from its arrays (`gpuOnly.ts` refillArrays gave them back). */
  refill(): void {
    for (const entry of this.entries.values()) { entry.stored = null; entry.geometryId = -1; entry.instanceId = -1; entry.shown = false; }
    for (const batch of this.batches.values()) { this.group.remove(batch.mesh); batch.mesh.dispose(); }
    this.batches.clear();
  }

  dispose(): void {
    this.refill();
    this.entries.clear();
  }

  private rootOf(object: Object3D): Object3D {
    let o = object;
    while (o.parent) o = o.parent;
    return o;
  }

  /** Whether the level would be drawn: shown, and every parent up to the scene the batches are in. */
  private shownIn(level: Object3D, root: Object3D): boolean {
    let o: Object3D | null = level;
    while (o) {
      if (!o.visible) return false;
      if (!o.parent) return o === root;
      o = o.parent;
    }
    return false;
  }

  private store(entry: Entry): void {
    const level = entry.level, g = level.geometry;
    const vertices = g.getAttribute('position').count, indices = g.getIndex()?.count ?? 0;
    const batch = this.batchFor(entry.key, level);
    this.ensure(batch, vertices, indices);
    entry.geometryId = batch.mesh.addGeometry(g);
    entry.instanceId = batch.mesh.addInstance(entry.geometryId);
    // The storage made with the first geometry counted on the levels as well.
    uncounted(batch.mesh);
    batch.mesh.setVisibleAt(entry.instanceId, false);
    entry.shown = false;
    entry.stored = g;
    // Its own copy let go: the batch's is the one on the GPU. Its bounds stay for the shadows' change boxes (`renderer.ts` casterChanges).
    letGoArrays(g);
    // Taken out of the batch with its geometry: let go by the residency or retired with its block.
    const gone = (): void => {
      g.removeEventListener('dispose', gone);
      if (entry.stored === g) this.release(entry);
      // A block retired (out of the scene, `roadSurfaces.ts` retire): forgotten. One let go by the residency stays, made again in place.
      if (this.rootOf(level) !== this.rootOf(this.group)) this.entries.delete(level);
    };
    g.addEventListener('dispose', gone);
  }

  private release(entry: Entry): void {
    const batch = this.batches.get(entry.key);
    if (batch && entry.instanceId >= 0) {
      batch.mesh.deleteInstance(entry.instanceId);
      batch.mesh.deleteGeometry(entry.geometryId);
    }
    entry.stored = null;
    entry.geometryId = -1;
    entry.instanceId = -1;
    entry.shown = false;
  }

  private batchFor(key: string, level: Mesh): Batch {
    let batch = this.batches.get(key);
    if (batch) return batch;
    const mesh = new GpuBatchedMesh(64, 1 << 14, 1 << 15, level.material as Material);
    mesh.name = 'road-far-blocks';
    mesh.renderOrder = level.renderOrder;
    mesh.castShadow = level.castShadow;
    mesh.receiveShadow = level.receiveShadow;
    mesh.matrixAutoUpdate = false;
    // Its instances culled one by one (three's `perObjectFrustumCulled`): the batch spans the city.
    mesh.frustumCulled = false;
    // Opaque, each surface pulled over the one under it (`pullTowardEye`): no order among its blocks to keep.
    mesh.sortObjects = false;
    // What changed in it told by its far levels, each with its own box (`renderer.ts` casterChanges): DO NOT give the batch's changes a box.
    mesh.userData['castBox'] = new Box3();
    batch = { mesh, vertices: 1 << 14, indices: 1 << 15, instances: 64 };
    this.batches.set(key, batch);
    this.group.add(mesh);
    return batch;
  }

  /** Room for a geometry and an instance, as the shell batches make it (`shellBatch.ts` ensure): packed when the holes are a quarter of what lives. */
  private ensure(batch: Batch, vertices: number, indices: number): void {
    const mesh = batch.mesh;
    if (vertices > mesh.unusedVertexCount || indices > mesh.unusedIndexCount) {
      const used = mesh.usedCounts();
      const storedVertices = batch.vertices - mesh.unusedVertexCount, storedIndices = batch.indices - mesh.unusedIndexCount;
      const pack = storedVertices - used.vertices > used.vertices / 4 || storedIndices - used.indices > used.indices / 4;
      batch.vertices = Math.max(Math.ceil(((pack ? used.vertices : storedVertices) + vertices) * 1.25), 1 << 14);
      batch.indices = Math.max(Math.ceil(((pack ? used.indices : storedIndices) + indices) * 1.25), 1 << 15);
      if (pack) mesh.compact(batch.vertices, batch.indices);
      else mesh.setGeometrySize(batch.vertices, batch.indices);
      uncounted(mesh);
    }
    if (mesh.instanceCount >= batch.instances) {
      batch.instances *= 2;
      mesh.setInstanceCount(batch.instances);
    }
  }
}

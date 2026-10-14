import { BatchedMesh, type BufferGeometry, Group, Matrix4 } from 'three';
import { FINISHES, type Finish } from '@world/buildings/materials';
import type { BuildingKit } from './kit';

/**
 * THE BUILDINGS' SHELLS IN ONE DRAW PER FINISH: a `BatchedMesh` per finish
 * (thirteen for the whole town), each cell of buildings one geometry and one
 * instance in it. A cell was a `Mesh` per finish - thirteen draws and
 * thirteen material binds per cell drawn - and the overview drew hundreds
 * of them; now the cells near are thirteen draws however many they are
 * (three's `WEBGL_multi_draw`; one draw per geometry where the extension is
 * missing). Each instance is culled on its own (`perObjectFrustumCulled`)
 * and shown or hidden with its cell (`setVisible`). The lots grow by
 * doubling (`setGeometrySize`, `setInstanceCount`) and are compacted
 * (`optimize`) before they grow, so a town's worth of cells coming and
 * going (`layer.ts` streaming) leaves no holes.
 * NÃO voltar a um Mesh por acabamento por célula.
 */
export interface ShellSlot {
  readonly finish: Finish;
  readonly geometryId: number;
  readonly instanceId: number;
}

export interface ShellBatches {
  readonly group: Group;
  /** The shell of one finish of one cell into its finish's lot, shown; its slot, to hide or remove it. */
  add(finish: Finish, geometry: BufferGeometry): ShellSlot;
  remove(slot: ShellSlot): void;
  setVisible(slot: ShellSlot, visible: boolean): void;
  dispose(): void;
}

interface Lot {
  readonly mesh: BatchedMesh;
  /** Vertices and indices reserved up to the end of the lot's buffers (holes included), as the lot lays them. */
  tailVertices: number;
  tailIndices: number;
  /** Vertices and indices of the live geometries. */
  liveVertices: number;
  liveIndices: number;
  live: number;
}

/** First room of a lot: vertices, indices (a cell of a few buildings), geometries. */
const FIRST_VERTICES = 1 << 16;
const FIRST_INDICES = 3 << 16;
const FIRST_INSTANCES = 32;

const IDENTITY = new Matrix4();

/** The next power of two at or above `n` (at least `floor`). */
const roomFor = (n: number, floor: number): number => {
  let size = floor;
  while (size < n) size *= 2;
  return size;
};

export function createShellBatches(kit: BuildingKit): ShellBatches {
  const group = new Group();
  group.name = 'building-shells';
  group.matrixAutoUpdate = false;
  group.updateMatrix();
  const lots = new Map<Finish, Lot>();
  const lotOf = (finish: Finish): Lot => {
    let lot = lots.get(finish);
    if (lot) return lot;
    const mesh = new BatchedMesh(FIRST_INSTANCES, FIRST_VERTICES, FIRST_INDICES, kit.shellBatched[finish]);
    mesh.name = `building-shells-${finish}`;
    // Every cell is culled on its own; the lot as a whole never (its sphere
    // would have to be worked out again at every cell coming or going).
    mesh.frustumCulled = false;
    mesh.perObjectFrustumCulled = true;
    mesh.sortObjects = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
    lot = { mesh, tailVertices: 0, tailIndices: 0, liveVertices: 0, liveIndices: 0, live: 0 };
    lots.set(finish, lot);
    return lot;
  };
  /** Room for `vertices` and `indices` more at the end of the lot: compacted, then grown as needed. */
  const makeRoom = (lot: Lot, vertices: number, indices: number): void => {
    const mesh = lot.mesh;
    const grown = (mesh as unknown as { _maxVertexCount: number; _maxIndexCount: number });
    let maxVertices = grown._maxVertexCount, maxIndices = grown._maxIndexCount;
    if (lot.tailVertices + vertices > maxVertices || lot.tailIndices + indices > maxIndices) {
      if (lot.tailVertices !== lot.liveVertices || lot.tailIndices !== lot.liveIndices) {
        mesh.optimize();
        lot.tailVertices = lot.liveVertices;
        lot.tailIndices = lot.liveIndices;
      }
      if (lot.tailVertices + vertices > maxVertices || lot.tailIndices + indices > maxIndices) {
        maxVertices = roomFor(lot.tailVertices + vertices, maxVertices);
        maxIndices = roomFor(lot.tailIndices + indices, maxIndices);
        mesh.setGeometrySize(maxVertices, maxIndices);
      }
    }
    if (lot.live >= mesh.maxInstanceCount) mesh.setInstanceCount(mesh.maxInstanceCount * 2);
  };
  return {
    group,
    add(finish, geometry) {
      const lot = lotOf(finish);
      const vertices = geometry.getAttribute('position').count;
      const indices = geometry.getIndex()?.count ?? 0;
      makeRoom(lot, vertices, indices);
      const geometryId = lot.mesh.addGeometry(geometry);
      const instanceId = lot.mesh.addInstance(geometryId);
      lot.mesh.setMatrixAt(instanceId, IDENTITY);
      lot.tailVertices += vertices;
      lot.tailIndices += indices;
      lot.liveVertices += vertices;
      lot.liveIndices += indices;
      lot.live++;
      // The lot's own box (the renderer reads the town's tallest point from it) is worked out again on demand.
      lot.mesh.boundingBox = null;
      lot.mesh.boundingSphere = null;
      return { finish, geometryId, instanceId };
    },
    remove(slot) {
      const lot = lots.get(slot.finish);
      if (!lot) return;
      const info = (lot.mesh as unknown as { _geometryInfo: { vertexCount: number; indexCount: number; active: boolean }[] })._geometryInfo[slot.geometryId];
      if (!info || !info.active) return;
      lot.liveVertices -= info.vertexCount;
      lot.liveIndices -= info.indexCount;
      lot.live--;
      lot.mesh.deleteGeometry(slot.geometryId);
      lot.mesh.boundingBox = null;
      lot.mesh.boundingSphere = null;
    },
    setVisible(slot, visible) {
      const lot = lots.get(slot.finish);
      if (!lot) return;
      lot.mesh.setVisibleAt(slot.instanceId, visible);
    },
    dispose() {
      for (const lot of lots.values()) {
        group.remove(lot.mesh);
        lot.mesh.dispose();
      }
      lots.clear();
      void FINISHES;
    },
  };
}

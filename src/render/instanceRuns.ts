import {
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  type BufferGeometry,
  type Frustum,
  type Material,
  type Matrix4,
  type MeshDepthMaterial,
} from 'three';
import { createCellInstances, type KindLevels, type KindMesh, type KindSpec, type Pack } from './cellInstances';

/** The same design as the buildings' gardens (`gardens.ts`, which keeps a run per garden list), on the same cells (`cellInstances.ts`) */

/** One mesh of the layer: a model, its material, how it is drawn. */
export interface RunStore {
  readonly name: string;
  /** Its bounding sphere computed (each slot's sphere is grown from it). */
  readonly geometry: BufferGeometry;
  readonly material: Material;
  /** The shadow pass's material (the wind's sway). */
  readonly depth?: MeshDepthMaterial;
  readonly castShadow: boolean;
  readonly receiveShadow: boolean;
  readonly renderOrder?: number;
  /** Has a colour per instance (white where a thing gives none): one program variant for its material. */
  readonly tinted: boolean;
  /** Leaf cards: left out at the map zoom (`setMap`). */
  readonly cards: boolean;
  /** More meshes drawn from the same instances: a plant's leaf cards, its far picture (`plantImpostors.ts`). */
  readonly with?: readonly KindMesh[];
  /** How its level is chosen by its size on the screen (`cellInstances.ts`); none: drawn at every size. */
  readonly levels?: KindLevels;
}

/** Floats an instance's matrix is kept in: three's affine matrix without its last row (0, 0, 0, 1). */
const AFFINE = 12;

/** A thing's instances in one store: matrices (`AFFINE` floats, three's column order), tints (tinted stores) and each one's largest scale. */
type RunPack = Pack;

/** A thing's instances, by store index. Never changed once made: a changed thing is a new run. */
export type Run = ReadonlyMap<number, RunPack>;

/** Runs to take away and to put in. A run is taken away by the same object that was put in. */
interface RunChange {
  readonly removed: readonly Run[];
  readonly added: readonly Run[];
}

/** Builds a run, placement by placement. */
export class RunBuilder {
  private readonly lists = new Map<number, { matrices: number[]; colours: number[]; scales: number[] }>();

  constructor(private readonly stores: readonly RunStore[]) {}

  /** One instance in `store`: its matrix (16 numbers, affine), its largest scale, and its tint (r, g, b; white when none). */
  add(store: number, matrix: ArrayLike<number>, scale: number, tint?: { readonly r: number; readonly g: number; readonly b: number }): void {
    let list = this.lists.get(store);
    if (!list) this.lists.set(store, list = { matrices: [], colours: [], scales: [] });
    for (let column = 0; column < 4; column++) for (let row = 0; row < 3; row++) list.matrices.push(matrix[column * 4 + row]!);
    list.scales.push(scale);
    if (this.stores[store]!.tinted) list.colours.push(tint?.r ?? 1, tint?.g ?? 1, tint?.b ?? 1);
  }

  build(): Run {
    const run = new Map<number, RunPack>();
    for (const [store, list] of [...this.lists].sort((a, b) => a[0] - b[0])) {
      run.set(store, {
        data: Float32Array.from(list.matrices),
        colours: this.stores[store]!.tinted ? Float32Array.from(list.colours) : null,
        scales: Float32Array.from(list.scales),
        count: list.scales.length,
      });
    }
    return run;
  }
}

/** Whether two runs hold the same instances, bit for bit. */
export function sameRun(a: Run, b: Run): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [store, pa] of a) {
    const pb = b.get(store);
    if (!pb || pa.count !== pb.count) return false;
    if (!sameArray(pa.data, pb.data) || !sameArray(pa.scales, pb.scales)) return false;
    if ((pa.colours === null) !== (pb.colours === null) || (pa.colours && !sameArray(pa.colours, pb.colours!))) return false;
  }
  return true;
}

function sameArray(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/** An affine matrix kept in `AFFINE` floats, written out whole. */
const AFFINE_FORMAT = {
  stride: AFFINE,
  matrixInto(data: Float32Array, at: number, out: Float32Array, outAt: number): void {
    out[outAt] = data[at]!; out[outAt + 1] = data[at + 1]!; out[outAt + 2] = data[at + 2]!; out[outAt + 3] = 0;
    out[outAt + 4] = data[at + 3]!; out[outAt + 5] = data[at + 4]!; out[outAt + 6] = data[at + 5]!; out[outAt + 7] = 0;
    out[outAt + 8] = data[at + 6]!; out[outAt + 9] = data[at + 7]!; out[outAt + 10] = data[at + 8]!; out[outAt + 11] = 0;
    out[outAt + 12] = data[at + 9]!; out[outAt + 13] = data[at + 10]!; out[outAt + 14] = data[at + 11]!; out[outAt + 15] = 1;
  },
};

export interface InstanceRuns {
  /** Every mesh of the layer, under `group`. */
  readonly group: Group;
  readonly meshes: readonly InstancedMesh[];
  readonly triangles: number;
  /** The runs that came and went; the meshes made are put under `group`. */
  update(change: RunChange): void;
  /** The map zoom: the leaf cards are left out, neither culled nor drawn; a store with far pictures drawn as them. Only a change of mode does anything. */
  setMap(map: boolean): void;
  /** Keeps the instances of each shown store the camera can see, or see the margin round, at the level each one's size on the screen picks. */
  cull(frustum: Frustum, view: Matrix4): void;
  dispose(): void;
}

/** A store as its kind of the cells: its own mesh first, then the ones drawn with it. */
const kindOf = (spec: RunStore): KindSpec => ({
  tinted: spec.tinted,
  ...(spec.levels ? { levels: spec.levels } : {}),
  meshes: [{
    name: spec.name, geometry: spec.geometry, material: spec.material, ...(spec.depth ? { depth: spec.depth } : {}),
    castShadow: spec.castShadow, receiveShadow: spec.receiveShadow, ...(spec.renderOrder !== undefined ? { renderOrder: spec.renderOrder } : {}),
    cards: spec.cards, far: false,
  }, ...(spec.with ?? [])],
});

/** A mesh of one slot, none drawn but that one, as the layer draws it: what compiles its program ahead. */
function warmMesh(mesh: KindMesh, tinted: boolean): InstancedMesh {
  const out = new InstancedMesh(mesh.geometry, mesh.material, 1);
  out.name = mesh.name;
  out.castShadow = mesh.castShadow;
  out.receiveShadow = mesh.receiveShadow;
  if (mesh.renderOrder !== undefined) out.renderOrder = mesh.renderOrder;
  out.frustumCulled = false;
  if (mesh.depth) out.customDepthMaterial = mesh.depth;
  if (tinted) out.instanceColor = new InstancedBufferAttribute(new Float32Array(3).fill(1), 3);
  out.count = 1;
  return out;
}

/** Meshes of each of these stores (and the ones drawn with them), one slot each, as the layer draws them: what compiles the layer's programs ahead */
export function warmMeshes(specs: readonly RunStore[]): InstancedMesh[] {
  return specs.flatMap((spec) => kindOf(spec).meshes.map((mesh) => warmMesh(mesh, spec.tinted)));
}

/** The layer over these stores. */
export function createInstanceRuns(name: string, specs: readonly RunStore[], margin: number): InstanceRuns {
  const group = new Group();
  group.name = name;
  const cells = createCellInstances(specs.map(kindOf), AFFINE_FORMAT, margin);
  return {
    group,
    get meshes() { return cells.meshes; },
    get triangles() { return cells.triangles; },
    update(change) {
      const made = cells.update({ removed: change.removed, added: change.added.map((run) => ({ key: run, packs: run })) });
      for (const mesh of made) group.add(mesh);
    },
    setMap(map) { cells.setMap(map); },
    cull(frustum, view) { cells.cull(frustum, view); },
    dispose() {
      cells.dispose();
      group.clear();
    },
  };
}

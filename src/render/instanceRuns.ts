import {
  Group,
  type BufferGeometry,
  type Frustum,
  type InstancedMesh,
  type Material,
  type Matrix4,
  type MeshDepthMaterial,
} from 'three';
import { createCellInstances, warmMesh, type KindLevels, type KindMesh, type KindSpec, type Pack, type SlotFormat } from './cellInstances';

/** The same design as the buildings' gardens (`gardens.ts`, which keeps a run per garden list), on the same cells (`cellInstances.ts`) */

/** DO NOT keep a matrix per thing, on the CPU or the GPU: a pose of `stride` floats, made three's matrix by the vertex shader (`cellInstances.ts` `posedMaterial`). */
export type PoseFormat = SlotFormat;

/** DO NOT go through an `Object3D` for each instance: three's `compose` of a turn about the up axis (r186 `Matrix4.compose`, `Quaternion.setFromEuler` with x = z = 0) */
export function yawMatrixInto(out: Float32Array | number[], at: number, px: number, py: number, pz: number, yaw: number, sx: number, sy: number, sz: number): void {
  const y = Math.sin(yaw / 2), w = Math.cos(yaw / 2);
  const y2 = y + y;
  const yy = y * y2, wy = w * y2;
  out[at] = (1 - yy) * sx; out[at + 1] = 0; out[at + 2] = -wy * sx; out[at + 3] = 0;
  out[at + 4] = 0; out[at + 5] = sy; out[at + 6] = 0; out[at + 7] = 0;
  out[at + 8] = wy * sz; out[at + 9] = 0; out[at + 10] = (1 - yy) * sz; out[at + 11] = 0;
  out[at + 12] = px; out[at + 13] = py; out[at + 14] = pz; out[at + 15] = 1;
}

/** A thing turned about the up axis: its place in the scene's frame (x, y, z), its yaw and its scale on three axes (7 floats, not 12). */
export const YAW_POSE: PoseFormat = {
  stride: 7,
  key: 'yaw',
  // `yawMatrixInto`: a = x, y, z, yaw; b = the scale on three axes.
  glsl: /* glsl */ `
  float y = sin(a.w / 2.0);
  float w = cos(a.w / 2.0);
  float y2 = y + y;
  float yy = y * y2;
  float wy = w * y2;
  return mat4((1.0 - yy) * b.x, 0.0, -wy * b.x, 0.0, 0.0, b.y, 0.0, 0.0, wy * b.z, 0.0, (1.0 - yy) * b.z, 0.0, a.x, a.y, a.z, 1.0);`,
  matrixInto(data, at, out, outAt) {
    yawMatrixInto(out, outAt, data[at]!, data[at + 1]!, data[at + 2]!, data[at + 3]!, data[at + 4]!, data[at + 5]!, data[at + 6]!);
  },
};

/** One mesh of the layer: a model, its material, how it is drawn. */
export interface RunStore {
  readonly name: string;
  /** Its bounding sphere computed (each slot's sphere is grown from it). */
  readonly geometry: BufferGeometry;
  /** Drawn from the layer's poses (`cellInstances.ts` `posedMaterial`): never shared with a mesh that reads three's own `instanceMatrix`. */
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

/** Pixels across under which a small thing (a stone, a bush, a tuft) is not drawn: its levels (`KindLevels.least`), measured by its model's sphere. */
export function leastPixel(geometry: BufferGeometry): KindLevels {
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  return { reach: geometry.boundingSphere?.radius ?? 1, least: 1 };
}

/** A thing's instances in one store: poses (the layer's `PoseFormat`), tints (tinted stores) and each one's largest scale. */
type RunPack = Pack;

/** A thing's instances, by store index. Never changed once made: a changed thing is a new run. */
export type Run = ReadonlyMap<number, RunPack>;

/** Runs to take away and to put in. A run is taken away by the same object that was put in. */
interface RunChange {
  readonly removed: readonly Run[];
  readonly added: readonly Run[];
}

interface Tint { readonly r: number; readonly g: number; readonly b: number }

/** Builds a run, placement by placement, in the poses of the layer it goes to (`createInstanceRuns`'s `format`). */
export class RunBuilder {
  private readonly lists = new Map<number, { poses: number[]; colours: number[]; scales: number[] }>();

  /** `stores`: whether each store is tinted (all a builder reads of it: a worker builds runs without the models). */
  constructor(private readonly stores: readonly Pick<RunStore, 'tinted'>[], private readonly format: PoseFormat = YAW_POSE) {}

  private listOf(store: number, scale: number, tint: Tint | undefined): number[] {
    let list = this.lists.get(store);
    if (!list) this.lists.set(store, list = { poses: [], colours: [], scales: [] });
    list.scales.push(scale);
    if (this.stores[store]!.tinted) list.colours.push(tint?.r ?? 1, tint?.g ?? 1, tint?.b ?? 1);
    return list.poses;
  }

  /** One instance in `store`: its pose (`format.stride` numbers), its largest scale, and its tint (r, g, b; white when none). */
  add(store: number, pose: ArrayLike<number>, scale: number, tint?: Tint): void {
    const poses = this.listOf(store, scale, tint);
    for (let i = 0; i < this.format.stride; i++) poses.push(pose[i]!);
  }

  /** One instance turned about the up axis (`YAW_POSE`): its place in the scene's frame, its yaw, its scale on three axes, its largest scale and tint. */
  turned(store: number, x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number, scale: number, tint?: Tint): void {
    if (this.format !== YAW_POSE) throw new Error('RunBuilder.turned: the layer keeps another pose');
    this.listOf(store, scale, tint).push(x, y, z, yaw, sx, sy, sz);
  }

  build(): Run {
    const run = new Map<number, RunPack>();
    for (const [store, list] of [...this.lists].sort((a, b) => a[0] - b[0])) {
      run.set(store, {
        data: Float32Array.from(list.poses),
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

/** Meshes of each of these stores (and the ones drawn with them), one slot each, as the layer of `format` draws them: what compiles the layer's programs ahead */
export function warmMeshes(specs: readonly RunStore[], format: PoseFormat = YAW_POSE): InstancedMesh[] {
  return specs.flatMap((spec) => kindOf(spec).meshes.map((mesh) => warmMesh(mesh, spec.tinted, format)));
}

/** The layer over these stores, its runs built in `format`'s poses (`RunBuilder`). */
export function createInstanceRuns(name: string, specs: readonly RunStore[], margin: number, format: PoseFormat = YAW_POSE): InstanceRuns {
  const group = new Group();
  group.name = name;
  const cells = createCellInstances(specs.map(kindOf), format, margin);
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

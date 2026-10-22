import {
  BufferGeometry,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedInterleavedBuffer,
  InstancedMesh,
  InterleavedBufferAttribute,
  Material,
  Matrix4,
  MeshDepthMaterial,
  Sphere,
  Vector2,
  Vector3,
  type Frustum,
  type Object3D,
} from 'three';
import { m } from '@world/units';
import { type Bounds, enclose, planeMask } from './instanceCull';
import { impostorPick, thinWant } from './plantImpostors';
import { trianglesOf } from './propGeometry';
import { castBySize } from './shadowCasters';

/**
 * INSTANCES KEPT CELL BY CELL, DRAWN AT THE LEVEL THEIR SIZE ON THE SCREEN CALLS FOR: the gardens'
 * (`gardens.ts`) and every layer kept thing by thing (`instanceRuns.ts`). A kind's placements are kept
 * once for all its meshes (a plant's body, its cards, its far picture); a cull walks only the 64 m
 * cells the view takes in, and writes each instance into the buffers of the level its size on the
 * screen picks, with hysteresis, so a plant never flickers between two. DO NOT go back to drawing
 * every plant in view with its whole model: a flowering bush two pixels wide cost 112 triangles.
 * The GPU gets each instance's pose, not its matrix: the vertex shader makes the matrix (`posedMaterial`).
 */

/** One mesh a kind's instances are drawn with. */
export interface KindMesh {
  readonly name: string;
  /** Its bounding sphere computed: the kind's instances are culled by the sphere round all its meshes'. */
  readonly geometry: BufferGeometry;
  /** Drawn from poses (`posedMaterial`): never shared with a mesh that reads three's own `instanceMatrix`. */
  readonly material: Material;
  /** The shadow pass's material (the wind's sway); none: three's own depth material, drawn from poses (`poseDepthOf`). */
  readonly depth?: MeshDepthMaterial;
  readonly castShadow: boolean;
  readonly receiveShadow: boolean;
  readonly renderOrder?: number;
  /** Leaf cards: left out at the map zoom (a kind with no far pictures). */
  readonly cards: boolean;
  /** Draws the instances small enough to be far pictures (`KindLevels.far`); else the near ones. */
  readonly far: boolean;
  /** Called on the mesh once it is made (the pictures' hooks, `plantImpostors.ts`). */
  readonly made?: (mesh: InstancedMesh) => void;
}

/** How a kind's level is chosen by its size on the screen: its bounding diameter, device pixels. */
export interface KindLevels {
  /** The radius a size is measured by, model units: the diameter times the instance's largest scale. */
  readonly reach: number;
  /** Pixels across under which the far meshes draw it, thinned under `THIN_PX` (`plantImpostors.ts`). */
  readonly far?: number;
  /** Pixels across under which it is not drawn at all (a kind with no far pictures). */
  readonly least?: number;
  /** Whether the far pictures can be drawn (taken, `plantImpostors.ts`): until then every size is drawn near. */
  readonly ready?: () => boolean;
  /** Told each view culled for and half the screen's height, device pixels (the far pictures' uniforms). */
  readonly view?: (view: Matrix4, halfHeight: number) => void;
}

export interface KindSpec {
  readonly meshes: readonly KindMesh[];
  /** A colour per instance (white where a thing gives none): one program variant for its materials. */
  readonly tinted: boolean;
  readonly levels?: KindLevels;
}

/** How a layer keeps a placement: a pose of `stride` floats (5 to 8), made three's matrix by the GPU (`glsl`) and by the CPU (`matrixInto`) with the same math. */
export interface SlotFormat {
  readonly stride: number;
  /** Names its programs (`posedMaterial`): one program variant per format. */
  readonly key: string;
  /** The body of GLSL `mat4 poseMatrixOf(vec4 a, vec4 b)`: `matrixInto` written in GLSL, the pose's floats being a.xyzw then b (b.w is 1 for a 7-float pose). */
  readonly glsl: string;
  matrixInto(data: Float32Array, at: number, out: Float32Array, outAt: number): void;
}

/** A thing's instances of one kind: placements (`stride` floats each), tints, each one's largest scale. */
export interface Pack {
  readonly data: Float32Array;
  readonly colours: Float32Array | null;
  readonly scales: Float32Array;
  readonly count: number;
}

export interface CellChange {
  readonly removed: readonly object[];
  /** Each thing's key (taken away by the same object later) and its packs, by kind. */
  readonly added: readonly { readonly key: object; readonly packs: ReadonlyMap<number, Pack> }[];
}

export interface CellInstances {
  readonly meshes: readonly InstancedMesh[];
  /** Triangles of the near meshes, every live instance counted. */
  readonly triangles: number;
  /** The things that came and went; the meshes made for kinds that had none. */
  update(change: CellChange): InstancedMesh[];
  /** The map zoom: every plant with far pictures drawn as one, the other kinds' leaf cards left out. Only a change does anything. */
  setMap(map: boolean): void;
  /** Writes each kind with a mesh shown the instances the view (or its margin) takes in, each at its level. */
  cull(frustum: Frustum, view: Matrix4): void;
  dispose(): void;
}

/** The pose's instanced attributes: its first four floats, and the rest. */
const POSE_A = 'instancePoseA';
const POSE_B = 'instancePoseB';
const MAIN = /\bvoid\s+main\s*\(\s*\)\s*\{/;

/**
 * A vertex shader drawn from poses: three's `instanceMatrix` (r186 `WebGLProgram` declares it in the prefix,
 * `project_vertex`, `worldpos_vertex` and `defaultnormal_vertex` read it, as do the wind and the far pictures)
 * becomes the matrix made from the pose at the top of `main`; the attribute itself is left unread.
 */
export function poseVertexShader(source: string, format: SlotFormat): string {
  if (!MAIN.test(source)) throw new Error(`poseVertexShader: no main() to make the ${format.key} matrix in`);
  return `#ifdef USE_INSTANCING
attribute vec4 ${POSE_A};
attribute vec4 ${POSE_B};
mat4 posedInstanceMatrix;
#define instanceMatrix posedInstanceMatrix
mat4 poseMatrixOf(vec4 a, vec4 b) {
${format.glsl}
}
#endif
${source.replace(MAIN, (open) => `${open}
#ifdef USE_INSTANCING
  posedInstanceMatrix = poseMatrixOf(${POSE_A}, ${POSE_B});
#endif`)}`;
}

/** On a material drawn from poses: their format; on a caster with no depth material of its own: the one made for it (`poseDepthOf`). Not copied by `clone`. */
const POSED = Symbol('posed');
const POSE_DEPTH = Symbol('poseDepth');
type Posed = Material & { [POSED]?: SlotFormat; [POSE_DEPTH]?: MeshDepthMaterial };

/** The material drawn from `format`'s poses, patched once and for good (after its own patches: the wind, the cards); a material can be drawn from one format only. */
export function posedMaterial<M extends Material>(material: M, format: SlotFormat): M {
  const marked = material as M & Posed, was = marked[POSED];
  if (was === format) return material;
  if (was) throw new Error(`${material.name || material.type}: drawn from ${was.key} poses, not ${format.key}`);
  marked[POSED] = format;
  const compile = material.onBeforeCompile, key = material.customProgramCacheKey;
  // three's own key is the patch's source (r186 `Material.customProgramCacheKey`): the one before this patch.
  const source = key === Material.prototype.customProgramCacheKey ? compile.toString() : null;
  material.onBeforeCompile = (shader, renderer) => {
    compile.call(material, shader, renderer);
    shader.vertexShader = poseVertexShader(shader.vertexShader, format);
  };
  material.customProgramCacheKey = () => `${source ?? key.call(material)}|pose-${format.key}`;
  material.needsUpdate = true;
  return material;
}

/** The shadow pass's material of a caster with none of its own: three's (r186 `WebGLShadowMap` `_depthMaterial`, one per caster as its `_materialCache`), drawn from the poses. */
export function poseDepthOf(material: Material, format: SlotFormat): MeshDepthMaterial {
  const caster = material as Posed;
  // No colour: the cascades compare their depth texture, nothing reads their colour (`sunCascades.ts` cascadeMap, VEG-10).
  return posedMaterial(caster[POSE_DEPTH] ??= new MeshDepthMaterial({ colorWrite: false }), format);
}

/** A mesh the cells draw: its level's poses (one buffer for the level's meshes) and their format. */
export function posesOf(mesh: InstancedMesh): { readonly buffer: InstancedInterleavedBuffer; readonly format: SlotFormat } {
  const poses = mesh.geometry.getAttribute(POSE_A) as InterleavedBufferAttribute | undefined;
  const format = (mesh.material as Posed)[POSED];
  if (!poses || !format) throw new Error(`${mesh.name}: not drawn from poses`);
  return { buffer: poses.data as InstancedInterleavedBuffer, format };
}

/** The matrices of the instances a mesh draws, as the GPU makes them from their poses (`matrixInto`, the same math): what a probe reads. */
export function drawnMatrices(mesh: InstancedMesh): Float32Array {
  const { buffer, format } = posesOf(mesh);
  const poses = buffer.array as Float32Array, out = new Float32Array(mesh.count * 16);
  for (let i = 0; i < mesh.count; i++) format.matrixInto(poses, i * buffer.stride, out, i * 16);
  return out;
}

/** The model with a level's poses as its instanced attributes: its own attributes and index shared (three r186 `WebGLAttributes` keeps one buffer per attribute). */
function posedGeometry(model: BufferGeometry, poses: InstancedInterleavedBuffer): BufferGeometry {
  const g = new BufferGeometry();
  g.name = model.name;
  g.setIndex(model.index);
  for (const name of Object.keys(model.attributes)) g.setAttribute(name, model.attributes[name]!);
  for (const group of model.groups) g.addGroup(group.start, group.count, group.materialIndex);
  g.setDrawRange(model.drawRange.start, model.drawRange.count);
  g.boundingSphere = model.boundingSphere;
  g.boundingBox = model.boundingBox;
  g.setAttribute(POSE_A, new InterleavedBufferAttribute(poses, 4, 0));
  g.setAttribute(POSE_B, new InterleavedBufferAttribute(poses, poses.stride - 4, 4));
  return g;
}

/** A posed geometry let go: the model's attributes and index taken off first, so three frees the poses' buffer and the vertex arrays only (r186 `WebGLGeometries` frees every attribute a disposed geometry holds). */
function letGo(g: BufferGeometry): void {
  for (const name of Object.keys(g.attributes)) if (name !== POSE_A && name !== POSE_B) g.deleteAttribute(name);
  g.setIndex(null);
  g.dispose();
}

/** A new mesh of `spec` on `geometry`, as the cells draw it: its shadow's material, no sphere of its own (culled instance by instance). */
function dressedMesh(spec: KindMesh, geometry: BufferGeometry, format: SlotFormat): InstancedMesh {
  // One slot of three's matrices, never read: the poses are the instances (`posedMaterial`).
  const mesh = new InstancedMesh(geometry, posedMaterial(spec.material, format), 1);
  mesh.name = spec.name;
  mesh.castShadow = spec.castShadow;
  mesh.receiveShadow = spec.receiveShadow;
  if (spec.renderOrder !== undefined) mesh.renderOrder = spec.renderOrder;
  // Culled instance by instance (`cull`): a sphere round the whole map rejects nothing.
  mesh.frustumCulled = false;
  const depth = spec.depth ? posedMaterial(spec.depth, format) : spec.castShadow ? poseDepthOf(spec.material, format) : undefined;
  if (depth) mesh.customDepthMaterial = depth;
  return mesh;
}

/** A mesh of one slot, none drawn but that one, as the cells draw `spec`: what compiles its programs ahead. */
export function warmMesh(spec: KindMesh, tinted: boolean, format: SlotFormat): InstancedMesh {
  const mesh = dressedMesh(spec, posedGeometry(spec.geometry, new InstancedInterleavedBuffer(new Float32Array(format.stride), format.stride)), format);
  if (tinted) mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(3).fill(1), 3);
  mesh.count = 1;
  return mesh;
}

/** The smallest store worth a mesh. */
const MIN_CAPACITY = 64;
/** Side of a leaf cell. */
const CELL = m(64);
/** Levels above the leaves: a root spans CELL * 2^LEVELS (65 km), so a town of any size has a handful of roots. */
const LEVELS = 10;
/** Slack on a node's radius over float rounding: a node test may only keep more than its instances' tests would, never less. */
const PAD = m(0.001);
const ALL_PLANES = 0b111111;
/** Integer cell coordinates as one key (exact while |cell| < 2^24). */
const cellKey = (ix: number, iz: number): number => (ix + 0x1000000) * 0x2000000 + (iz + 0x1000000);
/** The band round a level's threshold, as a share of it, an instance keeps the level it had in. */
const HYSTERESIS = 0.15;
/** A pick at most this far over the share kept is still written: the GPU, in float32, shrinks it away (`impostorThin`). */
const PICK_SLACK = 1e-4;
/** Levels an instance was drawn at. */
const NEAR = 0, FAR = 1, NONE = 2, UNKNOWN = 255;

/** Half the drawing buffer's height, device pixels, as the meshes last drew (`onBeforeRender`): the screen sizes are in it. */
const screen = { half: 540 };
/** Towards the sun the shadows are cast by (three's space, unit), as the cascades hold it (`setShadowSun`); none known: the margin round every way. */
const shadowSun = { x: 0, y: 0, z: 0, known: false };
/** The sun the shadows are cast by, for the layers' margins: an instance off the view is kept only where its shadow can fall into it, away from the sun. */
export function setShadowSun(x: number, y: number, z: number): void {
  const length = Math.hypot(x, y, z);
  shadowSun.known = length > 1e-6;
  if (!shadowSun.known) return;
  shadowSun.x = x / length; shadowSun.y = y / length; shadowSun.z = z / length;
}
const bufferSize = new Vector2();

/** The instances a kind draws at one level (near or far): ONE buffer of poses and one of tints for all the level's meshes (a plant's body and its cards). */
interface Level {
  readonly meshes: MeshState[];
  poses: InstancedInterleavedBuffer | null;
  tints: InstancedBufferAttribute | null;
  /** Instances its buffers hold: what is in view, grown twice over and shrunk under a quarter, never the kind's. */
  capacity: number;
  /** Per drawn position: the slot the buffers hold there (-1: none). */
  shown: Int32Array;
  /** Per slot of the kind: its position in the buffers (-1: not drawn at this level). */
  at: Int32Array;
  /** Whether a mesh of it is drawn at the cull in progress. */
  live: boolean;
  /** Positions in use, from 0. */
  drawn: number;
  /** The slots the cull in progress draws here that hold no position yet; the positions it wrote. */
  readonly entering: number[];
  readonly changed: number[];
  /** Its buffers made and not yet sent: sent whole, no range of them. */
  fresh: boolean;
  /** The widest instance it drew at its last cull (radius, world units): what a cascade's texel is measured against (`shadowCasters.ts`). */
  largest: number;
}

interface MeshState {
  readonly spec: KindMesh;
  readonly level: Level;
  mesh: InstancedMesh | null;
  /** Whether it was drawn (shown, not left out) when its kind was last culled. */
  wasDrawn: boolean;
  /** Takes it off the casters chosen by cascade (`castBySize`). */
  uncast: (() => void) | null;
  /** Where it was put (its owner's group) while it is out of the scene with nothing to draw (`settleInScene`). */
  home: Object3D | null;
}

interface Kind {
  readonly index: number;
  readonly spec: KindSpec;
  readonly meshes: MeshState[];
  /** Near, far. */
  readonly levels: readonly [Level, Level];
  /** The sphere round every mesh's, model units: what an instance is culled by. */
  readonly centre: Vector3;
  readonly reach: number;
  capacity: number;
  used: number;
  dead: number;
  data: Float32Array;
  colours: Float32Array;
  /** Per slot: centre x, y, z and radius, scene frame (radius -Infinity: dead). */
  spheres: Float32Array;
  /** Per slot: where it stands (its matrix's translation) and its size, world units across (`KindLevels.reach`). */
  feet: Float32Array;
  sizes: Float32Array;
  /** Per slot: its pick (`impostorPick`), the cull it was last in view at, the level it was drawn at, and the level the cull it was seen at draws it at (`NONE`: not drawn). */
  picks: Float32Array;
  seen: Uint32Array;
  level: Uint8Array;
  want: Uint8Array;
  bounds: Bounds | null;
  runs: Map<object, { start: number; count: number }>;
  /** Culls of this kind so far; culled for the current view; culled by the walk in progress. */
  serial: number;
  /** Whether its far pictures could be drawn at its last cull. */
  pictured: boolean;
  current: boolean;
  active: boolean;
}

interface CellNode {
  /** Bounds of everything under it, scene frame; radius < 0 while empty. Grown, never shrunk. */
  x: number; y: number; z: number; r: number;
  readonly children: (CellNode | null)[] | null;
  /** Leaf: per kind, its slots (in pick order for a kind with far pictures: the walk stops at the first one thinned out). */
  readonly slots: number[][] | null;
  /** Leaf: per kind, the largest size of a slot in it, world units across. */
  readonly big: Float32Array | null;
}

export function createCellInstances(kindSpecs: readonly KindSpec[], format: SlotFormat, margin: number): CellInstances {
  const stride = format.stride;
  if (stride < 5 || stride > 8) throw new Error(`createCellInstances: a pose of ${stride} floats (5 to 8 fit two vec4s)`);
  const kinds: Kind[] = kindSpecs.map((spec, index) => {
    // The sphere round every mesh's (each model's sphere computed by its maker).
    let centre: Vector3 | null = null, reach = 0;
    for (const mesh of spec.meshes) {
      // Its programs drawn from poses from the start: the ones compiled ahead are the ones drawn.
      posedMaterial(mesh.material, format);
      if (mesh.depth) posedMaterial(mesh.depth, format);
      else if (mesh.castShadow) poseDepthOf(mesh.material, format);
      if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
      const s = mesh.geometry.boundingSphere;
      if (!s) continue;
      if (!centre) { centre = s.center.clone(); reach = s.radius; } else reach = Math.max(reach, centre.distanceTo(s.center) + s.radius);
    }
    const level = (): Level => ({ meshes: [], poses: null, tints: null, capacity: 0, shown: new Int32Array(0), at: new Int32Array(0), live: false, drawn: 0, entering: [], changed: [], fresh: false, largest: 0 });
    const levels = [level(), level()] as const;
    return {
      index, spec, centre: centre ?? new Vector3(), reach: centre ? reach : 1, levels,
      meshes: spec.meshes.map((m) => {
        const s: MeshState = { spec: m, level: levels[m.far ? 1 : 0], mesh: null, wasDrawn: false, uncast: null, home: null };
        s.level.meshes.push(s);
        return s;
      }),
      capacity: 0, used: 0, dead: 0,
      data: new Float32Array(0), colours: new Float32Array(0), spheres: new Float32Array(0), feet: new Float32Array(0), sizes: new Float32Array(0),
      picks: new Float32Array(0), seen: new Uint32Array(0), level: new Uint8Array(0), want: new Uint8Array(0),
      bounds: null, runs: new Map(), serial: 1, pictured: false, current: false, active: false,
    };
  });
  /** Kinds whose leaves are kept in pick order. */
  const sorted = kinds.map((k) => k.spec.levels?.far !== undefined);

  const roots = new Map<number, CellNode>();
  let rootOrder: CellNode[] = [];
  const leaves = new Map<number, CellNode>();
  /** Leaves grown since the last `update`: their ancestors grown, their slots put in order, once at its end. */
  const grown = new Set<number>();
  const emptyNode = (leaf: boolean): CellNode => ({
    x: 0, y: 0, z: 0, r: -1,
    children: leaf ? null : [null, null, null, null],
    slots: leaf ? kinds.map(() => []) : null,
    big: leaf ? new Float32Array(kinds.length) : null,
  });
  const leafAt = (ix: number, iz: number): CellNode => {
    const key = cellKey(ix, iz);
    const leaf = leaves.get(key);
    if (leaf) return leaf;
    const rootKey = cellKey(ix >> LEVELS, iz >> LEVELS);
    let node: CellNode | undefined = roots.get(rootKey);
    if (!node) {
      roots.set(rootKey, node = emptyNode(false));
      rootOrder = [...roots.keys()].sort((a, b) => a - b).map((k) => roots.get(k)!);
    }
    for (let level = LEVELS; level > 0; level--) {
      const quadrant = ((ix >> (level - 1)) & 1) | (((iz >> (level - 1)) & 1) << 1);
      const children: (CellNode | null)[] = node.children!;
      node = children[quadrant] ??= emptyNode(level === 1);
    }
    leaves.set(key, node);
    return node;
  };
  const growNode = (node: CellNode, x: number, y: number, z: number, r: number): void => {
    const b = enclose(node.r < 0 ? null : node, { x, y, z, r });
    node.x = b.x; node.y = b.y; node.z = b.z; node.r = b.r;
  };
  /** Slot `i` of the kind put in its cell. */
  const file = (k: Kind, i: number): void => {
    const sp = k.spheres;
    const x = sp[i * 4]!, y = sp[i * 4 + 1]!, z = sp[i * 4 + 2]!, r = sp[i * 4 + 3]!;
    // Scene z is the world's -y: the cell is found on the ground plane, x and z.
    const ix = Math.floor(x / CELL), iz = Math.floor(z / CELL);
    const leaf = leafAt(ix, iz);
    leaf.slots![k.index]!.push(i);
    leaf.big![k.index] = Math.max(leaf.big![k.index]!, k.sizes[i]!);
    growNode(leaf, x, y, z, r);
    grown.add(cellKey(ix, iz));
  };
  const settle = (): void => {
    for (const key of grown) {
      const leaf = leaves.get(key)!;
      for (const k of kinds) if (sorted[k.index]) { const picks = k.picks; leaf.slots![k.index]!.sort((a, b) => picks[a]! - picks[b]! || a - b); }
      const ix = Math.floor(key / 0x2000000) - 0x1000000, iz = (key % 0x2000000) - 0x1000000;
      let node = roots.get(cellKey(ix >> LEVELS, iz >> LEVELS))!;
      for (let level = LEVELS; level > 0; level--) {
        growNode(node, leaf.x, leaf.y, leaf.z, leaf.r);
        node = node.children![((ix >> (level - 1)) & 1) | (((iz >> (level - 1)) & 1) << 1)]!;
      }
    }
    grown.clear();
  };
  /** The kind's slots filed again after a repack moved them. */
  const refile = (k: Kind): void => {
    for (const leaf of leaves.values()) leaf.slots![k.index]!.length = 0;
    for (let i = 0; i < k.used; i++) if (k.spheres[i * 4 + 3] !== -Infinity) file(k, i);
  };

  /**
   * The level's buffers made for `capacity` instances in view, the first `keep` positions carried over, and its meshes
   * drawn from them. DO NOT size them by the kind: a GPU buffer and its CPU copy of every plant of the map. three cannot
   * resize a buffer: the old ones are let go (r186 `WebGLObjects` frees an instanced mesh's tints on `dispose`, `WebGLGeometries` a geometry's poses).
   */
  const sizeLevel = (k: Kind, b: Level, capacity: number, keep: number): void => {
    const poses = new InstancedInterleavedBuffer(new Float32Array(capacity * stride), stride);
    poses.setUsage(DynamicDrawUsage);
    let tints: InstancedBufferAttribute | null = null;
    if (k.spec.tinted) {
      tints = new InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
      tints.setUsage(DynamicDrawUsage);
    }
    const shown = new Int32Array(capacity).fill(-1);
    if (b.poses && keep > 0) {
      (poses.array as Float32Array).set((b.poses.array as Float32Array).subarray(0, keep * stride));
      if (tints && b.tints) (tints.array as Float32Array).set((b.tints.array as Float32Array).subarray(0, keep * 3));
      shown.set(b.shown.subarray(0, keep));
    }
    for (const s of b.meshes) {
      const mesh = s.mesh;
      if (!mesh) continue;
      mesh.dispose();
      letGo(mesh.geometry);
      mesh.geometry = posedGeometry(s.spec.geometry, poses);
      mesh.instanceColor = tints;
    }
    b.poses = poses; b.tints = tints; b.capacity = capacity; b.shown = shown;
    // Sent whole when three first makes its buffer (r186 `WebGLAttributes.createBuffer`, which keeps the ranges): no range of it until then.
    b.fresh = true;
    poses.onUpload(() => { if (b.poses === poses) b.fresh = false; });
  };
  const makeMesh = (k: Kind, s: MeshState): InstancedMesh => {
    const spec = s.spec, b = s.level;
    if (!b.poses) sizeLevel(k, b, MIN_CAPACITY, 0);
    // The level's buffers, not a copy each: a plant's body and its cards draw the same instances.
    const mesh = dressedMesh(spec, posedGeometry(spec.geometry, b.poses!), format);
    mesh.instanceColor = b.tints;
    s.mesh = mesh;
    meshList = null;
    mesh.count = 0;
    // Made at the map zoom: its cards left out as the others' (`setMap`).
    if (spec.cards && mapMode === true && !k.pictured) mesh.visible = false;
    // The screen's size, device pixels, as it draws.
    const before = mesh.onBeforeRender.bind(mesh);
    mesh.onBeforeRender = (renderer, ...rest) => {
      const half = renderer.getDrawingBufferSize(bufferSize).y / 2;
      if (half > 0) screen.half = half;
      before(renderer, ...rest);
    };
    spec.made?.(mesh);
    // Cast into a cascade only with instances, and where the widest it draws reaches a texel (`shadowCasters.ts`).
    s.uncast = castBySize({ mesh, casts: spec.castShadow, radius: () => b.largest });
    return mesh;
  };

  const scratch = new Float32Array(16), point = new Vector3(), matrix = new Matrix4();
  /** The kind's arrays sized for `capacity`; packed (`pack`), its live runs from slot 0 in the order they stood. */
  const repack = (k: Kind, capacity: number, pack: boolean): void => {
    const data = new Float32Array(capacity * stride), colours = new Float32Array(k.spec.tinted ? capacity * 3 : 0).fill(1);
    const spheres = new Float32Array(capacity * 4), feet = new Float32Array(capacity * 3), sizes = new Float32Array(capacity);
    const picks = new Float32Array(capacity), seen = new Uint32Array(capacity), level = new Uint8Array(capacity).fill(UNKNOWN), want = new Uint8Array(capacity).fill(NONE);
    const move = (from: number, to: number, count: number): void => {
      data.set(k.data.subarray(from * stride, (from + count) * stride), to * stride);
      if (k.spec.tinted) colours.set(k.colours.subarray(from * 3, (from + count) * 3), to * 3);
      spheres.set(k.spheres.subarray(from * 4, (from + count) * 4), to * 4);
      feet.set(k.feet.subarray(from * 3, (from + count) * 3), to * 3);
      sizes.set(k.sizes.subarray(from, from + count), to);
      picks.set(k.picks.subarray(from, from + count), to);
      seen.set(k.seen.subarray(from, from + count), to);
      level.set(k.level.subarray(from, from + count), to);
      want.set(k.want.subarray(from, from + count), to);
    };
    if (pack) {
      const runs = new Map<object, { start: number; count: number }>();
      let at = 0;
      for (const [key, run] of [...k.runs].sort((a, b) => a[1].start - b[1].start)) {
        move(run.start, at, run.count);
        runs.set(key, { start: at, count: run.count });
        at += run.count;
      }
      k.runs = runs;
      k.used = at;
      k.dead = 0;
    } else move(0, 0, k.used);
    k.data = data; k.colours = colours; k.spheres = spheres; k.feet = feet; k.sizes = sizes;
    k.picks = picks; k.seen = seen; k.level = level; k.want = want; k.capacity = capacity;
    for (const b of k.levels) {
      const at = new Int32Array(capacity).fill(-1);
      // The slots moved: every position of the levels laid again at the next cull (`reconcile`); grown only, they keep theirs.
      if (pack) {
        b.shown.fill(-1);
        b.drawn = 0;
        for (const s of b.meshes) if (s.mesh) s.mesh.count = 0;
      } else at.set(b.at.subarray(0, Math.min(b.at.length, capacity)));
      b.at = at;
    }
    if (pack) {
      k.bounds = null;
      for (let i = 0; i < k.used; i++) k.bounds = enclose(k.bounds, { x: spheres[i * 4]!, y: spheres[i * 4 + 1]!, z: spheres[i * 4 + 2]!, r: spheres[i * 4 + 3]! });
      // The slots moved: the cells hold them anew.
      refile(k);
    }
  };
  const append = (k: Kind, key: object, one: Pack): void => {
    const start = k.used;
    k.data.set(one.data.subarray(0, one.count * stride), start * stride);
    if (k.spec.tinted) {
      if (one.colours) k.colours.set(one.colours.subarray(0, one.count * 3), start * 3);
      else k.colours.fill(1, start * 3, (start + one.count) * 3);
    }
    const measure = k.spec.levels?.reach ?? 0;
    let bounds: Bounds | null = null;
    for (let i = 0; i < one.count; i++) {
      const slot = start + i;
      format.matrixInto(k.data, slot * stride, scratch, 0);
      matrix.fromArray(scratch);
      point.copy(k.centre).applyMatrix4(matrix);
      const r = k.reach * one.scales[i]!;
      k.spheres[slot * 4] = point.x; k.spheres[slot * 4 + 1] = point.y; k.spheres[slot * 4 + 2] = point.z; k.spheres[slot * 4 + 3] = r;
      bounds = enclose(bounds, { x: point.x, y: point.y, z: point.z, r });
      // Where it stands and how big it is, as the far pictures' shader reads its matrix (`plantImpostors.ts`).
      k.feet[slot * 3] = scratch[12]!; k.feet[slot * 3 + 1] = scratch[13]!; k.feet[slot * 3 + 2] = scratch[14]!;
      const largest = Math.max(Math.hypot(scratch[0]!, scratch[1]!, scratch[2]!), Math.hypot(scratch[4]!, scratch[5]!, scratch[6]!), Math.hypot(scratch[8]!, scratch[9]!, scratch[10]!));
      k.sizes[slot] = 2 * measure * largest;
      // Its pick from its translation as the GPU reads it (the pose's own floats, the same bits).
      k.picks[slot] = impostorPick(scratch[12]!, scratch[13]!, scratch[14]!);
      k.seen[slot] = 0;
      k.level[slot] = UNKNOWN;
    }
    if (bounds) k.bounds = enclose(k.bounds, bounds);
    k.runs.set(key, { start, count: one.count });
    k.used += one.count;
    for (let i = start; i < k.used; i++) file(k, i);
  };

  let culledFor: Matrix4 | null = null;
  let culledHalf = 0;
  /** The sun the margins were last culled by (`setShadowSun`). */
  const culledSun = { ...shadowSun };
  /** The map zoom as the last `setMap` gave it (null: never told). */
  let mapMode: boolean | null = null;
  /** Whether a mesh is drawn at all now: a kind with no far pictures (or none taken yet) leaves its cards out at the map zoom. */
  const drawnNow = (k: Kind, s: MeshState): boolean => s.mesh !== null && s.mesh.visible && !(s.spec.cards && mapMode === true && !k.pictured);
  const probe = new Sphere();
  let cullFrustum: Frustum | null = null;
  /** The view's numbers for a size on the screen: row 1's length times half the height (pixels a unit at w = 1), and row 3 (w). */
  let perUnitAtOne = 0, w0 = 0, w1 = 0, w2 = 0, w3 = 1, wReach = 0;
  const wOf = (x: number, y: number, z: number): number => w0 * x + w1 * y + w2 * z + w3;
  /** The margin as the cull tests it: a thing's shadow falls from it away from the sun, `margin` along the ray at most, so its sphere is tested moved half that way and grown by half (it holds that ray, and lies within the margin's sphere round the thing); with no sun known, the margin round every way. */
  let reachX = 0, reachY = 0, reachZ = 0, reachR = margin;

  /** Slot `i` of the kind drawn at `level` by the cull in progress (`NONE`: not drawn): a slot new to its level asked a position (`reconcile`). */
  const mark = (k: Kind, i: number, level: number): void => {
    k.want[i] = level;
    if (level === NONE) return;
    const b = k.levels[level === FAR ? 1 : 0];
    const radius = k.spheres[i * 4 + 3]!;
    if (radius > b.largest) b.largest = radius;
    if (b.live && b.at[i]! < 0) b.entering.push(i);
  };
  /** Slot `i`'s pose and tint into position `p` of the level's buffers, once for all its meshes. */
  const put = (k: Kind, b: Level, i: number, p: number): void => {
    b.shown[p] = i;
    b.at[i] = p;
    b.changed.push(p);
    // The pose as kept: the vertex shader makes its matrix (`posedMaterial`).
    const poses = b.poses!.array as Float32Array, data = k.data;
    for (let j = 0, to = p * stride, from = i * stride; j < stride; j++) poses[to + j] = data[from + j]!;
    if (b.tints) {
      const tints = b.tints.array as Float32Array, c = k.colours;
      tints[p * 3] = c[i * 3]!; tints[p * 3 + 1] = c[i * 3 + 1]!; tints[p * 3 + 2] = c[i * 3 + 2]!;
    }
  };
  /**
   * The level's positions brought to the cull just walked: one no longer drawn here takes the last position's slot, one new to the level goes
   * at the end. DO NOT lay the instances in the walk's order: a cell come into view moved every position after it, and the view's every
   * instance went to the GPU again at each frame of a move. Only the positions written are sent.
   */
  const reconcile = (k: Kind, b: Level, id: number): void => {
    const now = k.serial, seen = k.seen, want = k.want, shown = b.shown, at = b.at;
    let n = b.drawn;
    for (let p = 0; p < n;) {
      const s = shown[p]!;
      if (seen[s] === now && want[s] === id) { p++; continue; }
      at[s] = -1;
      n--;
      // The last position's slot moved here (looked at again: it may be going too).
      if (p < n) put(k, b, shown[n]!, p);
      shown[n] = -1;
    }
    if (n + b.entering.length > b.capacity) {
      let capacity = Math.max(b.capacity, MIN_CAPACITY);
      while (capacity < n + b.entering.length) capacity *= 2;
      sizeLevel(k, b, capacity, n);
    }
    for (const i of b.entering) if (at[i]! < 0) put(k, b, i, n++);
    b.drawn = n;
    // A quarter of the buffers in use or less: shrunk to twice what is drawn, so they follow the view, not the most it ever held.
    if (b.capacity > MIN_CAPACITY && n * 4 < b.capacity) sizeLevel(k, b, Math.max(MIN_CAPACITY, n * 2), n);
    if (b.fresh) return;
    const changed = b.changed.sort((x, y) => x - y);
    // The last cull's ranges not sent yet (no mesh of the level drawn since): one range round them all, never a list growing while it is not drawn.
    if (b.poses!.updateRanges.length > 0) {
      const from = changed.length ? changed[0]! : Infinity, to = changed.length ? changed[changed.length - 1]! + 1 : -Infinity;
      sendSpan(b.poses!, from, to, stride);
      if (b.tints) sendSpan(b.tints, from, to, 3);
      return;
    }
    if (changed.length > 0) {
      // The positions written, in runs (three r186 `WebGLAttributes` merges the ranges next to each other into one `bufferSubData`).
      for (let r = 0; r < changed.length;) {
        let e = r;
        while (e + 1 < changed.length && changed[e + 1]! <= changed[e]! + 1) e++;
        const start = changed[r]!, end = Math.min(n, changed[e]! + 1);
        if (start < end) {
          b.poses!.addUpdateRange(start * stride, (end - start) * stride);
          if (b.tints) b.tints.addUpdateRange(start * 3, (end - start) * 3);
        }
        r = e + 1;
      }
      b.poses!.needsUpdate = true;
      if (b.tints) b.tints.needsUpdate = true;
    }
  };
  /** Positions `from` to `to` (exclusive), `width` floats each, merged with the ranges waiting into one. */
  const sendSpan = (attribute: InstancedInterleavedBuffer | InstancedBufferAttribute, from: number, to: number, width: number): void => {
    let start = from * width, end = to * width;
    for (const r of attribute.updateRanges) { start = Math.min(start, r.start); end = Math.max(end, r.start + r.count); }
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(start, end - start);
    attribute.needsUpdate = true;
  };

  /** The node and what it holds against the planes of `mask` still unsettled for it. */
  const visit = (node: CellNode, mask: number): void => {
    if (node.r < 0) return;
    let inner = mask;
    if (mask !== 0) {
      inner = planeMask(cullFrustum!, node.x + reachX, node.y + reachY, node.z + reachZ, node.r + PAD + reachR, mask);
      if (inner < 0) return;
    }
    if (node.children) {
      for (const child of node.children) if (child) visit(child, inner);
      return;
    }
    // The nearest the leaf comes to the eye (w), for the largest size in it.
    const wNear = wOf(node.x, node.y, node.z) - node.r * wReach;
    for (const k of kinds) {
      if (!k.active) continue;
      const slots = node.slots![k.index]!;
      if (slots.length === 0) continue;
      const levels = k.spec.levels;
      const sp = k.spheres, feet = k.feet, sizes = k.sizes, picks = k.picks, seen = k.seen, lv = k.level;
      const was = k.serial - 1, now = k.serial;
      const far = levels?.far === undefined || !k.pictured ? -1 : mapMode === true ? Infinity : levels.far;
      const least = levels?.least ?? -1;
      // Past the first slot whose pick is over the share the leaf's largest keeps, nothing more is drawn (`sorted`).
      const stopAt = far < 0 ? Infinity : thinWant(node.big![k.index]! * (wNear > 1e-4 ? perUnitAtOne / wNear : Infinity)) + PICK_SLACK;
      for (const i of slots) {
        const r = sp[i * 4 + 3]!;
        if (r === -Infinity) continue;
        if (picks[i]! > stopAt) break;
        if (inner !== 0) {
          // A cell across the view's edge: its slots one by one.
          probe.center.set(sp[i * 4]! + reachX, sp[i * 4 + 1]! + reachY, sp[i * 4 + 2]! + reachZ);
          probe.radius = r + reachR;
          if (!cullFrustum!.intersectsSphere(probe)) continue;
        }
        const prev = seen[i] === was ? lv[i]! : UNKNOWN;
        seen[i] = now;
        if (!levels) { mark(k, i, NEAR); continue; }
        const w = wOf(feet[i * 3]!, feet[i * 3 + 1]!, feet[i * 3 + 2]!);
        const across = sizes[i]! * (w > 1e-4 ? perUnitAtOne / w : Infinity);
        let level: number;
        if (far >= 0) {
          const bar = far * (prev === NEAR ? 1 - HYSTERESIS : prev === FAR ? 1 + HYSTERESIS : 1);
          level = across >= bar ? NEAR : FAR;
        } else if (least >= 0) {
          const bar = least * (prev === NEAR ? 1 - HYSTERESIS : prev === NONE ? 1 + HYSTERESIS : 1);
          level = across >= bar ? NEAR : NONE;
        } else level = NEAR;
        lv[i] = level;
        // A far picture past the share its size keeps is thinned out (the GPU grows the ones kept, `impostorThin`).
        mark(k, i, level === FAR && picks[i]! > thinWant(across) + PICK_SLACK ? NONE : level);
      }
    }
  };

  /**
   * A mesh with no instance to draw taken out of the scene, put back where it was once it has some. DO NOT leave a kind's every mesh in the
   * scene empty: three walks, sorts and calls each visible mesh, empty or not, in the colour pass and every cascade (r186 `projectObject`,
   * `renderObject`), dozens of a layer's kinds out of view.
   */
  const settleInScene = (s: MeshState): void => {
    const mesh = s.mesh!;
    if (mesh.count === 0) {
      if (mesh.parent) { s.home = mesh.parent; mesh.parent.remove(mesh); }
    } else if (!mesh.parent && s.home) {
      s.home.add(mesh);
      s.home = null;
    }
  };
  /** The meshes made, listed again only when one is made (`makeMesh`; VEG-11: read each frame for the gardens). */
  let meshList: InstancedMesh[] | null = null;
  const meshes = (): InstancedMesh[] => meshList ??= kinds.flatMap((k) => k.meshes.flatMap((s) => (s.mesh ? [s.mesh] : [])));
  return {
    get meshes() { return meshes(); },
    get triangles() {
      let n = 0;
      for (const k of kinds) for (const s of k.meshes) if (s.mesh && !s.spec.far) n += trianglesOf(s.spec.geometry) * (k.used - k.dead);
      return n;
    },
    update(change) {
      const made: InstancedMesh[] = [];
      for (const k of kinds) {
        let left = 0;
        // A thing changed or gone: its run is never drawn again.
        for (const key of change.removed) {
          const run = k.runs.get(key);
          if (!run) continue;
          for (let i = run.start; i < run.start + run.count; i++) k.spheres[i * 4 + 3] = -Infinity;
          k.dead += run.count;
          left += run.count;
          k.runs.delete(key);
        }
        let coming = 0;
        for (const { packs } of change.added) coming += packs.get(k.index)?.count ?? 0;
        // A kind none of whose things came or went: nothing of it is touched.
        if (left === 0 && coming === 0) continue;
        if (k.dead > 0 && k.dead * 2 >= k.used + coming) {
          // Half the kind dead: packed again in the order the runs stood, the new ones after; its arrays shrunk when under a quarter is used.
          const live = k.used - k.dead + coming;
          repack(k, live * 4 < k.capacity ? Math.max(MIN_CAPACITY, live * 2) : Math.max(k.capacity, MIN_CAPACITY), true);
        }
        if (k.used + coming > k.capacity) repack(k, Math.max(MIN_CAPACITY, (k.used + coming) * 2), false);
        for (const { key, packs } of change.added) {
          const one = packs.get(k.index);
          if (one && one.count > 0) append(k, key, one);
        }
        for (const s of k.meshes) {
          if (!s.mesh && k.capacity > 0) made.push(makeMesh(k, s));
          // Its one sphere set again, not a new one each update (VEG-11).
          if (s.mesh && k.bounds) {
            const sphere = s.mesh.boundingSphere ??= new Sphere();
            sphere.center.set(k.bounds.x, k.bounds.y, k.bounds.z);
            sphere.radius = k.bounds.r;
          }
        }
        // Its slots came or went: culled again at the next frame.
        k.current = false;
      }
      settle();
      return made;
    },
    setMap(map) {
      if (mapMode === map) return;
      mapMode = map;
      for (const k of kinds) {
        if (k.spec.levels?.far === undefined && !k.spec.meshes.some((s) => s.cards)) continue;
        k.current = false;
        // DO NOT leave the cards shown with no instance at the map zoom: a draw call each for nothing.
        for (const s of k.meshes) {
          if (!s.spec.cards || !s.mesh) continue;
          const left = map && !k.pictured;
          s.mesh.visible = !left;
          if (left) s.mesh.count = 0;
        }
      }
    },
    cull(frustum, view) {
      // The sun moved (a step of the cascades' sun): the margins point elsewhere, every kind culled again.
      const sunMoved = shadowSun.known !== culledSun.known || shadowSun.x !== culledSun.x || shadowSun.y !== culledSun.y || shadowSun.z !== culledSun.z;
      if (!culledFor || !culledFor.equals(view) || culledHalf !== screen.half || (sunMoved && margin > 0)) {
        culledFor = (culledFor ?? new Matrix4()).copy(view);
        culledHalf = screen.half;
        Object.assign(culledSun, shadowSun);
        for (const k of kinds) k.current = false;
      }
      // DO NOT cull every kind at every move whatever is shown.
      let any = false;
      for (const k of kinds) {
        // A mesh shown or hidden since, or its pictures taken: its kind culled again.
        const pictured = k.spec.levels?.far !== undefined && (k.spec.levels.ready?.() ?? true);
        if (pictured !== k.pictured) { k.pictured = pictured; k.current = false; }
        for (const s of k.meshes) if (s.wasDrawn !== drawnNow(k, s)) k.current = false;
        k.active = !k.current && k.meshes.some((s) => drawnNow(k, s));
        if (!k.active) continue;
        any = true;
        k.serial++;
        for (const b of k.levels) {
          b.live = b.meshes.some((s) => drawnNow(k, s));
          b.entering.length = 0;
          b.changed.length = 0;
          b.largest = 0;
        }
        k.spec.levels?.view?.(view, culledHalf);
      }
      if (!any) return;
      const e = view.elements;
      perUnitAtOne = Math.hypot(e[1]!, e[5]!, e[9]!) * culledHalf;
      w0 = e[3]!; w1 = e[7]!; w2 = e[11]!; w3 = e[15]!;
      wReach = Math.hypot(w0, w1, w2);
      cullFrustum = frustum;
      if (shadowSun.known && margin > 0) {
        reachX = -shadowSun.x * margin / 2; reachY = -shadowSun.y * margin / 2; reachZ = -shadowSun.z * margin / 2;
        reachR = margin / 2;
      } else { reachX = reachY = reachZ = 0; reachR = margin; }
      for (const root of rootOrder) visit(root, ALL_PLANES);
      cullFrustum = null;
      for (const k of kinds) {
        if (!k.active) continue;
        k.active = false;
        k.current = true;
        k.levels.forEach((b, id) => { if (b.live && b.poses) reconcile(k, b, id === 0 ? NEAR : FAR); });
        for (const s of k.meshes) {
          s.wasDrawn = drawnNow(k, s);
          if (s.mesh) { s.mesh.count = s.wasDrawn ? s.level.drawn : 0; settleInScene(s); }
        }
      }
    },
    dispose() {
      for (const k of kinds) for (const s of k.meshes) { s.uncast?.(); s.uncast = null; }
      for (const mesh of meshes()) {
        mesh.dispose();
        letGo(mesh.geometry);
      }
    },
  };
}

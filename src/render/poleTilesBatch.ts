import {
  type Camera,
  InstancedBufferAttribute,
  type InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InstancedMesh,
  LOD,
  Mesh,
  type Object3D,
  type OrthographicCamera,
  Sphere,
  Vector2,
  Vector3,
  type WebGLRenderer,
} from 'three';

import type { PolePartSpec } from './utilities';
import {
  POLE_PART_COUNT,
  SPAN_WIRES,
  WIRE_HALF_WIDTH,
  WIRE_STRIDE,
  WIRE_WIDTH,
  releaseWireGeometry,
  wireGeometry,
  wireLevel,
  wireParts,
  wireScreen,
} from './utilities';
import {
  type BakedPart,
  type BakedPoleCell,
  type BakedWires,
  WIRE_BLOCK,
  emptyBox,
  type PoleBake,
} from './poleBake';

/** THE TILES' POLES AND WIRES IN ONE BATCH EACH (`poleTiles.ts`): every landed tile's baked instances appended to a master buffer a part, drawn by one mesh a part for the whole streamed world, instead of twelve meshes a tile.
 *  The poles and wires never move once baked (`stillTree.ts` holds the tiles' content): the batch only appends a tile's runs and compacts them away when it goes. */

/** The screen and the sun's shadow map, as `poleLayer.ts` reads them: what a pixel and a shadow texel measure. */
const screen = {
  halfHeight: 1080,
  shadow: null as OrthographicCamera | null,
  shadowWidth: 0,
};
const drawingBuffer = new Vector2();
function noteScreen(renderer: WebGLRenderer): void {
  renderer.getDrawingBufferSize(drawingBuffer);
  if (drawingBuffer.y > 0) screen.halfHeight = drawingBuffer.y / 2;
}
function noteShadow(renderer: WebGLRenderer, _object: Object3D, _camera: Camera, shadowCamera: Camera): void {
  const map = renderer.getRenderTarget();
  if ((shadowCamera as OrthographicCamera).isOrthographicCamera && map) {
    screen.shadow = shadowCamera as OrthographicCamera;
    screen.shadowWidth = map.width;
  }
}

/** What a world unit measures on the screen where a bounding sphere comes nearest the eye, and a texel of the sun's shadow (`poleLayer.ts` ScreenScale, over the batch's runs). */
class ScreenScale {
  private readonly eye = new Vector3();
  private readonly ahead = new Vector3();
  private pixels = 0;
  private perspective = true;
  texel = 0;

  set(camera: Camera): void {
    const p = camera.projectionMatrix.elements, w = camera.matrixWorld.elements;
    this.pixels = screen.halfHeight * p[5]!;
    this.perspective = p[11] !== 0;
    this.eye.set(w[12]!, w[13]!, w[14]!);
    this.ahead.set(-w[8]!, -w[9]!, -w[10]!).normalize();
    const sun = screen.shadow;
    this.texel = sun && screen.shadowWidth > 0 ? (sun.right - sun.left) / sun.zoom / screen.shadowWidth : 0;
  }

  at(sphere: Sphere): number {
    if (!this.perspective) return this.pixels;
    const c = sphere.center, e = this.eye, a = this.ahead;
    const depth = (c.x - e.x) * a.x + (c.y - e.y) * a.y + (c.z - e.z) * a.z - sphere.radius;
    return depth > 1e-3 ? this.pixels / depth : Infinity;
  }
}

/** A run of a tile's instances in a master buffer: where it starts and how many, the sphere the pieces stand in, and the most of the screen one covers. */
interface Run {
  readonly tile: number;
  start: number;
  readonly count: number;
  readonly sphere: Sphere;
  readonly cover: number;
}

/** A sphere round a baked cell's pieces, as the view measures the cell (`poleLayer.ts` PartStore.flush). */
function sphereOf(box: readonly number[], reachScale: number, reach: number): Sphere {
  const centre = new Vector3((box[0]! + box[3]!) / 2, (box[1]! + box[4]!) / 2, (box[2]! + box[5]!) / 2);
  return new Sphere(centre, Math.hypot(box[3]! - box[0]!, box[4]! - box[1]!, box[5]! - box[2]!) / 2 + reach * reachScale);
}

/** One part over every tile: a master matrix array, one InstancedMesh, the tiles' runs. */
class PartBatch {
  private mesh: InstancedMesh | null = null;
  private data = new Float32Array(0);
  private capacity = 0;
  count = 0;
  private readonly runs: Run[] = [];
  private cover = 0;
  private level = 0;
  private dirty = false;
  private readonly reach: number;

  constructor(private readonly spec: PolePartSpec, private readonly group: Object3D) {
    this.reach = spec.geometry.boundingSphere ? spec.geometry.boundingSphere.center.length() + spec.geometry.boundingSphere.radius : 1;
  }

  /** A tile's pieces appended: the run's slot in the master buffer. */
  add(tile: number, baked: BakedPart): void {
    this.reserve(this.count + baked.count);
    const start = this.count;
    this.data.set(baked.matrices, start * 16);
    this.count += baked.count;
    this.runs.push({ tile, start, count: baked.count, sphere: sphereOf(baked.box, baked.scale, this.reach), cover: baked.cover });
    this.cover = Math.max(this.cover, baked.cover);
    this.dirty = true;
  }

  /** A tile's pieces let go: the runs after its own move down. */
  remove(tile: number): void {
    const at = this.runs.findIndex((run) => run.tile === tile);
    if (at < 0) return;
    const gone = this.runs[at]!;
    const from = (gone.start + gone.count) * 16;
    this.data.copyWithin(gone.start * 16, from, this.count * 16);
    this.runs.splice(at, 1);
    for (const run of this.runs) if (run.start > gone.start) run.start -= gone.count;
    this.count -= gone.count;
    let cover = 0;
    for (const run of this.runs) cover = Math.max(cover, run.cover);
    this.cover = cover;
    this.dirty = true;
  }

  private reserve(needed: number): void {
    if (needed <= this.capacity) return;
    const capacity = Math.max(needed, this.capacity * 2, 64);
    const data = new Float32Array(capacity * 16);
    data.set(this.data.subarray(0, this.count * 16));
    this.data = data;
    this.capacity = capacity;
    this.make();
  }

  private make(): void {
    // Count 0: the mesh takes the master array itself, never a copy of its own (`poleLayer.ts` meshOf).
    const mesh = new InstancedMesh(this.spec.levels[this.level]!.geometry, this.spec.material, 0);
    mesh.name = this.spec.name;
    mesh.castShadow = this.spec.castShadow;
    mesh.receiveShadow = this.spec.receiveShadow;
    mesh.renderOrder = this.spec.renderOrder;
    mesh.onBeforeRender = noteScreen;
    mesh.onBeforeShadow = noteShadow;
    mesh.instanceMatrix = new InstancedBufferAttribute(this.data, 16);
    mesh.count = this.count;
    if (this.mesh) {
      this.group.remove(this.mesh);
      // Its buffer let go on the GPU (`WebGLObjects` on the mesh's dispose).
      this.mesh.dispose();
    }
    this.group.add(mesh);
    this.mesh = mesh;
    this.dirty = true;
  }

  /** The drawn count and the masters sent; bounds from the runs' spheres. */
  flush(): void {
    const mesh = this.mesh;
    if (!mesh) return;
    mesh.count = this.count;
    mesh.visible = this.count > 0;
    if (this.dirty) {
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.needsUpdate = true;
      if (this.count > 0) {
        const x = emptyBox();
        for (const run of this.runs) {
          const c = run.sphere.center, r = run.sphere.radius;
          x[0] = Math.min(x[0]!, c.x - r); x[1] = Math.min(x[1]!, c.y - r); x[2] = Math.min(x[2]!, c.z - r);
          x[3] = Math.max(x[3]!, c.x + r); x[4] = Math.max(x[4]!, c.y + r); x[5] = Math.max(x[5]!, c.z + r);
        }
        mesh.boundingSphere = new Sphere(new Vector3((x[0]! + x[3]!) / 2, (x[1]! + x[4]!) / 2, (x[2]! + x[5]!) / 2),
          Math.hypot(x[3]! - x[0]!, x[4]! - x[1]!, x[5]! - x[2]!) / 2);
      }
      this.dirty = false;
    }
  }

  /** As the camera sees the batch: the part shown where its largest piece covers a pixel, cast where it reaches a shadow texel, the coarsest shape off by under a pixel. */
  view(scale: ScreenScale): void {
    const mesh = this.mesh, spec = this.spec;
    if (!mesh || this.count === 0 || spec.glows) return;
    let s = -Infinity;
    for (const run of this.runs) s = Math.max(s, scale.at(run.sphere));
    mesh.visible = this.cover * s * s * spec.brightness() >= 1;
    mesh.castShadow = spec.castShadow && (scale.texel === 0 || this.cover >= scale.texel * scale.texel);
    let level = 0;
    for (let i = spec.levels.length - 1; i > 0; i--) {
      if (spec.levels[i]!.error * s < 1) { level = i; break; }
    }
    if (level !== this.level) {
      this.level = level;
      mesh.geometry = spec.levels[level]!.geometry;
    }
  }

  dispose(): void {
    if (!this.mesh) return;
    this.group.remove(this.mesh);
    this.mesh.dispose();
    this.mesh = null;
  }
}

/** Every tile's wires: a master instance buffer, one mesh, the tiles' runs; the template the view asks for. */
class WireBatch {
  private mesh: Mesh | null = null;
  private data = new Float32Array(0);
  private buffer: InstancedInterleavedBuffer | null = null;
  private capacity = 0;
  count = 0;
  private readonly runs: Run[] = [];
  private sag = 0;
  private level = 0;
  private dirty = false;
  private levels: (InstancedBufferGeometry | undefined)[] = [];
  private readonly sphere = new Sphere();

  constructor(private readonly group: Object3D) {}

  add(tile: number, baked: BakedWires): void {
    this.reserve(this.count + baked.count);
    const start = this.count;
    this.data.set(baked.data, start * WIRE_BLOCK);
    this.count += baked.count;
    this.runs.push({ tile, start, count: baked.count, sphere: sphereOf(baked.box, 1, WIRE_HALF_WIDTH + baked.sag), cover: 0 });
    this.sag = Math.max(this.sag, baked.sag);
    this.dirty = true;
  }

  remove(tile: number): void {
    const at = this.runs.findIndex((run) => run.tile === tile);
    if (at < 0) return;
    const gone = this.runs[at]!;
    this.data.copyWithin(gone.start * WIRE_BLOCK, (gone.start + gone.count) * WIRE_BLOCK, this.count * WIRE_BLOCK);
    this.runs.splice(at, 1);
    for (const run of this.runs) if (run.start > gone.start) run.start -= gone.count;
    this.count -= gone.count;
    this.dirty = true;
  }

  private reserve(needed: number): void {
    if (needed <= this.capacity) return;
    const capacity = Math.max(needed, this.capacity * 2, 16);
    const data = new Float32Array(capacity * WIRE_BLOCK);
    data.set(this.data.subarray(0, this.count * WIRE_BLOCK));
    this.dropLevels();
    this.data = data;
    this.buffer = new InstancedInterleavedBuffer(data, WIRE_STRIDE, 1);
    this.capacity = capacity;
    this.dirty = true;
    if (this.mesh) {
      this.mesh.geometry = this.geometry(this.level);
      return;
    }
    this.makeMesh();
  }

  private makeMesh(): void {
    const { material, depth } = wireParts();
    const mesh = new Mesh(this.geometry(this.level), material);
    mesh.customDepthMaterial = depth;
    mesh.castShadow = true;
    mesh.name = 'utility-wires';
    mesh.onBeforeRender = noteScreen;
    mesh.onBeforeShadow = noteShadow;
    this.group.add(mesh);
    this.mesh = mesh;
  }

  private geometry(level: number): InstancedBufferGeometry {
    let geometry = this.levels[level];
    if (!geometry) {
      geometry = wireGeometry(level, this.buffer!);
      geometry.boundingSphere = this.sphere;
      geometry.instanceCount = this.count * SPAN_WIRES;
      this.levels[level] = geometry;
    }
    return geometry;
  }

  private dropLevels(): void {
    for (const geometry of this.levels) if (geometry) releaseWireGeometry(geometry);
    this.levels = [];
  }

  /** The wires drawn, the blocks sent; bounds from the runs. */
  flush(): void {
    const mesh = this.mesh, buffer = this.buffer;
    if (!mesh || !buffer) return;
    for (const geometry of this.levels) if (geometry) geometry.instanceCount = this.count * SPAN_WIRES;
    mesh.visible = this.count > 0;
    if (this.dirty) {
      buffer.clearUpdateRanges();
      buffer.needsUpdate = true;
      if (this.count > 0) {
        const x = emptyBox();
        for (const run of this.runs) {
          const c = run.sphere.center, r = run.sphere.radius;
          x[0] = Math.min(x[0]!, c.x - r); x[1] = Math.min(x[1]!, c.y - r); x[2] = Math.min(x[2]!, c.z - r);
          x[3] = Math.max(x[3]!, c.x + r); x[4] = Math.max(x[4]!, c.y + r); x[5] = Math.max(x[5]!, c.z + r);
        }
        this.sphere.center.set((x[0]! + x[3]!) / 2, (x[1]! + x[4]!) / 2, (x[2]! + x[5]!) / 2);
        this.sphere.radius = Math.hypot(x[3]! - x[0]!, x[4]! - x[1]!, x[5]! - x[2]!) / 2;
        // The template the wires are drawn with is the batch's (three culls by its sphere, as a cell's before).
        for (const geometry of this.levels) if (geometry) geometry.boundingSphere = this.sphere;
      }
      this.dirty = false;
    }
  }

  view(scale: ScreenScale): void {
    const mesh = this.mesh;
    if (!mesh || this.count === 0) return;
    let s = -Infinity;
    for (const run of this.runs) s = Math.max(s, scale.at(run.sphere));
    const level = wireLevel(s, this.sag);
    mesh.visible = level >= 0;
    if (level < 0) return;
    mesh.castShadow = scale.texel === 0 || WIRE_WIDTH >= scale.texel;
    if (level !== this.level) {
      this.level = level;
      mesh.geometry = this.geometry(level);
    }
  }

  dispose(): void {
    this.dropLevels();
    if (this.mesh) this.group.remove(this.mesh);
    this.mesh = null;
  }
}

/** The layer's root: three calls an LOD's `update` with the camera before it draws its children (`WebGLRenderer.projectObject`). */
class ViewedRoot extends LOD {
  constructor(private readonly onView: (camera: Camera) => void) {
    super();
  }

  override update(camera: Camera): void {
    this.onView(camera);
  }
}

/** Every tile's poles and wires, one mesh a part: what a landed tile appends to and a gone tile compacts away. */
export class PoleTilesBatch {
  readonly group: ViewedRoot;
  private readonly parts: PartBatch[];
  private readonly wires: WireBatch;
  private readonly tiles = new Set<number>();
  private readonly scale = new ScreenScale();

  constructor(specs: readonly PolePartSpec[], parent: Object3D) {
    this.group = new ViewedRoot((camera) => this.view(camera));
    this.group.name = 'utilities-batch';
    parent.add(this.group);
    this.parts = Array.from({ length: POLE_PART_COUNT }, (_, k) => new PartBatch(specs[k]!, this.group));
    this.wires = new WireBatch(this.group);
  }

  /** A tile's bake appended; the same tile again replaces what it had. */
  add(tile: number, bake: PoleBake): void {
    if (this.tiles.has(tile)) this.remove(tile);
    this.tiles.add(tile);
    for (const cell of bake.cells) this.addCell(tile, cell);
    this.flush();
  }

  private addCell(tile: number, cell: BakedPoleCell): void {
    cell.parts.forEach((part, k) => { if (part) this.parts[k]!.add(tile, part); });
    if (cell.wires) this.wires.add(tile, cell.wires);
  }

  /** A tile's runs compacted away. */
  remove(tile: number): void {
    if (!this.tiles.delete(tile)) return;
    for (const part of this.parts) part.remove(tile);
    this.wires.remove(tile);
    this.flush();
  }

  private flush(): void {
    for (const part of this.parts) part.flush();
    this.wires.flush();
  }

  private view(camera: Camera): void {
    this.scale.set(camera);
    wireScreen.uWirePixels.value = screen.halfHeight;
    for (const part of this.parts) part.view(this.scale);
    this.wires.view(this.scale);
  }

  dispose(): void {
    for (const part of this.parts) part.dispose();
    this.wires.dispose();
    this.group.removeFromParent();
    this.group.clear();
    this.tiles.clear();
  }
}

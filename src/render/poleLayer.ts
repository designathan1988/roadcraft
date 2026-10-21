import {
  type Camera,
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

import type { Change, ChangeRect } from '@world/changes';
import type { RoadDoc } from '@world/doc';
import type { PoleId, SpanId } from '@world/ids';
import type { Network } from '@world/network';
import { PoleIndex } from '@world/poleIndex';
import { m } from '@world/units';
import type { PoleArms, UtilityPole, UtilitySpan } from '@world/utilities';
import {
  type PartBounds,
  type PartShape,
  type PoleSource,
  WIRE_BLOCK,
  type WireBounds,
  emptyBox,
  framePole,
  growPart,
  growWires,
  partShape,
  wireEnd,
} from './poleBake';
import type { SceneryKit } from './scenery';
import {
  POLE_PART_COUNT,
  type Placement,
  type PolePartSpec,
  SPAN_WIRES,
  type Utilities,
  WIRE_HALF_WIDTH,
  WIRE_STRIDE,
  WIRE_WIDTH,
  placePole,
  polePartSpecs,
  releaseWireGeometry,
  spanWires,
  wireGeometry,
  wireLevel,
  wireParts,
  wireScreen,
  writePlacement,
} from './utilities';

export type { PoleSource } from './poleBake';

/** DO NOT build the whole layer again for a change; DO NOT pace or hold it. */


/** The document's poles as a layer's source. */
export const docPoles = (doc: RoadDoc): PoleSource => ({ poles: doc.poles, spans: doc.poleSpans, spansAt: (id) => doc.spansAt(id) });

/** How far from a pole a change of the roads or the ground can move it: its kerb (`kerbward`), its lamp's pool. */
const POLE_REACH = m(12);


interface PoleState {
  /** The block it is drawn in (`blockKey`). */
  readonly block: string;
  readonly x: number;
  readonly y: number;
  readonly top: number;
  readonly kerb: { x: number; y: number } | null;
  readonly frame: PoleArms;
  /** Its slots in each part's mesh (`POLE_PART`). */
  readonly slots: number[][];
}

/** The screen the layers were last drawn on and the sun's shadow map: what a pixel and a shadow texel measure. */
const screen = {
  /** Half the drawing buffer's height, pixels; until first drawn, a tall screen's (more detail, never less). */
  halfHeight: 1080,
  /** The shadow camera and its map's width, from the shadow pass (`noteShadow`); null until a piece is cast. */
  shadow: null as OrthographicCamera | null,
  shadowWidth: 0,
};
const drawingBuffer = new Vector2();
/** Before three draws one of the layer's meshes: the drawing buffer's height, the screen's own pixels. */
function noteScreen(renderer: WebGLRenderer): void {
  renderer.getDrawingBufferSize(drawingBuffer);
  if (drawingBuffer.y > 0) screen.halfHeight = drawingBuffer.y / 2;
}
/** Before three casts one of the layer's meshes into a shadow map: the camera of that map (`WebGLShadowMap.renderObject`). */
function noteShadow(renderer: WebGLRenderer, _object: Object3D, _camera: Camera, shadowCamera: Camera): void {
  const map = renderer.getRenderTarget();
  if ((shadowCamera as OrthographicCamera).isOrthographicCamera && map) {
    screen.shadow = shadowCamera as OrthographicCamera;
    screen.shadowWidth = map.width;
  }
}

/** What a world unit measures on the screen where a bounding sphere comes nearest the eye, and a texel of the sun's shadow. */
class ScreenScale {
  private readonly eye = new Vector3();
  private readonly ahead = new Vector3();
  private pixels = 0;
  private perspective = true;
  /** A shadow texel, world units; 0 while unknown (every piece casts). */
  texel = 0;

  /** The camera three is about to draw with. */
  set(camera: Camera): void {
    const p = camera.projectionMatrix.elements, w = camera.matrixWorld.elements;
    // Pixels a unit spans at depth 1 in perspective, anywhere in the orthographic view.
    this.pixels = screen.halfHeight * p[5]!;
    this.perspective = p[11] !== 0;
    this.eye.set(w[12]!, w[13]!, w[14]!);
    this.ahead.set(-w[8]!, -w[9]!, -w[10]!).normalize();
    const sun = screen.shadow;
    this.texel = sun && screen.shadowWidth > 0 ? (sun.right - sun.left) / sun.zoom / screen.shadowWidth : 0;
  }

  /** Pixels a unit spans at the sphere's nearest depth: Infinity when the eye is level with it or inside it. */
  at(sphere: Sphere): number {
    return this.atPoint(sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius);
  }

  /** Pixels a unit spans at a box's nearest corner (three's axes: x0, y0, z0, x1, y1, z1): Infinity when the eye is in it or level with it. */
  atBox(box: ArrayLike<number>): number {
    if (!this.perspective) return this.pixels;
    if (!(box[0]! <= box[3]!)) return 0;
    const e = this.eye, a = this.ahead;
    if (e.x >= box[0]! && e.x <= box[3]! && e.y >= box[1]! && e.y <= box[4]! && e.z >= box[2]! && e.z <= box[5]!) return Infinity;
    // The corner nearest along the view: each axis's end the view's direction comes to first.
    const depth = ((a.x >= 0 ? box[0]! : box[3]!) - e.x) * a.x + ((a.y >= 0 ? box[1]! : box[4]!) - e.y) * a.y + ((a.z >= 0 ? box[2]! : box[5]!) - e.z) * a.z;
    return depth > 1e-3 ? this.pixels / depth : Infinity;
  }

  atPoint(x: number, y: number, z: number, radius: number): number {
    if (!this.perspective) return this.pixels;
    const e = this.eye, a = this.ahead;
    const depth = (x - e.x) * a.x + (y - e.y) * a.y + (z - e.z) * a.z - radius;
    return depth > 1e-3 ? this.pixels / depth : Infinity;
  }
}

/** A part's instances over a block of the layer (`BLOCK`): a mesh with room for `capacity`, the first `count` drawn, and which pole holds each slot. */
class PartStore {
  private mesh: InstancedMesh | null = null;
  private capacity = 0;
  count = 0;
  private readonly owner: PoleId[] = [];
  private readonly written: number[] = [];
  private whole = false;
  private readonly bounds: PartBounds = { box: emptyBox(), scale: 0, cover: 0 };
  private boundsMoved = false;
  private readonly shape: PartShape;
  /** The shape drawn now (`PolePartSpec.levels`). */
  private level = 0;
  readonly perInstance: number;

  constructor(private readonly spec: PolePartSpec, private readonly group: Object3D) {
    const index = spec.geometry.index;
    this.perInstance = (index ? index.count : spec.geometry.getAttribute('position').count) / 3;
    this.shape = partShape(spec.geometry);
  }

  /** A mesh of the part with room for `capacity` instances. */
  private meshOf(capacity: number): InstancedMesh {
    const mesh = new InstancedMesh(this.spec.levels[this.level]!.geometry, this.spec.material, capacity);
    mesh.name = this.spec.name;
    mesh.castShadow = this.spec.castShadow;
    mesh.receiveShadow = this.spec.receiveShadow;
    mesh.renderOrder = this.spec.renderOrder;
    mesh.onBeforeRender = noteScreen;
    mesh.onBeforeShadow = noteShadow;
    return mesh;
  }

  /** Room for `needed` instances: a mesh at least twice as large when it is full, the drawn ones copied over. */
  reserve(needed: number): void {
    if (needed <= this.capacity) return;
    const capacity = Math.max(needed, this.capacity * 2, 16);
    const mesh = this.meshOf(capacity);
    if (this.mesh) {
      (mesh.instanceMatrix.array as Float32Array).set((this.mesh.instanceMatrix.array as Float32Array).subarray(0, this.count * 16));
      mesh.boundingSphere = this.mesh.boundingSphere;
      mesh.castShadow = this.mesh.castShadow;
      this.group.remove(this.mesh);
      // Its buffer let go on the GPU (`WebGLObjects` on the mesh's dispose).
      this.mesh.dispose();
    }
    this.group.add(mesh);
    this.mesh = mesh;
    this.capacity = capacity;
    this.whole = true;
  }

  /** A part placed for a pole: its slot. */
  add(pole: PoleId, placement: Placement): number {
    this.reserve(this.count + 1);
    const slot = this.count++;
    this.owner[slot] = pole;
    this.write(slot, placement);
    return slot;
  }

  private write(slot: number, placement: Placement): void {
    writePlacement(placement, this.mesh!.instanceMatrix.array as Float32Array, slot * 16);
    if (!this.whole) this.written.push(slot);
    if (growPart(this.bounds, placement, this.shape)) this.boundsMoved = true;
  }

  /** A slot let go: the last part moves into it. Returns the pole whose slot `count` became `slot`, if another moved. */
  remove(slot: number): PoleId | null {
    const last = --this.count;
    if (slot === last) return null;
    const array = this.mesh!.instanceMatrix.array as Float32Array;
    array.copyWithin(slot * 16, last * 16, last * 16 + 16);
    const moved = this.owner[last]!;
    this.owner[slot] = moved;
    if (!this.whole) this.written.push(slot);
    return moved;
  }

  /** The drawn count, and the slots written sent to the GPU. */
  flush(): void {
    const mesh = this.mesh;
    if (!mesh) return;
    mesh.count = this.count;
    mesh.visible = this.count > 0;
    const matrices = mesh.instanceMatrix;
    if (this.whole || this.written.length * 2 > this.count) {
      matrices.clearUpdateRanges();
      matrices.needsUpdate = true;
    } else if (this.written.length) {
      for (const slot of this.written) if (slot < this.count) matrices.addUpdateRange(slot * 16, 16);
      matrices.needsUpdate = true;
    }
    this.written.length = 0;
    this.whole = false;
    if (this.boundsMoved && this.count > 0) {
      // The part's own bounds, computed when its shape was made (`makeUtilityParts`, `createSceneryKit`).
      const b = this.bounds.box, part = this.spec.geometry.boundingSphere!;
      const centre = new Vector3((b[0]! + b[3]!) / 2, (b[1]! + b[4]!) / 2, (b[2]! + b[5]!) / 2);
      mesh.boundingSphere = new Sphere(centre, Math.hypot(b[3]! - b[0]!, b[4]! - b[1]!, b[5]! - b[2]!) / 2 + (part.center.length() + part.radius) * this.bounds.scale);
      this.boundsMoved = false;
    }
  }

  /** Its pieces' box (three's axes): where its block is nearest the eye with no pole of its own to say so (wires only). */
  get box(): ArrayLike<number> {
    return this.bounds.box;
  }

  /** As the camera sees the nearest pole: a piece covering under a pixel (times its brightness) not drawn, nor cast where it covers under a shadow texel; the coarsest shape off by under a pixel. */
  view(scale: ScreenScale, nearest: number): void {
    const mesh = this.mesh, spec = this.spec;
    if (!mesh || this.count === 0 || spec.glows) return;
    mesh.visible = this.bounds.cover * nearest * nearest * spec.brightness() >= 1;
    mesh.castShadow = spec.castShadow && (scale.texel === 0 || this.bounds.cover >= scale.texel * scale.texel);
    let level = 0;
    for (let i = spec.levels.length - 1; i > 0; i--) {
      if (spec.levels[i]!.error * nearest < 1) { level = i; break; }
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
  }
}

/** One block's spans' wires: `SPAN_WIRES` instances a span in a block of their own, drawn with the template the view asks for. */
class WireStore {
  private mesh: Mesh | null = null;
  private data = new Float32Array(0);
  private buffer: InstancedInterleavedBuffer | null = null;
  private capacity = 0;
  count = 0;
  private readonly owner: SpanId[] = [];
  private readonly written: number[] = [];
  private whole = false;
  private readonly bounds: WireBounds = { box: emptyBox(), sag: 0 };
  private boundsMoved = false;
  /** Each template's geometry over these instances, made when first drawn so; all share `sphere`. */
  private levels: (InstancedBufferGeometry | undefined)[] = [];
  private level = 0;
  private readonly sphere = new Sphere();
  private static readonly BLOCK = WIRE_BLOCK;

  constructor(private readonly group: Object3D) {}

  private reserve(needed: number): void {
    if (needed <= this.capacity) return;
    const capacity = Math.max(needed, this.capacity * 2, 16);
    const data = new Float32Array(capacity * WireStore.BLOCK);
    data.set(this.data.subarray(0, this.count * WireStore.BLOCK));
    this.dropLevels();
    this.data = data;
    this.buffer = new InstancedInterleavedBuffer(data, WIRE_STRIDE, 1);
    this.capacity = capacity;
    this.whole = true;
    if (this.mesh) {
      this.mesh.geometry = this.geometry(this.level);
      return;
    }
    this.makeMesh();
  }

  private makeMesh(): void {
    // One draw for the layer's wires: a template, and each wire's eight numbers as instances.
    const { material, depth } = wireParts();
    const mesh = new Mesh(this.geometry(this.level), material);
    // The shadow drawn from the same bent template (three draws a caster's shadow with its depth material).
    mesh.customDepthMaterial = depth;
    mesh.castShadow = true;
    mesh.name = 'utility-wires';
    mesh.onBeforeRender = noteScreen;
    mesh.onBeforeShadow = noteShadow;
    this.group.add(mesh);
    this.mesh = mesh;
  }

  /** The geometry drawing these wires with template `level`. */
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

  /** A span's wires strung: its block. */
  add(span: UtilitySpan, a: Parameters<typeof spanWires>[1], b: Parameters<typeof spanWires>[2]): number {
    this.reserve(this.count + 1);
    const block = this.count++;
    this.owner[block] = span.id;
    const at = block * WireStore.BLOCK;
    spanWires(span, a, b, this.data, at);
    if (!this.whole) this.written.push(block);
    if (growWires(this.bounds, this.data, at)) this.boundsMoved = true;
    return block;
  }

  /** A block let go: the last span's wires move into it. Returns the span whose block `count` became `block`. */
  remove(block: number): SpanId | null {
    const last = --this.count;
    if (block === last) return null;
    this.data.copyWithin(block * WireStore.BLOCK, last * WireStore.BLOCK, (last + 1) * WireStore.BLOCK);
    const moved = this.owner[last]!;
    this.owner[block] = moved;
    if (!this.whole) this.written.push(block);
    return moved;
  }

  /** The wires drawn, the blocks written sent; bounds from the wires' ends, their sag and the tube's radius (three would read the template's). */
  flush(): void {
    const mesh = this.mesh, buffer = this.buffer;
    if (!mesh || !buffer) return;
    for (const geometry of this.levels) if (geometry) geometry.instanceCount = this.count * SPAN_WIRES;
    mesh.visible = this.count > 0;
    if (this.whole || this.written.length * 2 > this.count) {
      buffer.clearUpdateRanges();
      buffer.needsUpdate = true;
    } else if (this.written.length) {
      for (const block of this.written) if (block < this.count) buffer.addUpdateRange(block * WireStore.BLOCK, WireStore.BLOCK);
      buffer.needsUpdate = true;
    }
    this.written.length = 0;
    this.whole = false;
    if (this.boundsMoved && this.count > 0) {
      const x = this.bounds.box;
      this.sphere.center.set((x[0]! + x[3]!) / 2, (x[1]! + x[4]!) / 2, (x[2]! + x[5]!) / 2);
      this.sphere.radius = Math.hypot(x[3]! - x[0]!, x[4]! - x[1]!, x[5]! - x[2]!) / 2 + this.bounds.sag + WIRE_HALF_WIDTH;
      this.boundsMoved = false;
    }
  }

  /** Its wires' box (three's axes, before their sag). */
  get box(): ArrayLike<number> {
    return this.bounds.box;
  }

  /** As the camera sees the nearest pole: the template its wires need (`wireLevel`), none once faded; cast while a texel or wider. */
  view(scale: ScreenScale, nearest: number): void {
    const mesh = this.mesh;
    if (!mesh || this.count === 0) return;
    const level = wireLevel(nearest, this.bounds.sag);
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
  }
}

/** The layer's root: three calls an LOD's `update` with the camera before it draws its children, each time it draws (`WebGLRenderer.projectObject`). */
class ViewedRoot extends LOD {
  constructor(private readonly onView: (camera: Camera) => void) {
    super();
  }

  override update(camera: Camera): void {
    this.onView(camera);
  }
}

/** THE LAYER IN BLOCKS OF THE PLANE: a store a part and one for the wires in each, so a block out of the view is culled by three and each is drawn at the detail its own nearest pole asks. DO NOT keep one store a part for the whole layer: its bounds were the city's, never culled, and its levels chosen by the pole nearest the eye, every wire, insulator and lamp of a large city drawn at that detail at every frame (26,145 wires of 64 triangles, 3 M triangles at a close view, 2026-10-20). DO NOT make them a world cell (256 m) either: forty meshes a part over a city, drawn. */
const BLOCK = m(768);
const blockKey = (x: number, y: number): string => `${Math.floor(x / BLOCK)},${Math.floor(y / BLOCK)}`;

interface Block {
  readonly parts: PartStore[];
  readonly wires: WireStore;
  /** The poles placed in it here (none for a block of wires only): where it is nearest the eye. */
  readonly poles: Set<PoleId>;
}

export class PoleLayer implements Utilities {
  readonly group: ViewedRoot;
  private readonly specs: readonly PolePartSpec[];
  private readonly blocks = new Map<string, Block>();
  private readonly poles = new Map<PoleId, PoleState>();
  /** Each span strung here, with its block of the plane and its place in that block's wires. */
  private readonly spans = new Map<SpanId, { readonly span: UtilitySpan; readonly key: string; block: number }>();
  /** The poles drawn here by place, and the spans strung to each: what an edit takes away is found here. */
  private readonly index = new PoleIndex();
  private readonly scratch: Placement[][] = Array.from({ length: POLE_PART_COUNT }, () => []);
  private readonly scale = new ScreenScale();

  constructor(kit: SceneryKit, name = 'utilities') {
    this.group = new ViewedRoot((camera) => this.view(camera));
    this.group.name = name;
    this.specs = polePartSpecs(kit);
  }

  /** The block of key `key`, made when first asked. */
  private block(key: string): Block {
    let block = this.blocks.get(key);
    if (!block) {
      block = { parts: this.specs.map((spec) => new PartStore(spec, this.group)), wires: new WireStore(this.group), poles: new Set() };
      this.blocks.set(key, block);
    }
    return block;
  }

  get triangles(): number {
    let triangles = 0;
    for (const block of this.blocks.values()) for (const part of block.parts) triangles += part.perInstance * part.count;
    return triangles;
  }

  /** The poles this layer holds inside a rectangle, where it drew them. */
  polesIn(rect: ChangeRect): PoleId[] {
    return this.index.near(rect).filter((id) => {
      const pole = this.poles.get(id)!;
      return pole.x >= rect[0] && pole.x <= rect[2] && pole.y >= rect[1] && pole.y <= rect[3];
    });
  }

  /** Every pole this layer holds. */
  ids(): IterableIterator<PoleId> {
    return this.poles.keys();
  }

  /** Every pole and span of the source, on an empty layer, in the source's order: the layer a full build makes */
  fill(net: Network, groundAt: (x: number, y: number) => number, source: PoleSource): void {
    for (const pole of source.poles.values()) this.place(net, groundAt, source, pole, undefined);
    for (const span of source.spans.values()) this.string(span);
    this.flush();
  }

  /** These poles placed again as the source has them */
  redo(net: Network, groundAt: (x: number, y: number) => number, source: PoleSource, seeds: Iterable<PoleId>): void {
    const fresh = new Set(seeds);
    const dirty = new Set(fresh);
    for (const id of fresh) {
      for (const sid of this.index.spansAt(id)) { const s = this.spans.get(sid)!.span; dirty.add(s.a === id ? s.b : s.a); }
      if (source.poles.has(id)) for (const s of source.spansAt(id)) dirty.add(s.a === id ? s.b : s.a);
    }
    if (dirty.size === 0) return;
    // The spans reaching them, as strung here and as the source has them.
    const strung = new Set<SpanId>();
    const wanted = new Map<SpanId, UtilitySpan>();
    for (const id of dirty) {
      for (const sid of this.index.spansAt(id)) strung.add(sid);
      if (source.poles.has(id)) for (const s of source.spansAt(id)) wanted.set(s.id, s);
    }
    for (const sid of strung) this.unstring(sid);
    for (const id of dirty) {
      const was = this.poles.get(id);
      if (was) this.unplace(id, was);
      const pole = source.poles.get(id);
      if (pole) this.place(net, groundAt, source, pole, fresh.has(id) || !was || was.x !== pole.x || was.y !== pole.y ? undefined : was.kerb);
    }
    for (const span of wanted.values()) this.string(span);
    this.flush();
  }

  /** The diary's changes since the layer was last brought up (none with a null rectangle: that is a whole build), from `source` (the document's, `docPoles`) */
  follow(net: Network, groundAt: (x: number, y: number) => number, doc: RoadDoc, entries: readonly Change[], source: PoleSource = docPoles(doc)): void {
    const seeds = new Set<PoleId>();
    for (const entry of entries) {
      const pad = entry.kind === 'utilities' ? 0 : POLE_REACH;
      for (const r of entry.rects ?? []) {
        const rect: ChangeRect = [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad];
        for (const pole of doc.polesIn(rect)) {
          if (pole.x >= rect[0] && pole.x <= rect[2] && pole.y >= rect[1] && pole.y <= rect[3]) seeds.add(pole.id);
        }
        for (const id of this.polesIn(rect)) seeds.add(id);
      }
    }
    this.redo(net, groundAt, source, seeds);
  }

  /** A pole framed and its parts placed; its way to the kerb kept from before, or undefined to read it (`kerbward`). */
  private place(net: Network, groundAt: (x: number, y: number) => number, source: PoleSource,
    pole: UtilityPole, kept: { x: number; y: number } | null | undefined): void {
    const { top, kerb, frame } = framePole(net, groundAt, source, pole, kept);
    const slots: number[][] = Array.from({ length: POLE_PART_COUNT }, () => []);
    const key = blockKey(pole.x, pole.y);
    const block = this.block(key);
    if (source.draws?.(pole) ?? true) {
      const out = this.scratch;
      for (const list of out) list.length = 0;
      placePole(pole, top, frame, kerb, groundAt, out);
      out.forEach((list, part) => { for (const placement of list) slots[part]!.push(block.parts[part]!.add(pole.id, placement)); });
    }
    block.poles.add(pole.id);
    this.poles.set(pole.id, { block: key, x: pole.x, y: pole.y, top, kerb, frame, slots });
    this.index.putPole(pole);
  }

  private unplace(id: PoleId, state: PoleState): void {
    const block = this.blocks.get(state.block)!;
    block.poles.delete(id);
    state.slots.forEach((slots, part) => {
      const store = block.parts[part];
      if (!store) return;
      // Highest first: the last slot is then never one of this pole's still to go.
      for (const slot of [...slots].sort((a, b) => b - a)) {
        const moved = store.remove(slot);
        if (moved === null) continue;
        const theirs = this.poles.get(moved)!.slots[part]!;
        theirs[theirs.indexOf(store.count)] = slot;
      }
    });
    this.poles.delete(id);
    this.index.deletePole(id);
  }

  /** A span's wires, when both its poles stand here; framed as each end frames it. */
  private string(span: UtilitySpan): void {
    if (this.spans.has(span.id)) return;
    const a = this.poles.get(span.a), b = this.poles.get(span.b);
    if (!a || !b) return;
    // In the block of its first pole.
    const key = a.block;
    const block = this.block(key).wires.add(span, wireEnd(span, a), wireEnd(span, b));
    this.spans.set(span.id, { span, key, block });
    this.index.putSpan(span);
  }

  private unstring(id: SpanId): void {
    const held = this.spans.get(id);
    if (!held) return;
    const moved = this.blocks.get(held.key)!.wires.remove(held.block);
    if (moved !== null) this.spans.get(moved)!.block = held.block;
    this.spans.delete(id);
    this.index.deleteSpan(held.span);
  }

  /** Every store's changes sent. */
  private flush(): void {
    for (const block of this.blocks.values()) {
      for (const part of block.parts) part.flush();
      block.wires.flush();
    }
  }

  /** Each block's nearest pole as this camera sees it, each time three draws the layer: what its parts fade and coarsen by. */
  private view(camera: Camera): void {
    this.scale.set(camera);
    wireScreen.uWirePixels.value = screen.halfHeight;
    for (const block of this.blocks.values()) {
      let nearest = -Infinity;
      if (block.poles.size > 0) {
        // A pole's own reach, the top of its mast standing at (x, top, -y) in three's axes.
        for (const id of block.poles) {
          const pole = this.poles.get(id)!;
          nearest = Math.max(nearest, this.scale.atPoint(pole.x, pole.top / 2, -pole.y, pole.top / 2));
        }
      } else {
        // A block of wires only: the nearest corner of what it holds.
        for (const part of block.parts) if (part.count > 0) nearest = Math.max(nearest, this.scale.atBox(part.box));
        if (block.wires.count > 0) nearest = Math.max(nearest, this.scale.atBox(block.wires.box));
      }
      for (const part of block.parts) part.view(this.scale, nearest);
      block.wires.view(this.scale, nearest);
    }
  }

  dispose(): void {
    // The instances and the wires are this layer's; the parts' shapes and materials are shared (`PARTS`).
    for (const block of this.blocks.values()) {
      for (const part of block.parts) part.dispose();
      block.wires.dispose();
    }
    this.blocks.clear();
    this.group.clear();
  }

}


/** The layer of every pole of a source, built whole (a load, a preview, the shaders' warm-up). */
export function buildUtilities(
  net: Network,
  groundAt: (x: number, y: number) => number,
  kit: SceneryKit,
  source: PoleSource = docPoles(net.doc),
  name = 'utilities',
): PoleLayer {
  const layer = new PoleLayer(kit, name);
  layer.fill(net, groundAt, source);
  return layer;
}

/** A planned pole run, as the editor would build it: in order, each pole new or already standing. */
export interface PolePreviewInput {
  readonly poles: readonly { readonly x: number; readonly y: number; readonly lamp: boolean; readonly standing: boolean }[];
}

/** The run under the pointer, drawn as it will stand */
export function buildPolePreview(
  net: Network,
  groundAt: (x: number, y: number) => number,
  kit: SceneryKit,
  input: PolePreviewInput,
): Utilities {
  const poles = new Map<PoleId, UtilityPole>();
  const spans = new Map<SpanId, UtilitySpan>();
  const reaching = new Map<PoleId, UtilitySpan[]>();
  const standing = new Set<PoleId>();
  input.poles.forEach((pole, index) => {
    const id = (index + 1) as PoleId;
    poles.set(id, { id, x: pole.x, y: pole.y, lamp: pole.lamp });
    if (pole.standing) standing.add(id);
    if (index === 0) return;
    const span: UtilitySpan = { id: index as SpanId, a: index as PoleId, b: id };
    spans.set(span.id, span);
    for (const end of [span.a, span.b]) reaching.set(end, [...(reaching.get(end) ?? []), span]);
  });
  return buildUtilities(net, groundAt, kit,
    { poles, spans, spansAt: (id) => reaching.get(id) ?? [], draws: (pole) => !standing.has(pole.id) }, 'utility-preview');
}

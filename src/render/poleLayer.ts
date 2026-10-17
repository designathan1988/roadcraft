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

import { cellAt } from '@world/cells';
import type { Change, ChangeRect } from '@world/changes';
import type { RoadDoc } from '@world/doc';
import type { PoleId, SpanId } from '@world/ids';
import type { Network } from '@world/network';
import { PoleIndex } from '@world/poleIndex';
import { kerbward } from '@world/poleLines';
import { m } from '@world/units';
import { POLE_HEIGHT, type PoleArms, poleArmsAt, type UtilityPole, type UtilitySpan } from '@world/utilities';
import type { ActiveTiles } from './activeTiles';
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

/** DO NOT build the whole layer again for a change; DO NOT pace or hold it. */

/** What a pole layer is built from: the document's poles and spans, or a planned run (`buildPolePreview`). */
export interface PoleSource {
  readonly poles: ReadonlyMap<PoleId, UtilityPole>;
  readonly spans: ReadonlyMap<SpanId, UtilitySpan>;
  /** The spans reaching a pole, in the order they were strung (`RoadDoc.spansAt`). */
  spansAt(id: PoleId): Iterable<UtilitySpan>;
  /** Which poles get a mast, arms and lamp here; a pole a preview only ties into is standing already. */
  readonly draws?: (pole: UtilityPole) => boolean;
  /** Which poles are placed here at all (none: every one): the streamed world's active tiles' (`docPoles`). */
  readonly stands?: (pole: UtilityPole) => boolean;
  /** Which spans are strung here, between two placed poles (none: every one). */
  readonly strings?: (span: UtilitySpan) => boolean;
}

/** The document's poles as a layer's source; `active`, the streamed world's active tiles (`activeTiles.ts`): a wire is strung when a pole of it stands on one, a pole placed when it stands on one or such a wire ties it, so the active tiles keep every wire and pole they had and the kept ring beyond is the far levels'. */
export const docPoles = (doc: RoadDoc, active?: ActiveTiles): PoleSource => {
  const source: PoleSource = { poles: doc.poles, spans: doc.poleSpans, spansAt: (id) => doc.spansAt(id) };
  if (!active) return source;
  const on = (id: PoleId): boolean => { const p = doc.poles.get(id); return !!p && active.has(p.x, p.y); };
  return {
    ...source,
    stands: (pole) => active.has(pole.x, pole.y) || doc.spansAt(pole.id).some((s) => on(s.a === pole.id ? s.b : s.a)),
    strings: (span) => on(span.a) || on(span.b),
  };
};

/** How far from a pole a change of the roads or the ground can move it: its kerb (`kerbward`), its lamp's pool. */
const POLE_REACH = m(12);

interface PoleState {
  readonly x: number;
  readonly y: number;
  readonly top: number;
  readonly kerb: { x: number; y: number } | null;
  readonly frame: PoleArms;
  /** The cell holding its parts (`cellAt`). */
  readonly cell: number;
  /** Its slots in each part's mesh of that cell (`POLE_PART`). */
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
    if (!this.perspective) return this.pixels;
    const c = sphere.center, e = this.eye, a = this.ahead;
    const depth = (c.x - e.x) * a.x + (c.y - e.y) * a.y + (c.z - e.z) * a.z - sphere.radius;
    return depth > 1e-3 ? this.pixels / depth : Infinity;
  }
}

/** One part's instances in one cell: a mesh with room for `capacity`, the first `count` drawn, and which pole holds each slot. */
class PartStore {
  private mesh: InstancedMesh | null = null;
  private capacity = 0;
  count = 0;
  private readonly owner: PoleId[] = [];
  private readonly written: number[] = [];
  private whole = false;
  private readonly box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  private scale = 0;
  private boundsMoved = false;
  /** The largest piece's two longest sides multiplied: the most of the screen one covers, square units. */
  private cover = 0;
  /** The shape drawn now (`PolePartSpec.levels`). */
  private level = 0;
  readonly perInstance: number;

  constructor(private readonly spec: PolePartSpec, private readonly group: Object3D) {
    const index = spec.geometry.index;
    this.perInstance = (index ? index.count : spec.geometry.getAttribute('position').count) / 3;
  }

  /** Room for `needed` instances: a mesh at least twice as large when it is full, the drawn ones copied over. */
  reserve(needed: number): void {
    if (needed <= this.capacity) return;
    const capacity = Math.max(needed, this.capacity * 2, 16);
    const mesh = new InstancedMesh(this.spec.levels[this.level]!.geometry, this.spec.material, capacity);
    mesh.name = this.spec.name;
    mesh.castShadow = this.spec.castShadow;
    mesh.receiveShadow = this.spec.receiveShadow;
    mesh.renderOrder = this.spec.renderOrder;
    mesh.onBeforeRender = noteScreen;
    mesh.onBeforeShadow = noteShadow;
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
    const b = this.box;
    const x = placement.x, y = placement.z, z = -placement.y;
    if (x < b[0]! || y < b[1]! || z < b[2]! || x > b[3]! || y > b[4]! || z > b[5]!) {
      b[0] = Math.min(b[0]!, x); b[1] = Math.min(b[1]!, y); b[2] = Math.min(b[2]!, z);
      b[3] = Math.max(b[3]!, x); b[4] = Math.max(b[4]!, y); b[5] = Math.max(b[5]!, z);
      this.boundsMoved = true;
    }
    const s = Math.max(Math.abs(placement.sx), Math.abs(placement.sy), Math.abs(placement.sz));
    if (s > this.scale) { this.scale = s; this.boundsMoved = true; }
    // The piece's box as placed (a turn keeps its sides): its two longest sides.
    const shape = this.spec.geometry.boundingBox;
    if (shape) {
      const [long, wide] = [
        (shape.max.x - shape.min.x) * Math.abs(placement.sx),
        (shape.max.y - shape.min.y) * Math.abs(placement.sy),
        (shape.max.z - shape.min.z) * Math.abs(placement.sz),
      ].sort((p, q) => q - p);
      this.cover = Math.max(this.cover, long! * wide!);
    }
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
      const b = this.box, part = this.spec.geometry.boundingSphere!;
      const centre = new Vector3((b[0]! + b[3]!) / 2, (b[1]! + b[4]!) / 2, (b[2]! + b[5]!) / 2);
      mesh.boundingSphere = new Sphere(centre, Math.hypot(b[3]! - b[0]!, b[4]! - b[1]!, b[5]! - b[2]!) / 2 + (part.center.length() + part.radius) * this.scale);
      this.boundsMoved = false;
    }
  }

  /** As the camera sees the cell: a piece covering under a pixel (times its brightness) not drawn, nor cast where it covers under a shadow texel; the coarsest shape off by under a pixel. */
  view(scale: ScreenScale): void {
    const mesh = this.mesh, spec = this.spec;
    if (!mesh || this.count === 0 || spec.glows) return;
    const s = scale.at(mesh.boundingSphere!);
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
  }
}

/** One cell's spans' wires: `SPAN_WIRES` instances a span in a block of their own, drawn with the template the view asks for. */
class WireStore {
  private mesh: Mesh | null = null;
  private data = new Float32Array(0);
  private buffer: InstancedInterleavedBuffer | null = null;
  private capacity = 0;
  count = 0;
  private readonly owner: SpanId[] = [];
  private readonly written: number[] = [];
  private whole = false;
  private readonly box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  private sag = 0;
  private boundsMoved = false;
  /** Each template's geometry over these instances, made when first drawn so; all share `sphere`. */
  private levels: (InstancedBufferGeometry | undefined)[] = [];
  private level = 0;
  private readonly sphere = new Sphere();
  private static readonly BLOCK = SPAN_WIRES * WIRE_STRIDE;

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
    // One draw for the cell's wires: a template, and each wire's eight numbers as instances.
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
    const d = this.data, x = this.box;
    for (let i = at; i < at + WireStore.BLOCK; i += WIRE_STRIDE) {
      for (const k of [i, i + 3]) {
        if (d[k]! < x[0]! || d[k + 1]! < x[1]! || d[k + 2]! < x[2]! || d[k]! > x[3]! || d[k + 1]! > x[4]! || d[k + 2]! > x[5]!) {
          x[0] = Math.min(x[0]!, d[k]!); x[1] = Math.min(x[1]!, d[k + 1]!); x[2] = Math.min(x[2]!, d[k + 2]!);
          x[3] = Math.max(x[3]!, d[k]!); x[4] = Math.max(x[4]!, d[k + 1]!); x[5] = Math.max(x[5]!, d[k + 2]!);
          this.boundsMoved = true;
        }
      }
      if (d[i + 6]! > this.sag) { this.sag = d[i + 6]!; this.boundsMoved = true; }
    }
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
      const x = this.box;
      this.sphere.center.set((x[0]! + x[3]!) / 2, (x[1]! + x[4]!) / 2, (x[2]! + x[5]!) / 2);
      this.sphere.radius = Math.hypot(x[3]! - x[0]!, x[4]! - x[1]!, x[5]! - x[2]!) / 2 + this.sag + WIRE_HALF_WIDTH;
      this.boundsMoved = false;
    }
  }

  /** As the camera sees the cell: the template its nearest wire needs (`wireLevel`), none once faded; cast while a texel or wider. */
  view(scale: ScreenScale): void {
    const mesh = this.mesh;
    if (!mesh || this.count === 0) return;
    const level = wireLevel(scale.at(this.sphere), this.sag);
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

/** The poles and wires of one cell of the world's grid (`cellAt`): what the view draws, keeps out of the shadow or coarsens, cell by cell. */
class PoleCell {
  readonly parts: PartStore[];
  readonly wires: WireStore;

  constructor(specs: readonly PolePartSpec[], group: Object3D) {
    this.parts = specs.map((spec) => new PartStore(spec, group));
    this.wires = new WireStore(group);
  }

  get empty(): boolean {
    return this.wires.count === 0 && this.parts.every((part) => part.count === 0);
  }

  flush(): void {
    for (const part of this.parts) part.flush();
    this.wires.flush();
  }

  view(scale: ScreenScale): void {
    for (const part of this.parts) part.view(scale);
    this.wires.view(scale);
  }

  dispose(): void {
    for (const part of this.parts) part.dispose();
    this.wires.dispose();
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

export class PoleLayer implements Utilities {
  readonly group: ViewedRoot;
  private readonly specs: readonly PolePartSpec[];
  /** The cells holding poles or wires, by key. */
  private readonly cells = new Map<number, PoleCell>();
  private readonly poles = new Map<PoleId, PoleState>();
  /** Each span strung here, with its cell and its block there. */
  private readonly spans = new Map<SpanId, { readonly span: UtilitySpan; readonly cell: number; block: number }>();
  /** The poles drawn here by place, and the spans strung to each: what an edit takes away is found here. */
  private readonly index = new PoleIndex();
  private readonly scratch: Placement[][] = Array.from({ length: POLE_PART_COUNT }, () => []);
  private readonly scale = new ScreenScale();

  constructor(kit: SceneryKit, name = 'utilities') {
    this.group = new ViewedRoot((camera) => this.view(camera));
    this.group.name = name;
    this.specs = polePartSpecs(kit);
  }

  get triangles(): number {
    let triangles = 0;
    for (const cell of this.cells.values()) for (const part of cell.parts) triangles += part.perInstance * part.count;
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
    for (const pole of source.poles.values()) if (source.stands?.(pole) ?? true) this.place(net, groundAt, source, pole, undefined);
    for (const span of source.spans.values()) if (source.strings?.(span) ?? true) this.string(span);
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
      if (source.poles.has(id)) for (const s of source.spansAt(id)) if (source.strings?.(s) ?? true) wanted.set(s.id, s);
    }
    for (const sid of strung) this.unstring(sid);
    for (const id of dirty) {
      const was = this.poles.get(id);
      if (was) this.unplace(id, was);
      const pole = source.poles.get(id);
      if (pole && (source.stands?.(pole) ?? true)) this.place(net, groundAt, source, pole, fresh.has(id) || !was || was.x !== pole.x || was.y !== pole.y ? undefined : was.kerb);
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

  /** The cell at a key, made when first needed. */
  private cell(key: number): PoleCell {
    let cell = this.cells.get(key);
    if (!cell) this.cells.set(key, cell = new PoleCell(this.specs, this.group));
    return cell;
  }

  /** A pole framed and its parts placed in its cell; its way to the kerb kept from before, or undefined to read it (`kerbward`). */
  private place(net: Network, groundAt: (x: number, y: number) => number, source: PoleSource,
    pole: UtilityPole, kept: { x: number; y: number } | null | undefined): void {
    const top = groundAt(pole.x, pole.y) + POLE_HEIGHT;
    // Towards the carriageway: the nearest kerb, or null off the streets.
    const kerb = kept !== undefined ? kept : kerbward(net, { x: pole.x, y: pole.y }, m(6));
    // A pole with no wire yet stands square to its street.
    const frame = poleArmsAt(pole, source.spansAt(pole.id), source.poles, () => kerb ?? { x: 0, y: 1 });
    const key = cellAt(pole.x, pole.y);
    const slots: number[][] = Array.from({ length: POLE_PART_COUNT }, () => []);
    if (source.draws?.(pole) ?? true) {
      const out = this.scratch;
      for (const list of out) list.length = 0;
      placePole(pole, top, frame, kerb, groundAt, out);
      const parts = this.cell(key).parts;
      out.forEach((list, part) => { for (const placement of list) slots[part]!.push(parts[part]!.add(pole.id, placement)); });
    }
    this.poles.set(pole.id, { x: pole.x, y: pole.y, top, kerb, frame, cell: key, slots });
    this.index.putPole(pole);
  }

  private unplace(id: PoleId, state: PoleState): void {
    const cell = this.cells.get(state.cell);
    state.slots.forEach((slots, part) => {
      const store = cell?.parts[part];
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

  /** A span's wires, when both its poles stand here, in the cell of its middle; framed as each end frames it. */
  private string(span: UtilitySpan): void {
    if (this.spans.has(span.id)) return;
    const a = this.poles.get(span.a), b = this.poles.get(span.b);
    if (!a || !b) return;
    const key = cellAt((a.x + b.x) / 2, (a.y + b.y) / 2);
    const block = this.cell(key).wires.add(span,
      { x: a.x, y: a.y, top: a.top, arm: a.frame.bySpan.get(span.id) ?? { x: 0, y: 1 } },
      { x: b.x, y: b.y, top: b.top, arm: b.frame.bySpan.get(span.id) ?? { x: 0, y: 1 } });
    this.spans.set(span.id, { span, cell: key, block });
    this.index.putSpan(span);
  }

  private unstring(id: SpanId): void {
    const held = this.spans.get(id);
    if (!held) return;
    const moved = this.cells.get(held.cell)!.wires.remove(held.block);
    if (moved !== null) this.spans.get(moved)!.block = held.block;
    this.spans.delete(id);
    this.index.deleteSpan(held.span);
  }

  /** Every cell's changes sent; a cell left with nothing let go. */
  private flush(): void {
    for (const [key, cell] of this.cells) {
      if (cell.empty) {
        cell.dispose();
        this.cells.delete(key);
      } else cell.flush();
    }
  }

  /** Each cell as this camera sees it, each time three draws the layer: cells walked, not poles or wires. */
  private view(camera: Camera): void {
    this.scale.set(camera);
    wireScreen.uWirePixels.value = screen.halfHeight;
    for (const cell of this.cells.values()) cell.view(this.scale);
  }

  dispose(): void {
    // The instances and the wires are this layer's; the parts' shapes and materials are shared (`PARTS`).
    for (const cell of this.cells.values()) cell.dispose();
    this.cells.clear();
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

import { BoxGeometry, Group, type Frustum, type Material, Matrix4, MeshStandardMaterial, Object3D } from 'three';

import { BARRIER_SIZE, type Barrier } from '@world/barriers';
import type { Change, ChangeJournal, ChangeKind, ChangeRect } from '@world/changes';
import { CellFiling } from '@world/cells';
import { Derived, type DerivedSpec } from '@world/derived';
import type { RoadDoc } from '@world/doc';
import { m } from '@world/units';
import { createInstanceRuns, RunBuilder, sameRun, type Run, type RunStore } from './instanceRuns';

/** DO NOT build every barrier of the map again for one placed or for the ground moved under one */
export interface Barriers {
  readonly group: Group;
  readonly triangles: number;
  /** Brings the barriers up to the diary and the ground; the barriers made again. */
  sync(doc: RoadDoc, groundAt: (x: number, y: number) => number): number;
  /** The parts the camera can see (`InstanceRuns.cull`), every frame. */
  cull(frustum: Frustum, view: Matrix4): void;
  dispose(): void;
}

/** Longest straight piece a run is cut into, world units. */
const PIECE = m(4);
/** Distance between fence posts, world units. */
const POST_STEP = m(2);
/** How far a piece is sunk into the ground, so a slope never shows under it. */
const SINK = m(0.15);

interface Box { x: number; y: number; z: number; yaw: number; length: number; width: number; height: number }

/** The parts, in the order of the layer's stores. */
const KINDS = ['walls', 'copings', 'posts', 'rails', 'hedges', 'steelPosts', 'beams', 'railPosts', 'railBars'] as const;
type PartList = Record<(typeof KINDS)[number], Box[]>;

interface BarrierSource { readonly changes: ChangeJournal; readonly doc: RoadDoc; readonly groundAt: (x: number, y: number) => number }
/** A barrier as drawn: its run and the box its pieces stand in (what a change of the ground there reaches). */
interface BarrierPlace { readonly run: Run; readonly box: ChangeRect; readonly boxes: number }

/** How far round a barrier's points the ground it reads lies (a piece's corners, a margin). */
const READ_REACH = m(1);

class BarrierProduct implements DerivedSpec<BarrierSource, number, BarrierPlace> {
  readonly name = 'barriers';
  readonly kinds: readonly ChangeKind[] = ['barriers', 'terrain', 'elevation', 'ground'];
  readonly byId = false;
  private readonly filing = new CellFiling<number, BarrierPlace>();

  constructor(private readonly stores: readonly RunStore[]) {}

  /** @rebuild Every barrier of the map: read only when everything changed (a load, the diary forgotten). */
  allKeys(source: BarrierSource): Iterable<number> {
    const out: number[] = [];
    for (const id of source.doc.barriers.keys()) out.push(id);
    for (const id of this.filing.ids()) out.push(id);
    return out;
  }

  dirty(change: Change, out: Set<number>, source: BarrierSource): void {
    if (change.rects === null) {
      for (const id of this.allKeys(source)) out.add(id);
      return;
    }
    // Every rectangle of the entry in one look (`barriersInAny`, `idsMeetingAny`): one at a time read the cells they share again.
    for (const barrier of source.doc.barriersInAny(change.rects.map((r) => [r[0] - READ_REACH, r[1] - READ_REACH, r[2] + READ_REACH, r[3] + READ_REACH] as const))) out.add(barrier.id);
    for (const id of this.filing.idsMeetingAny(change.rects)) out.add(id);
  }

  compute(id: number, source: BarrierSource): BarrierPlace | undefined {
    const barrier = source.doc.barriers.get(id as Barrier['id']);
    if (!barrier || barrier.points.length < 2) return undefined;
    const parts = Object.fromEntries(KINDS.map((k) => [k, []])) as unknown as PartList;
    placeBarrier(barrier, source.groundAt, parts);
    const builder = new RunBuilder(this.stores);
    const o = new Object3D();
    let boxes = 0;
    KINDS.forEach((kind, store) => {
      for (const b of parts[kind]) {
        // World y is three's -z, as everywhere in the renderer.
        o.position.set(b.x, b.z + b.height / 2, -b.y);
        o.rotation.set(0, b.yaw, 0);
        o.scale.set(b.length, b.height, b.width);
        o.updateMatrix();
        builder.add(store, o.matrix.elements, Math.max(b.length, b.height, b.width));
        boxes++;
      }
    });
    let box: ChangeRect | null = null;
    for (const q of barrier.points) box = box ? [Math.min(box[0], q.x), Math.min(box[1], q.y), Math.max(box[2], q.x), Math.max(box[3], q.y)] : [q.x, q.y, q.x, q.y];
    const b = box!;
    return { run: builder.build(), box: [b[0] - READ_REACH, b[1] - READ_REACH, b[2] + READ_REACH, b[3] + READ_REACH], boxes };
  }

  equals(a: BarrierPlace, b: BarrierPlace): boolean {
    return a.box.every((v, i) => v === b.box[i]) && sameRun(a.run, b.run);
  }

  changed(id: number, _before: BarrierPlace | undefined, after: BarrierPlace | undefined): void {
    if (after === undefined) this.filing.remove(id);
    else this.filing.file(id, after, after.box);
  }
}

export function createBarriers(): Barriers {
  const { unit, material } = PARTS;
  const names = ['barrier-wall', 'barrier-coping', 'barrier-post', 'barrier-rail', 'barrier-hedge', 'barrier-guardrail-post', 'barrier-guardrail-beam', 'barrier-railing-post', 'barrier-railing-bar'];
  const mats = [material.wall, material.coping, material.post, material.rail, material.hedge, material.guardrailPost, material.guardrailBeam, material.railingPost, material.railingBar];
  const stores: RunStore[] = names.map((name, i) => ({ name, geometry: unit, material: mats[i]!, castShadow: true, receiveShadow: true, tinted: false, cards: false }));
  const runs = createInstanceRuns('barriers', stores, m(4));
  const product = new Derived(new BarrierProduct(stores));
  const drawn = new Map<number, BarrierPlace>();
  let boxes = 0;
  return {
    group: runs.group,
    get triangles() { return boxes * 12; },
    sync(doc, groundAt) {
      const source: BarrierSource = { changes: doc.changes, doc, groundAt };
      const removed: Run[] = [], added: Run[] = [];
      for (const id of product.refresh(source)) {
        const was = drawn.get(id);
        if (was) { removed.push(was.run); boxes -= was.boxes; drawn.delete(id); }
        const now = product.get(id);
        if (now) { added.push(now.run); boxes += now.boxes; drawn.set(id, now); }
      }
      if (removed.length || added.length) runs.update({ removed, added });
      return product.work.last;
    },
    cull(frustum, view) {
      runs.cull(frustum, view);
    },
    // The box and the materials are the module's (`PARTS`): only the instances are this layer's.
    dispose() {
      runs.dispose();
      drawn.clear();
    },
  };
}

/** The unit box and the materials, made ONCE for the module: every rebuild of the barriers */
const PARTS = barrierParts();
function barrierParts(): { unit: BoxGeometry; material: Record<'wall' | 'coping' | 'post' | 'rail' | 'hedge' | 'guardrailPost' | 'guardrailBeam' | 'railingPost' | 'railingBar', Material> } {
  const material = (colour: number, roughness: number, metalness = 0): MeshStandardMaterial =>
    new MeshStandardMaterial({ color: colour, roughness, metalness });
  return {
    unit: new BoxGeometry(1, 1, 1),
    material: {
      wall: material(0xd8d0bf, 0.92),
      coping: material(0xb9b2a4, 0.85),
      post: material(0x4b5153, 0.55, 0.5),
      rail: material(0x4b5153, 0.55, 0.5),
      hedge: material(0x3d6532, 1),
      // Galvanised steel for the road guardrail; painted steel for the railing.
      guardrailPost: material(0x9aa3a6, 0.4, 0.75),
      guardrailBeam: material(0xb4bcbf, 0.32, 0.8),
      railingPost: material(0x2e3a34, 0.5, 0.45),
      railingBar: material(0x2e3a34, 0.5, 0.45),
    },
  };
}

function placeBarrier(barrier: Barrier, groundAt: (x: number, y: number) => number, out: PartList): void {
  if (barrier.kind === 'guardrail' || barrier.kind === 'railing') {
    placeKerbBarrier(barrier, groundAt, out);
    return;
  }
  const size = BARRIER_SIZE[barrier.kind];
  const height = m(size.height);
  const thickness = m(size.thickness);
  let sincePost = Infinity;
  for (let i = 1; i < barrier.points.length; i++) {
    const a = barrier.points[i - 1]!, b = barrier.points[i]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-6) continue;
    const yaw = Math.atan2(b.y - a.y, b.x - a.x);
    const pieces = Math.max(1, Math.ceil(length / PIECE));
    for (let k = 0; k < pieces; k++) {
      const t0 = k / pieces, t1 = (k + 1) / pieces;
      const x0 = a.x + (b.x - a.x) * t0, y0 = a.y + (b.y - a.y) * t0;
      const x1 = a.x + (b.x - a.x) * t1, y1 = a.y + (b.y - a.y) * t1;
      const g0 = groundAt(x0, y0), g1 = groundAt(x1, y1);
      const low = Math.min(g0, g1) - SINK;
      const rise = Math.max(g0, g1) - Math.min(g0, g1);
      const piece = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, yaw, length: length / pieces };
      if (barrier.kind === 'wall') {
        // Overlapping its neighbours by its own thickness, so the corners close.
        out.walls.push({ ...piece, length: piece.length + thickness, z: low, width: thickness, height: height + rise + SINK });
        out.copings.push({ ...piece, length: piece.length + thickness * 1.3, z: Math.max(g0, g1) + height, width: thickness * 1.3, height: m(0.06) });
      } else if (barrier.kind === 'hedge') {
        out.hedges.push({ ...piece, length: piece.length + thickness * 0.5, z: low, width: thickness, height: height + rise + SINK });
      } else {
        const top = Math.max(g0, g1);
        for (const level of [0.35, 0.85]) {
          out.rails.push({ ...piece, z: top + height * level - m(0.03), width: m(0.04), height: m(0.06) });
        }
      }
    }
    if (barrier.kind === 'fence') {
      // Posts along the run, carried over its corners, and one at every corner.
      for (let s = 0; s <= length + 1e-6; s += POST_STEP) {
        if (s > 0 && s < length - 1e-6 && sincePost + s < POST_STEP * 0.5) continue;
        const x = a.x + (b.x - a.x) * (s / length), y = a.y + (b.y - a.y) * (s / length);
        const g = groundAt(x, y);
        out.posts.push({ x, y, yaw, z: g - SINK, length: m(0.08), width: m(0.08), height: height + SINK });
      }
      sincePost = 0;
      const last = barrier.points[barrier.points.length - 1]!;
      if (i === barrier.points.length - 1 && length % POST_STEP > POST_STEP * 0.25) {
        out.posts.push({ x: last.x, y: last.y, yaw, z: groundAt(last.x, last.y) - SINK, length: m(0.08), width: m(0.08), height: height + SINK });
      }
    }
  }
}

/** A road guardrail (a steel W-beam about 0.3 m deep, its top at 0.75 m, on posts every 2 m, as highway standards set it) */
function placeKerbBarrier(barrier: Barrier, groundAt: (x: number, y: number) => number,
  out: { steelPosts: Box[]; beams: Box[]; railPosts: Box[]; railBars: Box[] }): void {
  const guard = barrier.kind === 'guardrail';
  const step = m(guard ? 2 : 1.5);
  for (let i = 1; i < barrier.points.length; i++) {
    const a = barrier.points[i - 1]!, b = barrier.points[i]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-6) continue;
    const yaw = Math.atan2(b.y - a.y, b.x - a.x);
    const pieces = Math.max(1, Math.ceil(length / PIECE));
    for (let k = 0; k < pieces; k++) {
      const t0 = k / pieces, t1 = (k + 1) / pieces;
      const x0 = a.x + (b.x - a.x) * t0, y0 = a.y + (b.y - a.y) * t0;
      const x1 = a.x + (b.x - a.x) * t1, y1 = a.y + (b.y - a.y) * t1;
      const g = Math.max(groundAt(x0, y0), groundAt(x1, y1));
      const piece = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, yaw, length: length / pieces + m(0.02) };
      if (guard) {
        out.beams.push({ ...piece, z: g + m(0.45), width: m(0.08), height: m(0.3) });
      } else {
        out.railBars.push({ ...piece, z: g + m(0.95), width: m(0.05), height: m(0.05) });
        out.railBars.push({ ...piece, z: g + m(0.12), width: m(0.04), height: m(0.04) });
      }
    }
    const posts = Math.max(1, Math.round(length / step));
    for (let k = 0; k <= posts; k++) {
      if (k === 0 && i > 1) continue;
      const t = k / posts;
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
      const g = groundAt(x, y);
      if (guard) out.steelPosts.push({ x, y, yaw, z: g - SINK, length: m(0.15), width: m(0.1), height: m(0.7) + SINK });
      else out.railPosts.push({ x, y, yaw, z: g - SINK, length: m(0.06), width: m(0.06), height: m(1.0) + SINK });
    }
    if (!guard) {
      // Vertical bars between the rails.
      const bars = Math.max(1, Math.round(length / m(0.14)));
      for (let k = 1; k < bars; k++) {
        const t = k / bars;
        const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
        out.railBars.push({ x, y, yaw, z: groundAt(x, y) + m(0.12), length: m(0.02), width: m(0.02), height: m(0.85) });
      }
    }
  }
}

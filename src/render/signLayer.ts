import { BufferAttribute, BufferGeometry, DataTexture, DynamicDrawUsage, Group, Matrix4, Mesh, SRGBColorSpace, Vector3, type Frustum } from 'three';
import type { Change, ChangeJournal, ChangeKind, ChangeRect } from '@world/changes';
import { CellFiling } from '@world/cells';
import { Derived, type DerivedSpec } from '@world/derived';
import type { RoadElevation } from '@world/elevation';
import type { NodeId, SegmentId } from '@world/ids';
import { footwayAt, type LandscapeItem, type SignType } from '@world/landscape';
import type { Network } from '@world/network';
import { signsAtNode } from '@world/roads/derivedSigns';
import { footwayRiseAt } from '@world/roads/footwayRise';
import { sectionOf, LAMP_ZONE } from '@world/section';
import { m } from '@world/units';
import { createInstanceRuns, RunBuilder, warmMeshes, type Run, type RunStore } from './instanceRuns';
import { PLATE, POST, QUAD, QUAD_ORDER, SignSheets, cellUv, onTopOfPost, plateFaces, plateMaterial, streetChain, type Placed, type Sheet } from './signs';

/** DO NOT build every sign of the map again */

/** One plate standing: where, on what ground, what it says, which way it faces. */
interface Stand {
  readonly x: number;
  readonly y: number;
  readonly ground: number;
  readonly type: SignType;
  readonly text: string;
  readonly yaw: number;
}

/** A key's signs and the ground they read: a change there stands them again. */
export interface SignValue {
  readonly stands: readonly Stand[];
  readonly reads: ChangeRect;
}

export interface SignSource {
  readonly changes: ChangeJournal;
  readonly net: Network;
  readonly elevation: RoadElevation;
}

/** How far round a placed sign or a street's name the footway it stands on is looked for (`streetChain`'s reach). */
const ITEM_READS = m(30);

const unite = (a: ChangeRect | null, b: ChangeRect): ChangeRect =>
  a === null ? b : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const around = (x: number, y: number, r: number): ChangeRect => [x - r, y - r, x + r, y + r];
const grow = (r: ChangeRect, pad: number): ChangeRect => [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad];

/** The box a segment's ribbon covers, with its casing and footways. */
function ribbonBox(net: Network, id: SegmentId): ChangeRect | null {
  const ribbon = net.ribbons.get(id);
  if (!ribbon) return null;
  const b = ribbon.full.bbox, pad = ribbon.road.width / 2 + ribbon.road.sidewalk + m(1);
  return [b.minX - pad, b.minY - pad, b.maxX + pad, b.maxY + pad];
}

const isSignItem = (item: LandscapeItem): boolean => item.kind === 'sign' || (item.kind === 'streetname' && !!item.text);

/** A junction's key and a sign item's: one number (`CellFiling` files numbers), even and odd. */
const nodeKey = (id: number): number => id * 2;
const itemKey = (id: number): number => id * 2 + 1;

/** The signs as a product of the diary, key by key: a junction's (`nodeKey`), a placed sign's or a street name's (`itemKey`). */
class SignProduct implements DerivedSpec<SignSource, number, SignValue> {
  readonly name = 'signs';
  /** DO NOT leave it out: the plates of the old standard stood after the style changed. */
  readonly kinds: readonly ChangeKind[] = ['roads', 'terrain', 'landscape', 'elevation', 'markingStyle'];
  readonly byId = false;
  /** Each key holding signs, by the ground it reads. */
  private readonly filing = new CellFiling<number, SignValue>();

  /** @rebuild Every junction and every sign item of the map: read only when everything changed (a load, the diary forgotten). */
  allKeys(source: SignSource): Iterable<number> {
    const out: number[] = [];
    for (const id of source.net.doc.nodes.keys()) out.push(nodeKey(id));
    for (const item of source.net.doc.landscape.values()) if (isSignItem(item)) out.push(itemKey(item.id));
    for (const key of this.filing.ids()) out.push(key);
    return out;
  }

  dirty(change: Change, out: Set<number>, source: SignSource): void {
    if (change.rects === null) {
      for (const key of this.allKeys(source)) out.add(key);
      return;
    }
    const { net } = source;
    // DO NOT stand the junctions round a landscaping entry again
    if (change.kind === 'landscape') {
      // The entry names its items (`RoadDoc.addLandscapeMany`): those, an item's plates reading only its own record.
      if (change.ids) {
        for (const id of change.ids) {
          const item = net.doc.landscape.get(id);
          if (!item || isSignItem(item)) out.add(itemKey(id));
        }
        return;
      }
      // Every rectangle in one look (`idsMeetingAny`, `landscapeInAny`): one at a time read the cells they share again.
      for (const key of this.filing.idsMeetingAny(change.rects)) if (key % 2 === 1) out.add(key);
      for (const item of net.doc.landscapeInAny(change.rects.map((rect) => grow(rect, ITEM_READS)))) if (isSignItem(item)) out.add(itemKey(item.id));
      return;
    }
    // Every rectangle in one look (`idsMeetingAny`, `landscapeInAny`): one at a time read the cells they share again.
    for (const key of this.filing.idsMeetingAny(change.rects)) out.add(key);
    // What may stand now: the junctions at the ends of the segments here, the sign items near.
    for (const id of net.segmentCells.idsMeetingAny(change.rects)) {
      const seg = net.doc.segment(id);
      if (seg) { out.add(nodeKey(seg.a)); out.add(nodeKey(seg.b)); }
    }
    for (const item of net.doc.landscapeInAny(change.rects.map((rect) => grow(rect, ITEM_READS)))) if (isSignItem(item)) out.add(itemKey(item.id));
  }

  compute(key: number, source: SignSource): SignValue | undefined {
    const id = Math.floor(key / 2);
    return key % 2 === 0 ? junctionSigns(source, id as NodeId) : itemSigns(source, id);
  }

  equals(a: SignValue, b: SignValue): boolean {
    if (a.stands.length !== b.stands.length || a.reads.some((v, i) => v !== b.reads[i])) return false;
    return a.stands.every((s, i) => {
      const t = b.stands[i]!;
      return s.x === t.x && s.y === t.y && s.ground === t.ground && s.type === t.type && s.text === t.text && s.yaw === t.yaw;
    });
  }

  changed(key: number, _before: SignValue | undefined, after: SignValue | undefined): void {
    if (after === undefined) this.filing.remove(key);
    else this.filing.file(key, after, after.reads);
  }
}

/** The signs' product, made from nothing at its first refresh. */
export function signProduct(): Derived<SignSource, number, SignValue> {
  return new Derived(new SignProduct());
}

/** A junction's signs (`signsAtNode`), reading its segments' ground. */
function junctionSigns({ net, elevation }: SignSource, node: NodeId): SignValue | undefined {
  const at = net.doc.node(node);
  if (!at) return undefined;
  const stands: Stand[] = [];
  for (const sign of signsAtNode(net, node)) {
    const ground = elevation.onSegment(sign.segment, sign.x, sign.y) + footwayRiseAt(net, sign.x, sign.y);
    stands.push({ x: sign.x, y: sign.y, ground, type: sign.type, text: sign.text, yaw: Math.atan2(sign.facing.x, -sign.facing.y) });
  }
  if (!stands.length) return undefined;
  let reads: ChangeRect = around(at.x, at.y, ITEM_READS);
  for (const seg of at.incident) {
    const box = ribbonBox(net, seg);
    if (box) reads = unite(reads, box);
  }
  return { stands, reads };
}

/** A placed sign's plate, or a street name's plates at both ends of every segment of its street. */
function itemSigns({ net, elevation }: SignSource, id: number): SignValue | undefined {
  const item = net.doc.landscape.get(id);
  if (!item || !isSignItem(item)) return undefined;
  const stands: Stand[] = [];
  let reads: ChangeRect = around(item.x, item.y, ITEM_READS);
  if (item.kind === 'sign') {
    const hit = footwayAt(net, item, m(0.6));
    if (!hit) return { stands, reads };
    const ground = elevation.onSegment(hit.segment, item.x, item.y) + footwayRiseAt(net, item.x, item.y);
    // A traffic sign faces the traffic coming towards it on its side of the street.
    const facing = { x: -hit.frame.t.x * hit.side, y: -hit.frame.t.y * hit.side };
    const type = item.signType ?? 'stop';
    const yaw = type === 'street' || type === 'direction' || type === 'info'
      ? Math.atan2(-hit.frame.n.x * hit.side, hit.frame.n.y * hit.side) // read from the street
      : Math.atan2(facing.x, -facing.y);
    stands.push({ x: item.x, y: item.y, ground, type, text: item.text ?? '', yaw });
    return { stands, reads };
  }
  // The name plates: at both ends of every segment of the named street, on its right-hand footway, beside the corner.
  for (const seg of streetChain(net, item)) {
    const segment = net.doc.segment(seg), ribbon = net.ribbons.get(seg);
    if (!segment || !ribbon) continue;
    const box = ribbonBox(net, seg);
    if (box) reads = unite(reads, box);
    const section = sectionOf(ribbon.road, segment.direction);
    for (const [node, sign] of [[segment.a, 1], [segment.b, -1]] as const) {
      // On the right-hand footway seen from the corner: the road's right from `a`, its left from `b`.
      const zone = (sign > 0 ? section.right : section.left).furnishing;
      const out = zone.inner + Math.min(LAMP_ZONE, Math.max(zone.outer - zone.inner, m(0.2))) / 2;
      if ((net.doc.node(node)?.incident.length ?? 0) < 2) continue;
      const s = sign > 0 ? net.mouthDistance(seg, node) + m(1.5) : ribbon.full.length - net.mouthDistance(seg, node) - m(1.5);
      if (s <= 0 || s >= ribbon.full.length) continue;
      const f = ribbon.full.sampleAt(s);
      const side = sign > 0 ? -1 : 1;
      const x = f.p.x + f.n.x * out * side, y = f.p.y + f.n.y * out * side;
      const ground = elevation.onSegment(seg, x, y) + footwayRiseAt(net, x, y);
      // Parallel to the street, readable from both sides.
      stands.push({ x, y, ground, type: 'street', text: item.text!, yaw: Math.atan2(f.n.x, -f.n.y) });
    }
  }
  return { stands, reads };
}

/** Floats a quad takes: six corners of three (position, normal) or two (uv). */
const QUAD_3 = 18, QUAD_2 = 12;

/** One sheet's plates: quads in slots of one mesh, a free list, grown when full. */
interface PlateStore {
  readonly sheet: Sheet;
  readonly mesh: Mesh;
  capacity: number;
  /** Slots handed out so far (the draw range); free ones below it are zero-area. */
  used: number;
  readonly free: number[];
  /** Each slot's plate, for its uv when the sheet grows. */
  readonly cells: (Placed | null)[];
}

/** What one key stands in the layer: its posts' run and its plates' slots. */
interface Standing {
  readonly run: Run | null;
  readonly plates: readonly { readonly store: PlateStore; readonly slot: number; readonly type: SignType; readonly text: string }[];
}

export interface SignLayerKept {
  readonly group: Group;
  /** Brings the signs up to the diary; the keys stood again. */
  sync(net: Network, elevation: RoadElevation): number;
  /** A post and a plate as the layer draws them, for their programs to be compiled before the first sign stands */
  warm(): Mesh[];
  /** The posts the camera can see (`InstanceRuns.cull`), every frame. */
  cull(frustum: Frustum, view: Matrix4): void;
  dispose(): void;
}

const POST_STORES: RunStore[] = [{
  name: 'sign-posts', geometry: POST.geometry, material: POST.material,
  castShadow: true, receiveShadow: true, tinted: false, cards: false,
}];

export function createSignLayer(): SignLayerKept {
  const group = new Group();
  group.name = 'signs';
  const posts = createInstanceRuns('sign-posts', POST_STORES, m(4));
  group.add(posts.group);
  const stores = new Map<Sheet, PlateStore>();
  const sheets = new SignSheets({
    // A sheet grown: the uv of its plates moved (the sheet is taller), written again, that sheet's alone.
    grown: (sheet) => { const store = stores.get(sheet); if (store) rewriteUv(store); },
    gone: (sheet) => {
      const store = stores.get(sheet);
      if (!store) return;
      group.remove(store.mesh);
      store.mesh.geometry.dispose();
      stores.delete(sheet);
    },
  });
  const product = signProduct();
  /** The plate the programs are compiled ahead with (`warm`), made with the layer and kept while it is */
  const warmPicture = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  warmPicture.colorSpace = SRGBColorSpace;
  warmPicture.needsUpdate = true;
  const warmMaterial = plateMaterial(warmPicture);
  const standing = new Map<number, Standing>();
  // Scratch, one for the layer (never one per post or per plate).
  const matrix = new Matrix4(), corner = new Vector3(), scale = new Vector3();

  const storeOf = (sheet: Sheet): PlateStore => {
    let store = stores.get(sheet);
    if (store) return store;
    const geometry = new BufferGeometry();
    const mesh = new Mesh(geometry, sheet.material);
    mesh.name = 'sign-plates';
    mesh.castShadow = true;
    // A sphere round the whole map rejects nothing; the plates are small and few next to the town.
    mesh.frustumCulled = false;
    store = { sheet, mesh, capacity: 0, used: 0, free: [], cells: [] };
    stores.set(sheet, store);
    sized(store, 64);
    group.add(mesh);
    return store;
  };
  /** The store's arrays at `capacity` quads, the slots in use copied over: a buffer does not change size (three.js manual, "How to update things"). */
  const sized = (store: PlateStore, capacity: number): void => {
    const old = store.mesh.geometry;
    const position = new Float32Array(capacity * QUAD_3), normal = new Float32Array(capacity * QUAD_3), uv = new Float32Array(capacity * QUAD_2);
    if (store.capacity > 0) {
      position.set((old.getAttribute('position') as BufferAttribute).array as Float32Array);
      normal.set((old.getAttribute('normal') as BufferAttribute).array as Float32Array);
      uv.set((old.getAttribute('uv') as BufferAttribute).array as Float32Array);
    }
    const geometry = new BufferGeometry();
    for (const [name, array, size] of [['position', position, 3], ['normal', normal, 3], ['uv', uv, 2]] as const) {
      geometry.setAttribute(name, new BufferAttribute(array, size).setUsage(DynamicDrawUsage));
    }
    geometry.setDrawRange(0, store.used * 6);
    old.dispose();
    store.mesh.geometry = geometry;
    store.capacity = capacity;
  };
  const touch = (store: PlateStore, slot: number): void => {
    const g = store.mesh.geometry;
    for (const [name, n] of [['position', QUAD_3], ['normal', QUAD_3], ['uv', QUAD_2]] as const) {
      const a = g.getAttribute(name) as BufferAttribute;
      a.addUpdateRange(slot * n, n);
      a.needsUpdate = true;
    }
  };
  const writeUv = (store: PlateStore, slot: number, placed: Placed): void => {
    const uv = (store.mesh.geometry.getAttribute('uv') as BufferAttribute).array as Float32Array;
    const c = cellUv(placed);
    QUAD_ORDER.forEach((i, k) => {
      uv[slot * QUAD_2 + k * 2] = QUAD[i]![0] < 0 ? c.u0 : c.u1;
      uv[slot * QUAD_2 + k * 2 + 1] = QUAD[i]![1] < 0 ? c.v0 : c.v1;
    });
  };
  /** @rebuild A sheet grown (its rows doubled, a handful of times in a town's life): its plates' uv written again. */
  const rewriteUv = (store: PlateStore): void => {
    store.cells.forEach((placed, slot) => { if (placed) writeUv(store, slot, placed); });
    const a = store.mesh.geometry.getAttribute('uv') as BufferAttribute;
    a.clearUpdateRanges();
    a.needsUpdate = true;
  };
  const putQuad = (placed: Placed, face: { x: number; y: number; yaw: number }, ground: number, type: SignType): { store: PlateStore; slot: number } => {
    const store = storeOf(placed.sheet);
    let slot = store.free.pop();
    if (slot === undefined) {
      if (store.used === store.capacity) sized(store, Math.ceil(store.capacity * 1.5) + 512);
      slot = store.used++;
      store.mesh.geometry.setDrawRange(0, store.used * 6);
    }
    const size = PLATE[type];
    const g = store.mesh.geometry;
    const position = (g.getAttribute('position') as BufferAttribute).array as Float32Array;
    const normal = (g.getAttribute('normal') as BufferAttribute).array as Float32Array;
    // The quad of the plane of 1 x 1, turned and sized as `buildSigns` turned it.
    matrix.makeRotationY(face.yaw).scale(scale.set(m(size.w), m(size.h), 1)).setPosition(face.x, ground + m(size.z), -face.y);
    QUAD_ORDER.forEach((i, k) => {
      corner.set(QUAD[i]![0], QUAD[i]![1], 0).applyMatrix4(matrix);
      position[slot * QUAD_3 + k * 3] = corner.x; position[slot * QUAD_3 + k * 3 + 1] = corner.y; position[slot * QUAD_3 + k * 3 + 2] = corner.z;
      normal[slot * QUAD_3 + k * 3] = Math.sin(face.yaw); normal[slot * QUAD_3 + k * 3 + 1] = 0; normal[slot * QUAD_3 + k * 3 + 2] = Math.cos(face.yaw);
    });
    store.cells[slot] = placed;
    writeUv(store, slot, placed);
    touch(store, slot);
    return { store, slot };
  };
  const freeQuad = (store: PlateStore, slot: number): void => {
    const g = store.mesh.geometry;
    // Zero area: drawn as nothing until the slot is taken again.
    ((g.getAttribute('position') as BufferAttribute).array as Float32Array).fill(0, slot * QUAD_3, (slot + 1) * QUAD_3);
    store.cells[slot] = null;
    store.free.push(slot);
    touch(store, slot);
  };
  const take = (key: number): Run | null => {
    const was = standing.get(key);
    if (!was) return null;
    standing.delete(key);
    for (const plate of was.plates) {
      if (stores.get(plate.store.sheet) === plate.store) freeQuad(plate.store, plate.slot);
      sheets.drop(plate.type, plate.text);
    }
    return was.run;
  };
  const stand = (key: number, value: SignValue): Run | null => {
    const builder = new RunBuilder(POST_STORES);
    const plates: Standing['plates'][number][] = [];
    for (const s of value.stands) {
      const size = PLATE[s.type];
      // Up to the plate's top behind it; up to its bottom under a plate on top of it.
      const top = m(size.z + (onTopOfPost(s.type) ? -size.h / 2 : size.h / 2));
      builder.turned(0, s.x, s.ground + top / 2, -s.y, 0, 1, top, 1, Math.max(1, top));
      const placed = sheets.take(s.type, s.text);
      for (const face of plateFaces(s.type, s.x, s.y, s.yaw)) {
        // The sheet may have been let go and made again since `take`: the store of the plate's sheet now.
        const { store, slot } = putQuad(placed, face, s.ground, s.type);
        plates.push({ store, slot, type: s.type, text: s.text });
      }
    }
    const run = value.stands.length ? builder.build() : null;
    standing.set(key, { run, plates });
    return run;
  };

  return {
    group,
    sync(net, elevation) {
      if (typeof document === 'undefined') return 0;
      const source: SignSource = { changes: net.doc.changes, net, elevation };
      const removed: Run[] = [], added: Run[] = [];
      for (const key of product.refresh(source)) {
        const gone = take(key);
        if (gone) removed.push(gone);
        const value = product.get(key);
        if (value) { const run = stand(key, value); if (run) added.push(run); }
      }
      if (removed.length || added.length) posts.update({ removed, added });
      return product.work.last;
    },
    warm() {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(QUAD_3), 3));
      geometry.setAttribute('normal', new BufferAttribute(new Float32Array(QUAD_3), 3));
      geometry.setAttribute('uv', new BufferAttribute(new Float32Array(QUAD_2), 2));
      const plate = new Mesh(geometry, warmMaterial);
      plate.name = 'sign-plates';
      plate.castShadow = true;
      plate.frustumCulled = false;
      return [...warmMeshes(POST_STORES), plate];
    },
    cull(frustum, view) {
      posts.cull(frustum, view);
    },
    dispose() {
      warmMaterial.dispose();
      warmPicture.dispose();
      posts.dispose();
      for (const store of stores.values()) store.mesh.geometry.dispose();
      stores.clear();
      sheets.dispose();
      standing.clear();
      group.clear();
    },
  };
}

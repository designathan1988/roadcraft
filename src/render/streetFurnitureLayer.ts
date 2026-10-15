import { Color, Group, Object3D, type Frustum, type InstancedMesh, type Matrix4, type MeshDepthMaterial } from 'three';

import { Rng } from '@core/rng';
import { angleOf } from '@core/vec2';
import type { Change, ChangeJournal, ChangeKind } from '@world/changes';
import { CellFiling, grow } from '@world/cells';
import { Derived, type DerivedSpec } from '@world/derived';
import type { RoadElevation } from '@world/elevation';
import { ACCESS_REACH, GROW_MINUTES, MAX_ITEM_RADIUS, plantGrowth, type LandscapeItem } from '@world/landscape';
import type { Network } from '@world/network';
import { footwayRiseAt } from '@world/roads/footwayRise';
import { FOOTWAY_RISE } from '@world/roadTypes';
import { furnitureOf } from '@world/streetFurniture';
import { m } from '@world/units';
import { CLUMP_READ_REACH, grassClump, type Tuft } from './grass';
import { RunBuilder, createInstanceRuns, sameRun, warmMeshes, type Run, type RunStore } from './instanceRuns';
import { BUSH_KINDS, TREE_SPECIES, type BushKind, type TreeSpecies } from './propGeometry';
import { LAMP_BEAM_RADIUS, LAMP_HEIGHT, LAMP_OUTREACH, LAMP_POOL_RADIUS, POOL_ALONG, SHADOW_REACH, foliageTint, type SceneryKit } from './scenery';

/** DO NOT go back to that: one bench placed paid for every bench of the city. */

/** Street trees are pollarded smaller than a tree in open ground. */
const STREET_TREE_MIN = m(6.5);
const STREET_TREE_RANGE = m(3);

/** How far a placed item stands from what moves it: a road within reach of its footway and of the crossings near it. */
const ROAD_REACH = ACCESS_REACH + MAX_ITEM_RADIUS + m(1);
/** Its deck's height read at its point. */
const DECK_REACH = m(1);

/** The furniture's stores, in the order the scenery's meshes were made. */
const FURNITURE_MODELS = ['lamp', 'lens', 'pool', 'beam', 'bin', 'bench', 'hydrant', 'postbox', 'phone', 'drain', 'treePit'] as const;
type FurnitureModel = (typeof FURNITURE_MODELS)[number];
const MODEL = Object.fromEntries(FURNITURE_MODELS.map((model, i) => [model, i])) as Record<FurnitureModel, number>;

/** One instance of a placed item: its store, where, how turned and sized, its tint. */
interface Placed {
  readonly store: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  readonly tint: Color | null;
  /** A plant: its full height, times its growth; `sx`, `sy`, `sz` are then times the height it has. 0: it does not grow. */
  readonly h: number;
}

/** A placed item as it stands: its instances, where it is (its filing), when it was planted. */
interface FurniturePlace {
  readonly x: number;
  readonly y: number;
  readonly planted: number | undefined;
  readonly placed: readonly Placed[];
}

/** What the layer is refreshed from: the diary it reads, and the roads and their heights it places on. */
interface FurnitureSource {
  readonly changes: ChangeJournal;
  readonly net: Network;
  readonly elevation: RoadElevation;
  readonly groundAt: (x: number, y: number) => number;
}

/** The meshes of the furniture and the street plants: the stores, and where each plant's body and cards are. */
function furnitureStores(kit: SceneryKit): { stores: RunStore[]; trees: Record<TreeSpecies, readonly number[]>; bushes: Record<BushKind, readonly number[]> } {
  const prop = (name: string, geometry: RunStore['geometry'], material: RunStore['material'], castShadow = true, receiveShadow = true, renderOrder?: number): RunStore =>
    ({ name, geometry, material, castShadow, receiveShadow, ...(renderOrder !== undefined ? { renderOrder } : {}), tinted: false, cards: false });
  const f = kit.furniture;
  const stores: RunStore[] = [
    prop('street-lights', f.lamp, kit.props),
    // The lens is lit from inside; it neither casts nor takes a shadow.
    prop('street-light-lamps', kit.lampLens, kit.glow, false),
    prop('street-light-pools', kit.pool, kit.poolGlow, false, false, 3),
    prop('street-light-beams', kit.beam, kit.beamGlow, false, false, 4),
    prop('street-bins', f.bin, kit.props),
    prop('benches', f.bench, kit.props),
    prop('hydrants', f.hydrant, kit.props),
    prop('post-boxes', f.postbox, kit.props),
    prop('phones', f.phone, kit.props),
    prop('drains', f.drain, kit.props),
    prop('tree-pits', kit.treePit, kit.props, false),
  ];
  const plant = (name: string, body: RunStore['geometry'], material: RunStore['material'], depth: MeshDepthMaterial,
    cards: RunStore['geometry'] | undefined, cardMaterial: RunStore['material'], cardDepth: MeshDepthMaterial): number[] => {
    const at = [stores.length];
    stores.push({ name, geometry: body, material, depth, castShadow: true, receiveShadow: true, tinted: true, cards: false });
    if (cards) {
      at.push(stores.length);
      // The crown's heart throws the plant's shadow; alpha-cut cards in the shadow pass cost 70 ms a frame.
      stores.push({ name: `${name}-cards`, geometry: cards, material: cardMaterial, depth: cardDepth, castShadow: false, receiveShadow: true, tinted: true, cards: true });
    }
    return at;
  };
  const trees = Object.fromEntries(TREE_SPECIES.map((s) => [s,
    plant(`street-trees-${s}`, kit.trees[s], kit.foliage, kit.foliageDepth, kit.cards[s], kit.treeCards, kit.treeCardsDepth)])) as Record<TreeSpecies, number[]>;
  const bushes = Object.fromEntries(BUSH_KINDS.map((k) => [k,
    plant(`street-bushes-${k}`, kit.bushes[k], kit.shrubs, kit.shrubsDepth, kit.cards[k], kit.shrubCards, kit.shrubCardsDepth)])) as Record<BushKind, number[]>;
  return { stores, trees, bushes };
}

/** Picks a species for a street tree: mostly planes, some flowering ipês. */
function streetSpecies(roll: number): TreeSpecies {
  if (roll < 0.55) return 'broadleafTall';
  if (roll < 0.78) return 'broadleaf';
  return roll < 0.89 ? 'ipeYellow' : 'ipePink';
}

/** Where a placed item's instances stand, or undefined when it draws nothing */
function furniturePlace(net: Network, elevation: RoadElevation, placed: LandscapeItem, kit: SceneryKit,
  trees: Record<TreeSpecies, readonly number[]>, bushes: Record<BushKind, readonly number[]>): FurniturePlace | undefined {
  const item = furnitureOf(net, placed);
  if (!item) return undefined;
  const out: Placed[] = [];
  const put = (store: number, p: Omit<Placed, 'store' | 'tint' | 'h'> & { tint?: Color; h?: number }): void => {
    out.push({ store, x: p.x, y: p.y, z: p.z, yaw: p.yaw, sx: p.sx, sy: p.sy, sz: p.sz, tint: p.tint ?? null, h: p.h ?? 0 });
  };
  // On the item's OWN road.
  const base = elevation.onSegment(item.segment, item.x, item.y) + footwayRiseAt(net, item.x, item.y);
  // Local +X of a lamp reaches over the road; local -Z of a bench, a post box or a hydrant turns its back on the road.
  const inward = angleOf({ x: -item.outward.x, y: -item.outward.y });
  const facing = angleOf({ x: item.outward.y, y: -item.outward.x });
  const at = { x: item.x, y: item.y, z: base, sx: 1, sy: 1, sz: 1 };
  const lens = kit.lens;
  switch (item.kind) {
    case 'lamp': {
      put(MODEL.lamp, { ...at, yaw: inward });
      put(MODEL.lens, { ...at, yaw: inward });
      // The light falls over the road and the footway behind the lamp: across, the carriageway's width
      const road = net.ribbons.get(item.segment)?.road;
      const across = Math.max(LAMP_POOL_RADIUS, (road ? road.width : m(7)) * 0.55 + m(2.5));
      const centre = Math.max(LAMP_OUTREACH * 0.85, across - m(3));
      put(MODEL.pool, { x: item.x - item.outward.x * centre, y: item.y - item.outward.y * centre, z: base + m(0.012),
        yaw: inward, sx: across, sy: 1, sz: LAMP_HEIGHT * POOL_ALONG });
      // And the cone it is lit by, from the lens down to the road under it.
      put(MODEL.beam, { x: item.x - item.outward.x * lens.reach, y: item.y - item.outward.y * lens.reach, z: base + lens.height,
        yaw: 0, sx: LAMP_BEAM_RADIUS, sy: lens.height + FOOTWAY_RISE, sz: LAMP_BEAM_RADIUS });
      break;
    }
    case 'bin':
      put(MODEL.bin, { ...at, yaw: item.seed * Math.PI * 2 });
      break;
    case 'bench': {
      // Its seat faces where the layout says somebody sitting looks.
      const faces = item.faces ?? { x: -item.outward.x, y: -item.outward.y };
      put(MODEL.bench, { ...at, yaw: angleOf({ x: -faces.y, y: faces.x }) });
      break;
    }
    case 'postbox':
    case 'hydrant':
    case 'phone':
    case 'drain':
      // Built facing -Z; turned so the phone's shell opens to the footway and the drain's grate lies in the gutter on the road
      put(MODEL[item.kind], { ...at, yaw: facing + Math.PI });
      break;
    case 'streetTree': {
      put(MODEL.treePit, { ...at, yaw: angleOf(item.along) });
      // Planted young, it grows to its full height over a few days.
      const rng = new Rng(Math.floor(item.seed * 0xffffff));
      const species = streetSpecies(rng.float());
      const tree = { x: item.x, y: item.y, z: base + m(0.03), yaw: rng.float() * Math.PI * 2,
        sx: 0.85 + rng.float() * 0.2, sy: 1, sz: 0.85 + rng.float() * 0.2, tint: foliageTint(rng), h: STREET_TREE_MIN + item.seed * STREET_TREE_RANGE };
      for (const store of trees[species]) put(store, tree);
      break;
    }
    case 'shrub': {
      const rng = new Rng(Math.floor(item.seed * 0xffffff));
      const h = m(0.8) + rng.float() * m(0.4);
      const kind: BushKind = rng.float() < 0.4 ? 'bushFlowering' : 'bush';
      const shrub = { x: item.x, y: item.y, z: base - m(0.05), yaw: rng.float() * Math.PI * 2, sx: 1.05, sy: 1, sz: 1.05, tint: foliageTint(rng), h };
      for (const store of bushes[kind]) put(store, shrub);
      break;
    }
  }
  return { x: placed.x, y: placed.y, planted: item.planted, placed: out };
}

const sameColour = (a: Color | null, b: Color | null): boolean =>
  a === b || (a !== null && b !== null && a.r === b.r && a.g === b.g && a.b === b.b);
function samePlace(a: FurniturePlace, b: FurniturePlace): boolean {
  if (a.planted !== b.planted || a.x !== b.x || a.y !== b.y || a.placed.length !== b.placed.length) return false;
  for (let i = 0; i < a.placed.length; i++) {
    const p = a.placed[i]!, q = b.placed[i]!;
    if (p.store !== q.store || p.x !== q.x || p.y !== q.y || p.z !== q.z || p.yaw !== q.yaw || p.sx !== q.sx || p.sy !== q.sy
      || p.sz !== q.sz || p.h !== q.h || !sameColour(p.tint, q.tint)) return false;
  }
  return true;
}

/** Placed items of some kinds as a product of the diary, key by key (the item's id) */
class PlacedProduct<V extends { readonly x: number; readonly y: number }> implements DerivedSpec<FurnitureSource, number, V> {
  readonly byId = false;
  readonly kinds: readonly ChangeKind[];
  /** The items holding a value, by place: the ones a change reaches, gone from the document or not. */
  private readonly filing = new CellFiling<number, V>();

  constructor(
    readonly name: string,
    private readonly pads: Readonly<Partial<Record<ChangeKind, number>>>,
    private readonly wanted: (item: LandscapeItem) => boolean,
    private readonly make: (item: LandscapeItem, source: FurnitureSource) => V | undefined,
    readonly equals: (a: V, b: V) => boolean,
  ) {
    this.kinds = Object.keys(pads) as ChangeKind[];
  }

  /** @rebuild The document's items of the product's kinds: read only when everything changed (a load, the diary forgotten). */
  allKeys(source: FurnitureSource): Iterable<number> {
    const out: number[] = [];
    for (const item of source.net.doc.landscape.values()) if (this.wanted(item)) out.push(item.id);
    for (const id of this.filing.ids()) out.push(id);
    return out;
  }

  dirty(change: Change, out: Set<number>, source: FurnitureSource): void {
    if (change.rects === null) {
      for (const id of this.allKeys(source)) out.add(id);
      return;
    }
    // DO NOT look round each of an entry's rectangles
    if (change.kind === 'landscape' && change.ids) {
      for (const id of change.ids) {
        const item = source.net.doc.landscape.get(id);
        if (!item || this.wanted(item)) out.add(id);
      }
      return;
    }
    const pad = this.pads[change.kind] ?? 0;
    // All the entry's rectangles in one look each (`landscapeInAny`, `idsMeetingAny`)
    const areas = change.rects.map((rect) => grow(rect, pad));
    for (const item of source.net.doc.landscapeInAny(areas)) if (this.wanted(item)) out.add(item.id);
    for (const id of this.filing.idsMeetingAny(areas)) out.add(id);
  }

  compute(key: number, source: FurnitureSource): V | undefined {
    const item = source.net.doc.landscape.get(key);
    return item && this.wanted(item) ? this.make(item, source) : undefined;
  }

  changed(key: number, _before: V | undefined, after: V | undefined): void {
    if (after === undefined) this.filing.remove(key);
    else this.filing.file(key, after, [after.x, after.y, after.x, after.y]);
  }
}

/** A placed item's grass: its clump's tufts and flowers as one run. */
interface MeadowPlace {
  readonly x: number;
  readonly y: number;
  readonly run: Run;
}

/** The furniture's product: where each placed item stands (a product of the diary), proved against one made from nothing. */
export function furnitureProduct(kit: SceneryKit): Derived<FurnitureSource, number, FurniturePlace> {
  const { trees, bushes } = furnitureStores(kit);
  return new Derived(new PlacedProduct<FurniturePlace>('street furniture', {
    landscape: 0, roads: ROAD_REACH, elevation: DECK_REACH,
  }, (item) => item.kind !== 'meadow' && item.kind !== 'sign' && item.kind !== 'streetname',
  (item, source) => furniturePlace(source.net, source.elevation, item, kit, trees, bushes), samePlace));
}

const MEADOW_STORES = (kit: SceneryKit): RunStore[] => [
  { name: 'grass-tufts', geometry: kit.tuft, material: kit.grass, castShadow: false, receiveShadow: true, tinted: true, cards: false },
  { name: 'wildflowers', geometry: kit.flower, material: kit.flowers, castShadow: false, receiveShadow: true, tinted: true, cards: false },
];

/** The long grass's product: each placed clump's run, laid on the ground as drawn. */
export function meadowProduct(kit: SceneryKit): Derived<FurnitureSource, number, MeadowPlace> {
  const stores = MEADOW_STORES(kit);
  const object = new Object3D();
  return new Derived(new PlacedProduct<MeadowPlace>('long grass', {
    landscape: 0, elevation: CLUMP_READ_REACH + m(1), ground: CLUMP_READ_REACH + m(1),
  }, (item) => item.kind === 'meadow', (item, source) => {
    const clump = grassClump(source.elevation, source.groundAt, item);
    const builder = new RunBuilder(stores);
    const add = (store: number, tuft: Tuft): void => {
      object.position.set(tuft.x, tuft.z, -tuft.y);
      object.rotation.set(0, tuft.yaw, 0);
      object.scale.set(tuft.height * tuft.width, tuft.height, tuft.height * tuft.width);
      object.updateMatrix();
      builder.add(store, object.matrix.elements, tuft.height * Math.max(1, tuft.width), tuft.tint);
    };
    for (const tuft of clump.tufts) add(0, tuft);
    for (const tuft of clump.flowers) add(1, tuft);
    return { x: item.x, y: item.y, run: builder.build() };
  }, (a, b) => a.x === b.x && a.y === b.y && sameRun(a.run, b.run)));
}

/** The street furniture and the long grass, kept item by item. */
export interface StreetFurnitureLayer {
  /** The furniture and the street plants: their visibility is set every frame by the zoom. */
  readonly group: Group;
  readonly meshes: readonly InstancedMesh[];
  /** The long grass, drawn at every zoom (as it was). */
  readonly grass: Group;
  readonly triangles: number;
  /** Brought up to the diary: the items an entry of their kinds reached are placed again */
  /** Brings the furniture and the long grass up to the diary (and the hour); the items computed (the engine's ledger, `core/engine.ts`). */
  sync(net: Network, elevation: RoadElevation, groundAt: (x: number, y: number) => number, minutes: number): number;
  setMap(map: boolean): void;
  /** A mesh of each of its stores, as it draws them */
  warm(): InstancedMesh[];
  cull(frustum: Frustum, view: Matrix4): void;
  dispose(): void;
}

/** Whether a plant planted then is still growing at `minutes` (unknown while the clock is). */
const stillGrowing = (planted: number | undefined, minutes: number): boolean =>
  planted !== undefined && !(Number.isFinite(minutes) && minutes - planted >= GROW_MINUTES);

export function createStreetFurniture(kit: SceneryKit): StreetFurnitureLayer {
  const { stores } = furnitureStores(kit);
  const furniture = createInstanceRuns('street-furniture', stores, SHADOW_REACH);
  // The grass throws no shadow: only what the view itself takes.
  const meadowStores = MEADOW_STORES(kit);
  const meadow = createInstanceRuns('grass', meadowStores, 0);
  const places = furnitureProduct(kit);
  const clumps = meadowProduct(kit);
  /** Each item's run as drawn, and the growth it was sized at. */
  const runs = new Map<number, { readonly place: FurniturePlace; readonly run: Run }>();
  const clumpRuns = new Map<number, Run>();
  /** The items with a plant still growing: sized again each city hour. */
  const growing = new Set<number>();
  let hour = Number.NaN;
  const object = new Object3D();

  /** An item's instances at the city's time (the hour's start: the same whenever it is made in that hour). */
  const runOf = (place: FurniturePlace, now: number): Run => {
    const builder = new RunBuilder(stores);
    const growth = plantGrowth(place.planted, now);
    for (const p of place.placed) {
      let sx = p.sx, sy = p.sy, sz = p.sz;
      if (p.h > 0) {
        const height = p.h * growth;
        sx = height * p.sx; sy = height * p.sy; sz = height * p.sz;
      }
      object.position.set(p.x, p.z, -p.y);
      object.rotation.set(0, p.yaw, 0);
      object.scale.set(sx, sy, sz);
      object.updateMatrix();
      builder.add(p.store, object.matrix.elements, Math.max(sx, sy, sz), p.tint ?? undefined);
    }
    return builder.build();
  };

  return {
    group: furniture.group,
    get meshes() { return furniture.meshes; },
    grass: meadow.group,
    get triangles() { return furniture.triangles + meadow.triangles; },
    sync(net, elevation, groundAt, minutes) {
      const source: FurnitureSource = { changes: net.doc.changes, net, elevation, groundAt };
      const nowHour = Number.isFinite(minutes) ? Math.floor(minutes / 60) : Number.NaN;
      const now = nowHour * 60;
      const removed: Run[] = [], added = new Set<Run>();
      const place = (id: number): void => {
        const was = runs.get(id);
        // DO NOT hand the stores a run to take away in the change that puts it in.
        if (was) { if (!added.delete(was.run)) removed.push(was.run); runs.delete(id); }
        growing.delete(id);
        const value = places.get(id);
        if (!value) return;
        const run = runOf(value, now);
        runs.set(id, { place: value, run });
        added.add(run);
        if (stillGrowing(value.planted, now)) growing.add(id);
      };
      for (const id of places.refresh(source)) place(id);
      let work = places.work.last;
      // A new hour: the plants still growing sized again (and only those).
      if (!Object.is(nowHour, hour)) {
        hour = nowHour;
        for (const id of [...growing]) { place(id); work++; }
      }
      if (removed.length || added.size) furniture.update({ removed, added: [...added] });
      const gone: Run[] = [], grown: Run[] = [];
      for (const id of clumps.refresh(source)) {
        const was = clumpRuns.get(id);
        if (was) { gone.push(was); clumpRuns.delete(id); }
        const value = clumps.get(id);
        if (value) { clumpRuns.set(id, value.run); grown.push(value.run); }
      }
      if (gone.length || grown.length) meadow.update({ removed: gone, added: grown });
      return work + clumps.work.last;
    },
    setMap(map) {
      furniture.setMap(map);
    },
    warm() {
      return warmMeshes([...stores, ...meadowStores]);
    },
    cull(frustum, view) {
      furniture.cull(frustum, view);
      meadow.cull(frustum, view);
    },
    dispose() {
      furniture.dispose();
      meadow.dispose();
    },
  };
}

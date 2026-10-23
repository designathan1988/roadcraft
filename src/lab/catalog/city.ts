import {
  Group as GroupClass, InstancedMesh as InstancedMeshClass, LineSegments as LineSegmentsClass, Mesh as MeshClass, Points as PointsClass,
  type BufferGeometry, type Camera, type InstancedMesh, type Material, type Object3D,
} from 'three';
import { createBuildingKit } from '../../render/buildings/kit';
import { buildBuildingMeshes } from '../../render/buildings/buildingMesh';
import { createSceneryKit } from '../../render/scenery';
import { buildPolePreview } from '../../render/poleLayer';
import { buildTrackPreview } from '../../render/transit';
import { agentHash } from '../../render/agents';
import { carStyleOf } from '../../render/carBody';
import { axleStations } from '../../render/vehicleModels';
import { streetSpecies } from '../../render/streetFurnitureLayer';
import { BUSH_KINDS, TREE_SPECIES } from '../../render/propGeometry';
import { Rng } from '@core/rng';
import { placeKey, take, type BatchCache } from './capture';
import { drawnTriangles } from './measure';
import { furnitureOf } from '@world/streetFurniture';
import { buildingBounds, buildingHeight } from '@world/buildings/geometry';
import type { Building } from '@world/buildings/types';
import { Network } from '@world/network';
import { RoadDoc } from '@world/doc';
import type { SimClient } from '@sim/host/simClient';
import { LAYER_SWITCHES, BUILDING_SWITCHES } from '../../render/effectSwitches';
import type { ItemSpec, PieceSpec } from './items';

/** THE TEST CITY: the buildings' records the kit builds on its own (three sizes of each kind), the editor's previews, what depends on the city's layout,
 *  how many copies of each object the city holds, every group's draw calls, and the destruction's peak (`scripts/model-catalog.mjs`). */

type Add = (spec: ItemSpec) => void;

/** How many copies of an object the test city holds and where that was read; `triangles` when its total was summed copy by copy (buildings of different sizes). */
export interface CountEntry { readonly n: number; readonly from: string; readonly triangles?: number }

export interface GameProbe {
  readonly doc: RoadDoc;
  readonly net: Network;
  readonly sim: SimClient;
  scene(): {
    readonly scene: Object3D;
    readonly stats: { readonly drawCalls: number; readonly drawnTriangles: number };
    strikeBuilding(b: Building, x: number, y: number, z: number, strength: number): boolean;
    explode(x: number, y: number, z: number, radius: number, hit: unknown): void;
    /** Everybody drawn last frame and the body the casting gave them (`renderer.ts` census). */
    census(): readonly { readonly seed: number; readonly model: string; readonly company: string }[];
    /** The camera the frame is drawn from. */
    viewCamera(): Camera;
  };
  variant(fx?: Record<string, boolean> | null): void;
  redraw(): void;
  setView(at: { x: number; y: number; zoom: number; azimuth: number; elevation: number }): void;
}

export const probe = (): GameProbe => (window as unknown as { __roadcraft: GameProbe }).__roadcraft;

/** A building's floors: its height over its storey. */
const floorsOf = (b: Building): number => Math.max(1, Math.round(buildingHeight(b) / Math.max(0.5, b.storeyHeight)));
/** The kind a building is counted by: its blueprint, else its function, else its use. */
const kindOf = (b: Building): string => b.blueprint ?? (b.function ? `function ${b.function}` : `use ${b.use}`);

/** Every mesh of a building's model as pieces, an instanced part's copies counted. */
function buildingPieces(root: Object3D): PieceSpec[] {
  const out: PieceSpec[] = [];
  root.traverse((o) => {
    const holder = o as Object3D & { geometry?: BufferGeometry; material?: Material | Material[]; isInstancedMesh?: boolean };
    if (!holder.geometry) return;
    const copies = holder.isInstancedMesh ? (o as InstancedMesh).count : 1;
    if (copies === 0) return;
    out.push({ label: o.name || o.type, geometry: holder.geometry, material: holder.material ?? null, copies });
  });
  return out;
}

/** One building of the test city built alone by the kit at its detail level: its triangles (an instanced part's copies counted) and vertices. */
export interface BuildingMeasure { readonly id: number; readonly kind: string; readonly floors: number; readonly size: string; readonly triangles: number; readonly vertices: number }

/** A built building's triangles and vertices, every mesh of it, an instanced part's copies counted; each part model's and furniture kind's copies added to `parts`. */
function builtSize(root: Object3D, parts: Map<string, number>): { triangles: number; vertices: number } {
  let triangles = 0, vertices = 0;
  root.traverse((o) => {
    const holder = o as Object3D & { geometry?: BufferGeometry; isInstancedMesh?: boolean };
    if (!holder.geometry) return;
    const copies = holder.isInstancedMesh ? (o as InstancedMesh).count : 1;
    // `buildingMesh.ts` names them `building-<part>` and `building-furniture-<kind>`.
    const furniture = /^building-furniture-(.+)$/.exec(o.name), part = /^building-(.+)$/.exec(o.name);
    const key = furniture ? `furniture:${furniture[1]}` : part ? `part:${part[1]}` : null;
    if (key) parts.set(key, (parts.get(key) ?? 0) + copies);
    const n = holder.geometry.getAttribute('position')?.count ?? 0;
    triangles += drawnTriangles(holder.geometry).triangles * copies;
    vertices += n * copies;
  });
  return { triangles, vertices };
}

/** Every building of the test city built alone by the kit and measured (`list`); each kind in three sizes, a third of its buildings by floors each, its row the
 *  middle one of the third and its total the sum of the third's own buildings; their interiors cut open and their ghost (editor preview). */
export function buildingItems(add: Add, counts: Map<string, CountEntry>, list: BuildingMeasure[]): void {
  const doc = probe().doc;
  const kit = createBuildingKit(16);
  const byKind = new Map<string, Building[]>();
  for (const id of doc.buildings.idList()) {
    const b = doc.buildings.get(id);
    if (!b) continue;
    const kindList = byKind.get(kindOf(b));
    if (kindList) kindList.push(b); else byKind.set(kindOf(b), [b]);
  }
  const sizes = ['small', 'medium', 'large'] as const;
  const parts = new Map<string, number>();
  let interiorDone = 0;
  for (const [kind, all] of byKind) {
    all.sort((a, b) => floorsOf(a) - floorsOf(b) || a.id - b.id);
    // Thirds by floors: as many as there are buildings, up to three.
    const thirds = sizes.map((_, i) => all.slice(Math.floor((all.length * i) / 3), Math.floor((all.length * (i + 1)) / 3))).filter((t) => t.length > 0);
    thirds.forEach((third, i) => {
      const size = thirds.length === 3 ? sizes[i]! : thirds.length === 1 ? 'all' : (['smaller', 'larger'] as const)[i]!;
      let sum = 0;
      for (const b of third) {
        const built = builtSize(buildBuildingMeshes([{ ...b, x: 0, y: 0, rotation: 0 }], () => 0, kit).group, parts);
        list.push({ id: b.id, kind, floors: floorsOf(b), size, ...built });
        sum += built.triangles;
      }
      const b = third[Math.floor(third.length / 2)]!;
      const meshes = buildBuildingMeshes([{ ...b, x: 0, y: 0, rotation: 0 }], () => 0, kit);
      const countKey = `building:${kind}:${size}`;
      const floors = `${floorsOf(third[0]!)}-${floorsOf(third[third.length - 1]!)} floors`;
      counts.set(countKey, { n: third.length, triangles: sum, from: `test city ${kind} buildings of ${floors}, each built alone and measured: total = the sum of their own triangles (buildings.csv)` });
      add({
        group: kind.startsWith('use ') || kind.startsWith('function ') ? 'Buildings: procedural' : 'Buildings: blueprints', name: kind, variation: `${size} (${floors}; shown: ${floorsOf(b)} floors)`,
        origin: 'kit', source: 'src/render/buildings/buildingMesh.ts (buildBuildingMeshes)', build: 'merged', pieces: buildingPieces(meshes.group), object: meshes.group, floors: floorsOf(b), countKey,
        notes: [`shown: record of building ${b.id} of the test city, built alone at its detail level (L0)`, 'its far levels (facade L1, masses) are drawn by the building layer\'s cells: see the test city section'],
      });
      if (i === thirds.length - 1 && interiorDone < 3) {
        interiorDone++;
        const cut = buildBuildingMeshes([{ ...b, x: 0, y: 0, rotation: 0, cutaway: 1 }], () => 0, kit);
        add({ group: 'Buildings: interiors (cut open)', name: kind, variation: `${floorsOf(b)} floors, cut above level 1`, origin: 'editor preview', preview: true,
          source: 'src/render/buildings/buildingMesh.ts:1360', build: 'merged', pieces: buildingPieces(cut.group), object: cut.group, notes: ['the Construction tool\'s cut-open view: walls, floors and furniture of the cut level'] });
        const ghost = buildBuildingMeshes([{ ...b, x: 0, y: 0, rotation: 0 }], () => 0, kit, true);
        add({ group: 'Editor previews', name: 'building ghost', variation: kind, origin: 'editor preview', preview: true, source: 'src/render/buildings/buildingMesh.ts (ghost)',
          build: 'merged', pieces: buildingPieces(ghost.group), object: ghost.group });
      }
    });
  }
  // Each part model's and furniture kind's copies: every building of the test city built alone at its detail level, its instanced parts counted.
  for (const [key, n] of parts) counts.set(key, { n, from: `copies in the ${list.length} test city buildings, each built alone at its detail level (L0) and its instanced parts counted` });
}

/** The editor's other previews: a run of poles, a railway being drawn. */
export function previewItems(add: Add): void {
  // A network of its own, empty: the previews stand on no city.
  const net = new Network(new RoadDoc());
  const poles = buildPolePreview(net, () => 0, createSceneryKit(), { poles: [{ x: 0, y: 0, lamp: true, standing: true }, { x: 30, y: 0, lamp: false, standing: true }, { x: 60, y: 0, lamp: true, standing: true }] });
  add({ group: 'Editor previews', name: 'pole run', variation: '3 poles', origin: 'editor preview', preview: true, source: 'src/render/poleLayer.ts (buildPolePreview)', build: 'individual', pieces: buildingPieces(poles.group), object: poles.group });
  const track = buildTrackPreview([{ x: 0, y: 0 }, { x: 100, y: 0 }], 'train', () => 0);
  add({ group: 'Editor previews', name: 'railway', variation: '100 m', origin: 'editor preview', preview: true, source: 'src/render/transit.ts (buildTrackPreview)', build: 'individual', pieces: buildingPieces(track.group), object: track.group });
}

/** One geometry a layer drew, and every copy of it the views saw, each once (by its place in the world). */
export interface ScenePart {
  readonly name: string;
  readonly geometry: BufferGeometry;
  readonly material: Material | Material[];
  readonly type: 'mesh' | 'lines' | 'points';
  /** Triangles of one copy, and the bytes of its geometry. */
  readonly triangles: number;
  readonly bytes: number;
  /** Each copy's world matrix, by its place. */
  readonly places: Map<string, Float32Array>;
}

/** One kind of mesh of a layer over every view: every geometry it drew and every copy of each, counted once whatever the views and the cells made again. */
export interface SceneLayer {
  readonly layer: string;
  readonly kind: string;
  /** Geometries, copies (distinct places), triangles (each geometry's times its copies), bytes (each geometry once). */
  meshes: number;
  instances: number;
  triangles: number;
  bytes: number;
  released: boolean;
  readonly casts: Set<string>;
  readonly classes: Set<string>;
  readonly materials: Set<string>;
  readonly parts: Map<string, ScenePart>;
}

/** What the scene showed across the views: by the shape of a geometry (its vertices, triangles and per-vertex attributes), the most copies drawn and how it casts;
 *  every mesh of every layer; every person the game drew and the body its casting gave them (`CastingRegistry.census`). */
export interface SceneSeen {
  readonly bySignature: Map<string, { count: number; casts: Set<string>; names: Set<string> }>;
  readonly layers: Map<string, SceneLayer>;
  /** By body: each person drawn as it (their seed) and their company (`car`, `bus`, `rider`... for the seated, `solo`, `family`... for the walkers). */
  readonly cast: Map<string, Map<number, string>>;
  views: number;
  /** The GPU batches' geometries already read back (`capture.ts`). */
  readonly batches: BatchCache;
}

/** The shape of a geometry, the same for the kit's own copy and the city's. */
export function signatureOf(g: BufferGeometry): string {
  const vertices = g.getAttribute('position')?.count ?? 0;
  const names = Object.entries(g.attributes).filter(([, a]) => !(a as { isInstancedBufferAttribute?: boolean }).isInstancedBufferAttribute).map(([n]) => n).sort();
  return `${vertices}:${g.index?.count ?? vertices}:${names.join(',')}`;
}

/** How a mesh casts its shadow: not at all, its own geometry, a depth material of its own, a coarser level for the shadow. */
function castOf(o: Object3D): string {
  const mesh = o as Object3D & { customDepthMaterial?: Material; onBeforeShadow?: unknown };
  if (!o.castShadow) return 'does not cast';
  const own = Object.prototype.hasOwnProperty.call(o, 'onBeforeShadow');
  return `casts${mesh.customDepthMaterial ? ' with a depth material of its own' : ''}${own ? ' with a coarser level for the shadow' : ''}`;
}

/** One look at the scene, folded into what was seen: every mesh drawn added to its layer's once, the people drawn added to their bodies'. */
export function sceneSnapshot(seen: SceneSeen): void {
  const view = probe().scene();
  const root = view.scene;
  root.updateMatrixWorld(true);
  seen.views++;
  // The census of the frame before (the first call turns it on: `riggedCitizens.ts` census).
  for (const person of view.census()) {
    let wearers = seen.cast.get(person.model);
    if (!wearers) seen.cast.set(person.model, wearers = new Map());
    wearers.set(person.seed, person.company);
  }
  const walk = (o: Object3D, layer: string): void => {
    // What is hidden draws nothing, and nothing under it does.
    if (!o.visible) return;
    const holder = o as Object3D & { isInstancedMesh?: boolean; isBatchedMesh?: boolean; isLine?: boolean; isPoints?: boolean };
    const taken = take(o, seen.batches);
    for (const t of taken) {
      const copies = t.matrices.length / 16;
      const sig = signatureOf(t.geometry);
      let s = seen.bySignature.get(sig);
      if (!s) seen.bySignature.set(sig, s = { count: 0, casts: new Set(), names: new Set() });
      s.count = Math.max(s.count, copies);
      s.casts.add(castOf(o));
      s.names.add(o.name);
    }
    if (taken.length) {
      const kind = (o.name || o.type).replace(/-(ground|alignment-?\d*|bridge|tunnel|viaduct|elevated)\b.*$/, '').replace(/[-_:.]?[0-9a-f]{6,}$/i, '').replace(/[-_:.@#]\d+$/, '');
      const key = `${layer}\u0000${kind}`;
      let l = seen.layers.get(key);
      if (!l) seen.layers.set(key, l = { layer, kind, meshes: 0, instances: 0, triangles: 0, bytes: 0, released: false, casts: new Set(), classes: new Set(), materials: new Set(), parts: new Map() });
      for (const m of [(o as { material?: Material | Material[] }).material ?? []].flat()) {
        const cacheKey = typeof m.customProgramCacheKey === 'function' && Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile') ? ` [${String(m.customProgramCacheKey()).split('\n')[0]!.slice(0, 60)}]` : '';
        l.materials.add(`${m.type}${m.name ? ` "${m.name}"` : ''}${cacheKey}`);
      }
      l.casts.add(castOf(o));
      l.classes.add(holder.isBatchedMesh ? 'batched' : holder.isInstancedMesh ? 'instanced' : holder.isPoints ? 'points' : holder.isLine ? 'lines' : 'individual');
      for (const t of taken) {
        let part = l.parts.get(t.key);
        if (!part) {
          const g = t.geometry, vertices = g.getAttribute('position')!.count;
          let bytes = 0;
          for (const a of Object.values(g.attributes) as { array: ArrayLike<number> & { BYTES_PER_ELEMENT?: number }; count: number; itemSize: number }[]) bytes += a.count * a.itemSize * (a.array?.BYTES_PER_ELEMENT ?? 4);
          if (g.index) bytes += g.index.count * ((g.index.array as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 4);
          const drawn = g.drawRange.count !== Infinity ? Math.min(g.drawRange.count, g.index ? g.index.count : vertices) : g.index ? g.index.count : vertices;
          part = { name: t.name, geometry: g, material: t.material as Material | Material[], type: t.type, triangles: t.type === 'mesh' ? Math.floor(drawn / 3) : 0, bytes, places: new Map() };
          l.parts.set(t.key, part);
        }
        // The same copy seen again (another view, a cell made again) counted once.
        for (let i = 0; i < t.matrices.length / 16; i++) {
          const place = placeKey(t.matrices, i);
          if (!part.places.has(place)) part.places.set(place, t.matrices.slice(i * 16, i * 16 + 16));
        }
      }
      l.meshes = l.parts.size; l.instances = 0; l.triangles = 0; l.bytes = 0;
      for (const p of l.parts.values()) { l.instances += p.places.size; l.triangles += p.triangles * p.places.size; l.bytes += p.bytes; }
    }
    for (const child of o.children) walk(child, o === root ? child.name || child.type : layer);
  };
  walk(root, '');
}

/** The layers that depend on the city's layout (roads, junctions, markings, ground, water, bridges, gardens, lots, rails, signals, signs, wires...): they count in the cost. */
const CITY_LAYERS = /road|street-?net|marking|paint|terrain|ground|plate|water|structure|bridge|pier|far-?road|far-?forest|forest|garden|lot|transit|track|station|signal|sign|barrier|flag|density|wire|kerb|curb|junction|surface|asphalt|footway|verge|median|flat-world|slab|rim/i;

/** A geometry the test city drew, made again with every copy where it stood (world matrices): one mesh for one copy, an instanced mesh for more. */
function standIn(p: ScenePart): Object3D {
  const places = [...p.places.values()];
  if (places.length > 1 && p.type === 'mesh') {
    const mesh = new InstancedMeshClass(p.geometry, p.material, places.length);
    places.forEach((m, i) => (mesh.instanceMatrix.array as Float32Array).set(m, i * 16));
    mesh.name = p.name;
    mesh.frustumCulled = false;
    return mesh;
  }
  const group = new GroupClass();
  for (const m of places) {
    const mesh = p.type === 'points' ? new PointsClass(p.geometry, p.material) : p.type === 'lines' ? new LineSegmentsClass(p.geometry, p.material) : new MeshClass(p.geometry, p.material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.fromArray(m);
    mesh.name = p.name;
    group.add(mesh);
  }
  return places.length === 1 ? group.children[0]! : group;
}

/** Every kind of mesh the test city drew, every mesh of it from every view where it stood: the layout's own layers counted in the cost, the scene's copies of the kits' objects listed apart. */
export function cityLayerItems(add: Add, seen: SceneSeen, counts: Map<string, CountEntry>): void {
  for (const l of seen.layers.values()) {
    if (l.parts.size === 0) continue;
    const label = `${l.layer} / ${l.kind}`;
    const own = CITY_LAYERS.test(label);
    const captured = [...l.parts.values()];
    const object = new GroupClass();
    object.name = label;
    for (const p of captured) object.add(standIn(p));
    const countKey = `layer:${label}`;
    counts.set(countKey, { n: 1, from: `the layer itself: every geometry and every copy of it the scene drew over the ${seen.views} views, each copy once (its copies are inside its triangles)` });
    const classes = [...l.classes];
    add({
      group: own ? 'Test city layers' : 'Test city scene (copies of kit objects)', name: l.kind, variation: l.layer, origin: 'test city', source: `scene layer "${l.layer}"`,
      build: classes.includes('instanced') || classes.includes('batched') ? 'instanced' : classes[0] as ItemSpec['build'], countKey, shadow: [...l.casts].join(' / '), sceneCopy: !own, object,
      pieces: captured.map((p) => ({ label: p.name || l.kind, geometry: p.geometry, material: p.material, copies: p.places.size })),
      notes: [`${l.meshes} geometries, ${l.instances} copies (distinct places) over the ${seen.views} views of the sweep${classes.includes('batched') ? '; a GPU batch\'s geometries read back from the GPU' : ''}`,
        ...(own ? [] : ['the scene\'s copy of objects a kit row already counts: kept out of the cost'])],
    });
  }
}

/** How many copies of each object the test city holds: from its records where it has them (buildings, street furniture, poles, vehicles, people), else the scene's meshes.
 *  The street furniture as its layer places it: an item standing on no footway or median, or at a crossing, draws nothing (`furnitureOf`); a street tree's species and a
 *  shrub's kind by the layer's own roll from the item's seed (`streetFurnitureLayer.ts` furniturePlace). */
export function cityCounts(counts: Map<string, CountEntry>, seen: SceneSeen): void {
  const { doc, sim, net } = probe();
  const records = new Map<string, number>(), drawn = new Map<string, number>(), plants = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string): void => { map.set(key, (map.get(key) ?? 0) + 1); };
  for (const item of doc.landscape.values()) {
    bump(records, item.kind);
    const furniture = furnitureOf(net, item);
    if (!furniture) continue;
    bump(drawn, item.kind);
    // The same draws from the item's seed, in the same order, as the layer: the species (or the shrub's height, then its kind).
    const rng = new Rng(Math.floor(furniture.seed * 0xffffff));
    if (furniture.kind === 'streetTree') bump(plants, `tree:${streetSpecies(rng.float())}`);
    else if (furniture.kind === 'shrub') { rng.float(); bump(plants, `shrub:${rng.float() < 0.4 ? 'bushFlowering' : 'bush'}`); }
  }
  for (const [kind, n] of records) {
    const placed = drawn.get(kind);
    counts.set(`landscape:${kind}`, placed === undefined
      ? { n, from: 'test city landscape records' }
      : { n: placed, from: `test city ${kind} items the street furniture layer places (${n} records; ${n - placed} on no footway or median, or at a crossing, are not placed by it)` });
  }
  for (const species of TREE_SPECIES) counts.set(`landscape:tree:${species}`, { n: plants.get(`tree:${species}`) ?? 0, from: 'test city street trees of this species, by the layer\'s roll from each item\'s seed' });
  for (const kind of BUSH_KINDS) counts.set(`landscape:shrub:${kind}`, { n: plants.get(`shrub:${kind}`) ?? 0, from: 'test city shrubs of this kind, by the layer\'s roll from each item\'s seed' });
  counts.set('poles', { n: (doc as unknown as { poles: { size: number } }).poles.size, from: 'test city pole records' });
  let cars = 0, twoWheelers = 0, wheels = 0, seated = 0;
  for (const v of sim.vehicles.values()) {
    const a = v.archetype;
    const key = a.shape === 'car' ? `vehicle:${a.id}:${carStyleOf(a, agentHash(v.id ^ 0x57e1))}` : `vehicle:${a.id}`;
    const was = counts.get(key);
    counts.set(key, { n: (was?.n ?? 0) + 1, from: 'test city vehicles (moving and parked)' });
    if (a.shape === 'motorcycle' || a.shape === 'bicycle') twoWheelers++; else { cars++; wheels += axleStations(a).length * 2; }
    for (let s = v.seats; s; s &= s - 1) seated++;
  }
  counts.set('wheels:car', { n: wheels, from: 'two a car axle over the test city\'s vehicles' });
  counts.set('wheels:bike', { n: twoWheelers * 2, from: 'two a two-wheeler' });
  const walking = sim.pedViews.length;
  counts.set('people:procedural', { n: walking, from: 'test city walkers (drawn by the procedural crowd)' });
  counts.set('people:all', { n: walking + seated, from: 'test city walkers and people seated in vehicles' });
  counts.set('blob:shadows', { n: cars + twoWheelers + walking, from: 'one under every vehicle and every walker' });
  counts.set('one', { n: 1, from: 'one in the scene' });
  // Each body of the cast: the people the game itself drew as it over the sweep's views, by the casting's census (who wears it is the casting's choice at run time).
  let castSeated = 0, castWalking = 0;
  for (const [model, wearers] of seen.cast) {
    let inVehicles = 0;
    for (const company of wearers.values()) if (inVehicle(company)) inVehicles++;
    castSeated += inVehicles; castWalking += wearers.size - inVehicles;
    counts.set(`cast:${model}`, { n: wearers.size, from: `people the game drew as this body over the ${seen.views} views (casting census): ${inVehicles} in vehicles, ${wearers.size - inVehicles} walking near` });
  }
  counts.set('people:seated', { n: seated, from: `people seated in the test city's vehicles (${castSeated} of them drawn over the views; the others were never near enough to be drawn), ${castWalking} walkers drawn as cast bodies near` });
}

/** The casting's companies of the people riding in a vehicle (`agents.ts` vehicleCompany). */
const inVehicle = (company: string): boolean => company === 'car' || company === 'bus' || company === 'truck' || company === 'rider';

/** The scene's draw calls with every group on, and how many each layer and each part of the buildings takes (the frame with it off, subtracted). */
export async function drawCallsByGroup(): Promise<{ total: number; triangles: number; groups: Record<string, number> }> {
  const p = probe();
  // A frame's calls vary (the shadow cascades redrawn, cells streaming in): the median of five frames once the switch has settled.
  const frame = async (): Promise<{ calls: number; triangles: number }> => {
    await new Promise((r) => setTimeout(r, 900));
    const calls: number[] = [], triangles: number[] = [];
    for (let k = 0; k < 5; k++) {
      p.redraw();
      await new Promise((r) => setTimeout(r, 250));
      const s = p.scene().stats;
      calls.push(s.drawCalls); triangles.push(s.drawnTriangles);
    }
    const median = (list: number[]): number => list.sort((a, b) => a - b)[Math.floor(list.length / 2)]!;
    return { calls: median(calls), triangles: median(triangles) };
  };
  const groups: Record<string, number> = {};
  let total = 0, drawn = 0;
  for (const key of [...LAYER_SWITCHES, ...BUILDING_SWITCHES]) {
    // Its own frame with everything on, right before it: the city streams on meanwhile.
    p.variant(null);
    const on = await frame();
    total = Math.max(total, on.calls); drawn = Math.max(drawn, on.triangles);
    p.variant({ [key]: false });
    const off = await frame();
    groups[key] = on.calls - off.calls;
  }
  p.variant(null);
  return { total, triangles: drawn, groups };
}

/** The destruction at its peak: the tallest buildings in view struck down at once, and a blast in the street; the most the scene drew while they fell. */
export async function destructionPeak(): Promise<Record<string, number>> {
  const p = probe();
  const { doc } = p;
  const view = p.scene();
  const tall = [...doc.buildings.idList()].map((id) => doc.buildings.get(id)!).filter(Boolean).sort((a, b) => buildingHeight(b) - buildingHeight(a)).slice(0, 3);
  const centreOf = (b: Building): { x: number; y: number } => { const r = buildingBounds(b); return { x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2 }; };
  const first = tall[0] ? centreOf(tall[0]) : { x: 0, y: 0 };
  // Looked at, so its pieces are made where the camera is (`destruction.ts` makes them in a worker).
  p.setView({ x: first.x, y: first.y, zoom: 3, azimuth: 0.5, elevation: 0.7 });
  await new Promise((r) => setTimeout(r, 3000));
  const before = view.stats;
  const baseline = { calls: before.drawCalls, triangles: before.drawnTriangles };
  let ruinTriangles = 0, calls = 0, triangles = 0;
  // The first blow asks the worker for the building's pieces (it answers false meanwhile); the second, once they are made, brings it down.
  const strike = (): number => tall.map((b) => { const c = centreOf(b); return view.strikeBuilding(b, c.x, c.y, 6, 10); }).filter(Boolean).length;
  strike();
  await new Promise((r) => setTimeout(r, 2500));
  const struck = strike();
  view.explode(first.x, first.y, 0, 25, { ground: 'road', crater: true, poles: [], wires: [], posts: [], vehicles: [], items: [] });
  for (let t = 0; t < 30; t++) {
    p.redraw();
    await new Promise((r) => setTimeout(r, 200));
    const s = view.stats;
    calls = Math.max(calls, s.drawCalls); triangles = Math.max(triangles, s.drawnTriangles);
    let ruins = 0;
    view.scene.traverse((o) => {
      if (!/destruction|blast|fracture|ruin/i.test(o.name) && !/destruction|blast/i.test(o.parent?.name ?? '')) return;
      const g = (o as { geometry?: BufferGeometry }).geometry;
      if (!g) return;
      const n = Math.floor((g.index ? g.index.count : g.getAttribute('position')?.count ?? 0) / 3);
      ruins += n * ((o as { isInstancedMesh?: boolean }).isInstancedMesh ? (o as InstancedMesh).count : 1);
    });
    ruinTriangles = Math.max(ruinTriangles, ruins);
  }
  // `strikeBuilding` answers true only for a blow on a ruin already made; the pieces counted on the scene say the buildings came down.
  return { buildingsTargeted: tall.length, blowsLanded: struck, baselineCalls: baseline.calls, baselineTriangles: baseline.triangles, peakCalls: calls, peakTriangles: triangles, peakRuinTriangles: ruinTriangles };
}

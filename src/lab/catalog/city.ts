import type { BufferGeometry, InstancedMesh, Material, Object3D } from 'three';
import { createBuildingKit } from '../../render/buildings/kit';
import { buildBuildingMeshes } from '../../render/buildings/buildingMesh';
import { createSceneryKit } from '../../render/scenery';
import { buildPolePreview } from '../../render/poleLayer';
import { buildTrackPreview } from '../../render/transit';
import { agentHash } from '../../render/agents';
import { carStyleOf } from '../../render/carBody';
import { axleStations } from '../../render/vehicleModels';
import { buildingBounds, buildingHeight } from '@world/buildings/geometry';
import type { Building } from '@world/buildings/types';
import type { Network } from '@world/network';
import type { RoadDoc } from '@world/doc';
import type { SimClient } from '@sim/host/simClient';
import { LAYER_SWITCHES, BUILDING_SWITCHES } from '../../render/effectSwitches';
import type { ItemSpec, PieceSpec } from './items';

/** THE TEST CITY: the buildings' records the kit builds on its own (three sizes of each kind), the editor's previews, what depends on the city's layout,
 *  how many copies of each object the city holds, every group's draw calls, and the destruction's peak (`scripts/model-catalog.mjs`). */

type Add = (spec: ItemSpec) => void;

export interface GameProbe {
  readonly doc: RoadDoc;
  readonly net: Network;
  readonly sim: SimClient;
  scene(): {
    readonly scene: Object3D;
    readonly stats: { readonly drawCalls: number; readonly drawnTriangles: number };
    strikeBuilding(b: Building, x: number, y: number, z: number, strength: number): boolean;
    explode(x: number, y: number, z: number, radius: number, hit: unknown): void;
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

/** The buildings, three sizes of each kind (fewest, middle and most floors in the test city), built on their own by the kit; their interiors cut open and their ghost (editor preview). */
export function buildingItems(add: Add, counts: Map<string, { n: number; from: string }>): void {
  const doc = probe().doc;
  const kit = createBuildingKit(16);
  const byKind = new Map<string, Building[]>();
  for (const id of doc.buildings.idList()) {
    const b = doc.buildings.get(id);
    if (!b) continue;
    const list = byKind.get(kindOf(b));
    if (list) list.push(b); else byKind.set(kindOf(b), [b]);
  }
  const sizes = ['small', 'medium', 'large'] as const;
  let interiorDone = 0;
  for (const [kind, list] of byKind) {
    list.sort((a, b) => floorsOf(a) - floorsOf(b));
    const picks = [list[0]!, list[Math.floor(list.length / 2)]!, list[list.length - 1]!];
    // Each building of the kind counted with the size whose floors it is nearest.
    const bucket = [0, 0, 0];
    for (const b of list) {
      const f = floorsOf(b);
      const nearest = picks.map((p) => Math.abs(floorsOf(p) - f));
      bucket[nearest.indexOf(Math.min(...nearest))]!++;
    }
    picks.forEach((b, i) => {
      if (i > 0 && floorsOf(b) === floorsOf(picks[i - 1]!) && b === picks[i - 1]) return;
      const meshes = buildBuildingMeshes([{ ...b, x: 0, y: 0, rotation: 0 }], () => 0, kit);
      const countKey = `building:${kind}:${sizes[i]}`;
      counts.set(countKey, { n: bucket[i]!, from: 'test city buildings of this kind nearest this size' });
      add({
        group: kind.startsWith('use ') || kind.startsWith('function ') ? 'Buildings: procedural' : 'Buildings: blueprints', name: kind, variation: `${sizes[i]} (${floorsOf(b)} floors)`,
        origin: 'kit', source: 'src/render/buildings/buildingMesh.ts (buildBuildingMeshes)', build: 'merged', pieces: buildingPieces(meshes.group), floors: floorsOf(b), countKey,
        notes: [`record of building ${b.id} of the test city, built alone at its detail level (L0)`, 'its far levels (facade L1, masses) are drawn by the building layer\'s cells: see the test city section'],
      });
      if (i === 2 && interiorDone < 3) {
        interiorDone++;
        const cut = buildBuildingMeshes([{ ...b, x: 0, y: 0, rotation: 0, cutaway: 1 }], () => 0, kit);
        add({ group: 'Buildings: interiors (cut open)', name: kind, variation: `${floorsOf(b)} floors, cut above level 1`, origin: 'editor preview', preview: true,
          source: 'src/render/buildings/buildingMesh.ts:1360', build: 'merged', pieces: buildingPieces(cut.group), notes: ['the Construction tool\'s cut-open view: walls, floors and furniture of the cut level'] });
        const ghost = buildBuildingMeshes([{ ...b, x: 0, y: 0, rotation: 0 }], () => 0, kit, true);
        add({ group: 'Editor previews', name: 'building ghost', variation: kind, origin: 'editor preview', preview: true, source: 'src/render/buildings/buildingMesh.ts (ghost)',
          build: 'merged', pieces: buildingPieces(ghost.group) });
      }
    });
  }
}

/** The editor's other previews: a run of poles, a railway being drawn. */
export function previewItems(add: Add): void {
  const { net } = probe();
  const poles = buildPolePreview(net, () => 0, createSceneryKit(), { poles: [{ x: 0, y: 0, lamp: true, standing: true }, { x: 30, y: 0, lamp: false, standing: true }, { x: 60, y: 0, lamp: true, standing: true }] });
  add({ group: 'Editor previews', name: 'pole run', variation: '3 poles', origin: 'editor preview', preview: true, source: 'src/render/poleLayer.ts (buildPolePreview)', build: 'individual', pieces: buildingPieces(poles.group) });
  const track = buildTrackPreview([{ x: 0, y: 0 }, { x: 100, y: 0 }], 'train', () => 0);
  add({ group: 'Editor previews', name: 'railway', variation: '100 m', origin: 'editor preview', preview: true, source: 'src/render/transit.ts (buildTrackPreview)', build: 'individual', pieces: buildingPieces(track.group) });
}

/** What the scene showed across the views: by the shape of a geometry (its vertices, triangles and per-vertex attributes), the most copies drawn and how it casts. */
export interface SceneSeen {
  readonly bySignature: Map<string, { count: number; casts: Set<string>; names: Set<string> }>;
  readonly layers: Map<string, { layer: string; kind: string; meshes: number; instances: number; triangles: number; bytes: number; casts: Set<string>; released: boolean; classes: Set<string>; materials: Set<string> }>;
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

/** One look at the scene, folded into what was seen. */
export function sceneSnapshot(seen: SceneSeen): void {
  const root = probe().scene().scene;
  // This view's layers alone: kept where they drew more than in any view before (a layer streams its cells as the camera moves).
  const now: SceneSeen['layers'] = new Map();
  const walk = (o: Object3D, layer: string): void => {
    const holder = o as Object3D & { geometry?: BufferGeometry; isInstancedMesh?: boolean; isMesh?: boolean; isLine?: boolean; isPoints?: boolean; count?: number };
    if (holder.geometry && (holder.isMesh || holder.isLine || holder.isPoints)) {
      const g = holder.geometry;
      const count = holder.isInstancedMesh ? holder.count ?? 0 : 1;
      const sig = signatureOf(g);
      let s = seen.bySignature.get(sig);
      if (!s) seen.bySignature.set(sig, s = { count: 0, casts: new Set(), names: new Set() });
      s.count = Math.max(s.count, count);
      s.casts.add(castOf(o));
      s.names.add(o.name);
      const kind = (o.name || o.type).replace(/-(ground|alignment-?\d*|bridge|tunnel|viaduct|elevated)\b.*$/, '').replace(/[-_:.]?[0-9a-f]{6,}$/i, '').replace(/[-_:.@#]\d+$/, '');
      const key = `${layer}\u0000${kind}`;
      let l = now.get(key);
      if (!l) now.set(key, l = { layer, kind, meshes: 0, instances: 0, triangles: 0, bytes: 0, casts: new Set(), released: false, classes: new Set(), materials: new Set() });
      for (const m of [(o as { material?: Material | Material[] }).material ?? []].flat()) {
        const key = typeof m.customProgramCacheKey === 'function' && Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile') ? ` [${String(m.customProgramCacheKey()).split('\n')[0]!.slice(0, 60)}]` : '';
        l.materials.add(`${m.type}${m.name ? ` "${m.name}"` : ''}${key}`);
      }
      const vertices = g.getAttribute('position')?.count ?? 0;
      const tris = Math.floor((g.index ? g.index.count : vertices) / 3) * count;
      l.meshes++;
      l.instances += count;
      l.triangles += tris;
      for (const a of Object.values(g.attributes) as { array: ArrayLike<number> | null; count: number; itemSize: number }[]) {
        if (!a.array) l.released = true;
        l.bytes += a.count * a.itemSize * 4;
      }
      l.casts.add(castOf(o));
      l.classes.add(holder.isInstancedMesh ? 'instanced' : holder.isPoints ? 'points' : holder.isLine ? 'lines' : 'individual');
    }
    for (const child of o.children) walk(child, o === root ? child.name || child.type : layer);
  };
  walk(root, '');
  for (const [key, l] of now) {
    const was = seen.layers.get(key);
    if (was) { for (const c of was.casts) l.casts.add(c); for (const m of was.materials) l.materials.add(m); }
    if (!was || l.triangles > was.triangles) seen.layers.set(key, l);
    else { for (const c of l.casts) was.casts.add(c); for (const m of l.materials) was.materials.add(m); }
  }
}

/** The layers that depend on the city's layout, measured from the test city as a whole (their meshes are built from its roads, ground and items). */
const CITY_LAYERS = /road|street-?net|marking|paint|terrain|ground|plate|water|structure|bridge|pier|far-?road|far-?forest|forest|garden|lot|transit|track|station|signal|sign|barrier|flag|density|wire|pole|kerb|curb|junction|surface/i;

export function cityLayerItems(add: Add, seen: SceneSeen, counts: Map<string, { n: number; from: string }>): void {
  for (const l of seen.layers.values()) {
    const label = `${l.layer} / ${l.kind}`;
    if (!CITY_LAYERS.test(label)) continue;
    const countKey = `layer:${label}`;
    counts.set(countKey, { n: 1, from: 'the layer as drawn over the test city\'s views (its triangles are every copy it drew)' });
    add({
      group: 'Test city layers', name: l.kind, variation: l.layer, origin: 'test city', source: `scene layer "${l.layer}"`, build: l.classes.has('instanced') ? 'instanced' : [...l.classes][0] as ItemSpec['build'],
      pieces: [], countKey, shadow: [...l.casts].join(' / '), given: { triangles: l.triangles, vertices: 0, bytes: l.bytes, released: l.released },
      notes: [`${l.meshes} meshes, ${l.instances} copies drawn, ${l.triangles} triangles, ~${Math.round(l.bytes / 1024)} KB of vertex buffers${l.released ? ' (arrays sent to the GPU only: no vertex-level measure)' : ''}`],
    });
  }
}

/** How many copies of each object the test city holds: from its records where it has them (buildings, street furniture, poles, vehicles, people), else the most the scene drew. */
export function cityCounts(counts: Map<string, { n: number; from: string }>): void {
  const { doc, sim } = probe();
  const landscape = new Map<string, number>();
  for (const item of doc.landscape.values()) landscape.set(item.kind, (landscape.get(item.kind) ?? 0) + 1);
  for (const [kind, n] of landscape) counts.set(`landscape:${kind}`, { n, from: 'test city landscape records' });
  const trees = landscape.get('tree') ?? 0, shrubs = landscape.get('shrub') ?? 0;
  for (const species of ['broadleaf', 'broadleafTall', 'conifer', 'ipeYellow', 'ipePink']) counts.set(`landscape:tree:${species}`, { n: Math.round(trees / 5), from: 'test city street trees, shared evenly over the 5 species (the layer picks one by a roll)' });
  for (const kind of ['bush', 'bushFlowering', 'hedge']) counts.set(`landscape:shrub:${kind}`, { n: Math.round(shrubs / 3), from: 'test city shrubs, shared evenly over the 3 kinds' });
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
  counts.set('cast:seated', { n: seated, from: 'people seated in vehicles, drawn by the cast\'s bodies' });
}

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

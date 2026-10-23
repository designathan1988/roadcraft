import {
  ACESFilmicToneMapping, Box3, Color, DirectionalLight, HemisphereLight, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  NoToneMapping, PerspectiveCamera, PlaneGeometry, Scene, SRGBColorSpace, Vector2, Vector3, WebGLRenderer, type BufferGeometry, type Object3D,
} from 'three';
import { BufferGeometry as BufferGeometryClass, Group, InstancedMesh, Plane, Points, PointsMaterial, Raycaster, type Material } from 'three';
import { buildingBounds } from '@world/buildings/geometry';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { primeSurfaceBake, startSurfaceBake } from '../../render/surfaceBakeClient';
import { surfaceMaps } from '../../render/surfaceTextures';
import { measureItem, type CatalogRow, type ItemSpec } from './items';
import { buildingKitItems, effectItems, elementItems, groundCoverItems, miscItems, sceneryItems, treeItems, vehicleItems } from './kits';
import { peopleAssetItems, peopleItems } from './people';
import { layoutItems } from './layout';
import { engineBuildingItems } from './engineBuildings';
import { shellPieceItems } from './shellPieces';
import { buildingItems, cityCounts, destructionPeak, drawCallsByGroup, previewItems, probe, sceneSnapshot, signatureOf, type BuildingMeasure, type CountEntry, type SceneLayer, type SceneSeen } from './city';

/** THE CATALOGUE'S RUN IN THE GAME'S PAGE: the kits, then the test city, then the counts and shadows put together (`scripts/model-catalog.mjs` drives it). */

interface State {
  rows: CatalogRow[];
  objects: Map<string, Object3D>;
  signatures: Map<string, string[]>;
  gaps: string[];
  counts: Map<string, CountEntry>;
  seen: SceneSeen;
  drawCalls: Awaited<ReturnType<typeof drawCallsByGroup>> | null;
  destruction: Record<string, number> | null;
  buildings: BuildingMeasure[];
  /** The objects being written out, one after another, and how many were. */
  saving: Promise<void>;
  saved: number;
}

const state = (): State => {
  const w = window as unknown as { __catalogue?: State };
  w.__catalogue ??= { rows: [], objects: new Map(), signatures: new Map(), gaps: [], counts: new Map(), seen: { bySignature: new Map(), layers: new Map(), cast: new Map(), views: 0, batches: new Map() }, drawCalls: null, destruction: null, buildings: [], saving: Promise.resolve(), saved: 0 };
  return w.__catalogue;
};

/** What could not be catalogued and why, for the report's list. */
const recordGap = (text: string): void => { state().gaps.push(text); };

/** Adds one item: measured, its sheet's object and its pieces' shapes kept. */
function add(spec: ItemSpec): void {
  const s = state();
  const base = `${spec.group}/${spec.name}${spec.variation ? `/${spec.variation}` : ''}`;
  let id = base, n = 2;
  while (s.objects.has(id)) id = `${base}#${n++}`;
  try {
    const { row, object } = measureItem(spec, id);
    s.rows.push(row);
    s.objects.set(id, object);
    s.signatures.set(id, spec.pieces.map((p) => signatureOf(p.geometry)));
    // Saved as soon as it is measured: its sheet, its 3D file and its numbers in the catalogue's folder, one object after another.
    s.saving = s.saving.then(() => saveRow(row));
  } catch (error) {
    recordGap(`${base}: measuring failed: ${String(error)}`);
  }
}

/** One object written out: `sheets/NNNN-<id>.png` (render + wireframe), `models/NNNN-<id>.glb`, `rows/NNNN-<id>.json`, NNNN the order it was made in. */
async function saveRow(row: CatalogRow): Promise<void> {
  const s = state();
  const name = `${String(++s.saved).padStart(4, '0')}-${row.id.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80)}`;
  try {
    const png = await catalogueSheet(row.id, 480);
    if (png) { await writeFile(`images/${name}.png`, Uint8Array.from(atob(png), (c) => c.charCodeAt(0)).buffer); row.sheet = `images/${name}.png`; }
    else recordGap(`${row.id}: no sheet (nothing drawable: no geometry with readable arrays)`);
  } catch (error) { recordGap(`${row.id}: its sheet could not be drawn (${String(error)})`); }
  const [model] = await catalogueModels([{ id: row.id, file: `models/${name}.glb` }]);
  if (model && !model.error && model.bytes) row.model = `models/${name}.glb`;
  await writeFile(`rows/${name}.json`, new TextEncoder().encode(JSON.stringify(row, null, 1)).buffer);
}

/** Runs one group's builder unless `only` leaves it out; a group that fails is listed, the others go on. */
async function group(name: string, run: () => void | Promise<void>): Promise<void> {
  const only = (window as unknown as { __catalogueOnly?: RegExp | null }).__catalogueOnly;
  if (only && !only.test(name)) return;
  try { await run(); } catch (error) { recordGap(`${name}: could not be built: ${String(error)}`); }
  // Its objects written out before the next group is built.
  await state().saving;
}

/** Every kit, each object and variation built on its own; `proxies` the garment and hair files, `targetBytes` the shape targets' files;
 *  `only` (a pattern) the groups to build, every group when empty. */
export async function catalogueKits(proxies: readonly string[], targetBytes: number, only = ''): Promise<number> {
  (window as unknown as { __catalogueOnly?: RegExp | null }).__catalogueOnly = only ? new RegExp(only, 'i') : null;
  // In the order asked: the buildings' parts and furniture, the buildings, the roads and ground, then the rest.
  await group('building shell pieces', () => shellPieceItems(add));
  await group('building kit and furniture', () => buildingKitItems(add));
  await group('buildings (engine generators)', () => engineBuildingItems(add));
  await group('roads, structures, poles, ground (engine layouts)', () => layoutItems(add));
  await group('landscape kit, street furniture, poles', () => sceneryItems(add));
  await group('ground cover', () => groundCoverItems(add));
  await group('trees', () => treeItems(add));
  await group('landscape elements (glTF)', () => elementItems(add));
  await group('vehicles', () => vehicleItems(add));
  await group('held props, trains, sky', () => miscItems(add));
  await group('effects', () => effectItems(add));
  await group('editor previews', () => previewItems(add));
  await group('people: base body and garments', () => peopleAssetItems(add, proxies, targetBytes));
  await group('people: cast and crowd', () => peopleItems(add));
  return state().rows.length;
}

/** The test city is open: its buildings' records built alone, the editor's previews. */
export async function catalogueCityObjects(): Promise<number> {
  // The city's buildings only counted (no row of them: the rows are the engine's generators'): each built alone, its parts' copies and triangles summed.
  await group('test city buildings counted', () => buildingItems(() => {}, state().counts, state().buildings));
  return state().rows.length;
}

/** One view of the test city read. */
export function catalogueLook(): number {
  sceneSnapshot(state().seen);
  return state().seen.layers.size;
}

/** The test city's extent on the plan (its roads' nodes and its buildings), and the ground a view at `zoom`, `elevation` degrees takes in there:
 *  the four corners of the screen cast on the ground plane from the game's own camera, after it looked from the city's centre. */
export async function catalogueExtent(zoom: number, elevation: number): Promise<{ minX: number; minY: number; maxX: number; maxY: number; spanX: number; spanY: number }> {
  const { doc } = probe();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const take = (x: number, y: number): void => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
  for (const node of doc.nodes.values()) take(node.x, node.y);
  for (const id of doc.buildings.idList()) { const b = doc.buildings.get(id); if (b) { const r = buildingBounds(b); take(r.minX, r.minY); take(r.maxX, r.maxY); } }
  catalogueView((minX + maxX) / 2, (minY + maxY) / 2, zoom, 0, elevation);
  probe().redraw();
  await new Promise((r) => setTimeout(r, 300));
  const camera = probe().scene().viewCamera();
  camera.updateMatrixWorld(true);
  const ray = new Raycaster();
  const ground = new Plane(new Vector3(0, 1, 0), 0);
  const hits: Vector3[] = [];
  for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    ray.setFromCamera(new Vector2(u, v), camera);
    const at = ray.ray.intersectPlane(ground, new Vector3());
    if (at) hits.push(at);
  }
  if (hits.length < 4) throw new Error('the view does not take in the ground at all four corners: look down more steeply');
  // The scene's x is the plan's x, its z the plan's -y.
  const xs = hits.map((h) => h.x), ys = hits.map((h) => -h.z);
  return { minX, minY, maxX, maxY, spanX: Math.max(...xs) - Math.min(...xs), spanY: Math.max(...ys) - Math.min(...ys) };
}

/** The test city's layers, its counts, every group's draw calls, the destruction's peak; then each row's copies, cost and shadow. */
export async function catalogueFinish(): Promise<number> {
  const s = state();
  await group('test city counts', () => cityCounts(s.counts, s.seen));
  await group('draw calls by group', async () => { s.drawCalls = await drawCallsByGroup(); });
  await group('destruction peak', async () => { s.destruction = await destructionPeak(); });
  const layers = [...s.seen.layers.values()];
  for (const row of s.rows) {
    // The test city's meshes of this object by name (`street-bench` for the bench), those of its own group first; by the shape of its geometry
    // only where the shape tells it apart (a box of 12 triangles is every box).
    const named = row.origin === 'test city' ? [] : namedLayers(row, layers);
    const sigs = row.triangles >= 200 ? s.signatures.get(row.id) ?? [] : [];
    const shaped = sigs.map((sig) => s.seen.bySignature.get(sig)).filter((x) => x !== undefined);
    if (!row.shadow) row.shadow = named.length ? [...new Set(named.flatMap((l) => [...l.casts]))].join(' / ')
      : shaped.length ? [...new Set(shaped.flatMap((m) => [...m.casts]))].join(' / ') : 'not seen in the test city';
    if (!row.materials && named.length) {
      const drawn = [...new Set(named.flatMap((l) => [...l.materials]))];
      (row as { materials: string }).materials = `${drawn.join(' | ')} (as the test city draws it)`;
      if (!row.shader) (row as { shader: string }).shader = [...new Set(drawn.map((m) => (m.includes('[') ? `patched built-in ${m.slice(m.indexOf('[') + 1, -1)}` : `three ${m.split(' ')[0]}`)))].join(' | ');
    }
    const counted = s.counts.get(row.countKey);
    if (row.preview) { row.instances = 0; row.instancesFrom = 'editor preview: not in the running game'; }
    else if (row.countKey === 'source') { row.instances = 0; row.instancesFrom = 'source model: its copies are counted in the rows that draw it'; }
    else if (counted) { row.instances = counted.n; row.instancesFrom = counted.from; }
    else if (named.length) { row.instances = Math.max(...named.map((l) => l.instances)); row.instancesFrom = `copies its scene meshes drew over the ${s.seen.views} views, the largest of: ${named.map((l) => `${l.kind} ${l.instances}`).slice(0, 4).join(', ')} (near and far meshes of one object are not added up)`; }
    else if (shaped.length) { row.instances = Math.max(...shaped.map((m) => m.count)); row.instancesFrom = `most copies one scene mesh of the same geometry drew in one view (${[...shaped[0]!.names].slice(0, 2).join(', ')})`; }
    else { row.instances = 0; row.instancesFrom = 'not found in the test city'; }
    if (row.countKey.startsWith('cast:') && !counted) { row.instances = 0; row.instancesFrom = `nobody drawn as this body over the ${s.seen.views} views (casting census)`; }
    if (row.sceneCopy) row.instancesFrom = 'the test city\'s copy of a kit object: counted in the kit\'s row, kept out of the cost';
    // Summed copy by copy where the copies differ (buildings of one kind and size band), else triangles times copies.
    row.totalTriangles = row.preview || row.sceneCopy ? 0 : counted?.triangles ?? row.triangles * row.instances;
  }
  return s.rows.length;
}

/** The word a group's meshes carry in the scene, to pick an object's own among same-named ones. */
const GROUP_WORD: Readonly<Record<string, RegExp>> = {
  // The interiors' furniture is drawn only inside a building cut open: its names in the scene are the facade props' (`building-chair`), not its own.
  'Furniture (interiors)': /furniture/i, 'Buildings: part models': /building-/i, 'Street furniture': /street|bench|bins|hydrant|light|lamp|post|phone|drain|garden|tuft|flower/i,
  'Utility poles': /utility/i, 'People: held props': /held/i, 'Vehicles': /car-|vehicle|bus|truck|bike-|bicycle|wheel/i, 'Street trees and bushes': /garden|street|tree|shrub|bush/i,
  'Ground cover': /cover|rock|scrub/i, 'Forest trees (painted woods)': /cover|forest|wood/i, 'Ecosystem trees': /nature/i, 'Landscape elements (glTF)': /element/i,
  'Transit': /transit/i, 'Sky': /sky/i, 'Effects': /shadow|exhaust|rain|lightning|gore|casualt|blast|tracer/i,
};

/** Names the scene gives an object other than its own: a plural, the layer's word for it. */
const SCENE_NAMES: Readonly<Record<string, readonly string[]>> = {
  lamp: ['street-lights', 'street-lights-far-cells', 'utility-lamp-heads'], bin: ['street-bins', 'bins'], bench: ['benches'], hydrant: ['hydrants'],
  postbox: ['postboxes'], phone: ['phones'], drain: ['drains'], 'lamp lens': ['street-light-lamps', 'utility-lamp-lenses'],
  'lamp light pool (night)': ['street-light-pools', 'utility-lamp-pools'], 'lamp light beam (night)': ['street-light-beams', 'utility-lamp-beams'],
  'blob shadow': ['vehicle-shadows', 'procedural-people-shadows'], sky: ['sky'], 'exhaust smoke': ['exhaust'], rain: ['rain'],
};

/** The scene's meshes named after a row's object (its name or the scene's word for it, as a whole word), among its group's own only. */
function namedLayers(row: CatalogRow, layers: readonly SceneLayer[]): SceneLayer[] {
  const kebab = row.name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const names = [kebab, row.name.toLowerCase().replace(/[^a-z0-9]+/g, ''), ...(SCENE_NAMES[row.name] ?? [])].filter((n) => n.length >= 3);
  if (!names.length) return [];
  const word = new RegExp(`(^|[^a-z0-9])(${names.map((n) => n.replace(/[^a-z0-9-]/g, '')).join('|')})($|[^a-z0-9])`);
  const own = GROUP_WORD[row.group];
  return layers.filter((l) => word.test(l.kind.toLowerCase()) && (!own || own.test(`${l.layer} ${l.kind}`)));
}

/** Everything found, as data: the rows, what could not be measured, the draw calls, the destruction's peak, and every mesh kind the test city drew. */
export function catalogueResult(): { rows: CatalogRow[]; gaps: string[]; drawCalls: State['drawCalls']; destruction: State['destruction']; scene: unknown[]; buildings: BuildingMeasure[] } {
  const s = state();
  const scene = [...s.seen.layers.values()].sort((a, b) => b.triangles - a.triangles).map((l) => ({
    layer: l.layer, kind: l.kind, meshes: l.meshes, copies: l.instances, triangles: l.triangles, bytes: l.bytes, casts: [...l.casts], materials: [...l.materials], released: l.released,
  }));
  return { rows: s.rows, gaps: s.gaps, drawCalls: s.drawCalls, destruction: s.destruction, scene, buildings: s.buildings };
}

/** The baked surfaces (the buildings' finishes and the roads' maps) read when the game has not read them: the catalogue's page runs without the game. */
export async function catalogueSurfaces(): Promise<boolean> {
  if (surfaceMaps('building-finishes', 0)) return false;
  primeSurfaceBake(await startSurfaceBake());
  return true;
}

/** The one renderer every sheet is drawn with: DO NOT make one a sheet (a WebGL context each, and the browser keeps 16 at most). */
function sheetRenderer(panel: number): WebGLRenderer {
  const w = window as unknown as { __catalogueRenderer?: WebGLRenderer };
  if (!w.__catalogueRenderer) {
    const canvas = document.createElement('canvas');
    w.__catalogueRenderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    w.__catalogueRenderer.setPixelRatio(1);
    w.__catalogueRenderer.outputColorSpace = SRGBColorSpace;
  }
  const renderer = w.__catalogueRenderer;
  const size = renderer.getSize(new Vector2());
  if (size.x !== panel || size.y !== panel) renderer.setSize(panel, panel, false);
  return renderer;
}

/** Several objects' sheets in one call (`panel` pixels a picture): fewer trips between the page and the script. */
export async function catalogueSheets(ids: readonly string[], panel = 480): Promise<{ id: string; png: string | null; error?: string }[]> {
  const out: { id: string; png: string | null; error?: string }[] = [];
  for (const id of ids) {
    try { out.push({ id, png: await catalogueSheet(id, panel) }); } catch (error) { recordGap(`${id}: its sheet could not be drawn (${String(error)})`); out.push({ id, png: null, error: String(error) }); }
  }
  return out;
}

/** A geometry with only what a 3D file carries: position, normal, uv and colour, and its triangles' index; null without positions. */
function exportGeometry(g: BufferGeometry, colours: boolean): BufferGeometry | null {
  const position = g.getAttribute('position');
  if (!position || !(position as { array?: unknown }).array) return null;
  const out = new BufferGeometryClass();
  for (const name of ['position', 'normal', 'uv', ...(colours ? ['color'] : [])]) {
    const a = g.getAttribute(name);
    if (a && (a as { array?: unknown }).array && !(a as { isInstancedBufferAttribute?: boolean }).isInstancedBufferAttribute) out.setAttribute(name, a);
  }
  if (g.index && g.index.array) out.setIndex(g.index);
  return out;
}

/** A plain material a 3D file can carry: the source's colour, roughness and metal, its vertex colours; the engine's own shader left out. */
function exportMaterial(m: Material | Material[] | undefined, colours: boolean, type: 'mesh' | 'lines' | 'points'): Material {
  const source = (Array.isArray(m) ? m[0] : m) as (Material & { color?: { getHex(): number }; roughness?: number; metalness?: number; transparent?: boolean; opacity?: number }) | undefined;
  const color = source?.color?.getHex() ?? 0xbfbab2;
  if (type === 'lines') return new LineBasicMaterial({ color, vertexColors: colours });
  if (type === 'points') return new PointsMaterial({ color, vertexColors: colours, size: 0.2 });
  return new MeshStandardMaterial({ color, vertexColors: colours, roughness: source?.roughness ?? 0.8, metalness: source?.metalness ?? 0, transparent: source?.transparent ?? false, opacity: source?.opacity ?? 1 });
}

/** An object as a 3D file can hold it: every mesh where it stands in the object, its copies kept (EXT_mesh_gpu_instancing). */
function exportObject(root: Object3D, colours: boolean): Group {
  const out = new Group();
  out.name = root.name;
  root.updateMatrixWorld(true);
  const inverse = root.matrixWorld.clone().invert();
  root.traverse((o) => {
    const holder = o as Object3D & { geometry?: BufferGeometry; material?: Material | Material[]; isInstancedMesh?: boolean; isPoints?: boolean; isLine?: boolean; isMesh?: boolean; count?: number };
    if (!holder.geometry || !(holder.isMesh || holder.isLine || holder.isPoints)) return;
    const hasColour = colours && holder.geometry.getAttribute('color') !== undefined;
    const g = exportGeometry(holder.geometry, hasColour);
    if (!g) return;
    const type = holder.isPoints ? 'points' : holder.isLine ? 'lines' : 'mesh';
    const material = exportMaterial(holder.material, hasColour, type);
    let node: Object3D;
    if (holder.isInstancedMesh) {
      const source = o as InstancedMesh;
      const mesh = new InstancedMesh(g, material, Math.max(1, source.count));
      if (source.instanceMatrix.array) mesh.instanceMatrix.array.set((source.instanceMatrix.array as Float32Array).subarray(0, source.count * 16));
      node = mesh;
    } else node = type === 'points' ? new Points(g, material) : type === 'lines' ? new LineSegments(g, material) : new Mesh(g, material);
    node.name = o.name;
    // Where it stands in the object, as a translation, rotation and scale.
    const local = inverse.clone().multiply(o.matrixWorld);
    local.decompose(node.position, node.quaternion, node.scale);
    out.add(node);
  });
  return out;
}

/** Writes a 3D file through the script (`__catalogueWrite`, a function the script gives the page), in pieces small enough to send. */
async function writeFile(file: string, data: ArrayBuffer): Promise<void> {
  const write = (window as unknown as { __catalogueWrite: (file: string, base64: string, append: boolean) => Promise<void> }).__catalogueWrite;
  const bytes = new Uint8Array(data);
  const CHUNK = 6 * 1024 * 1024;
  for (let at = 0; at < Math.max(1, bytes.length); at += CHUNK) {
    let text = '';
    const part = bytes.subarray(at, Math.min(bytes.length, at + CHUNK));
    for (let i = 0; i < part.length; i += 0x8000) text += String.fromCharCode(...part.subarray(i, i + 0x8000));
    await write(file, btoa(text), at > 0);
  }
}

/** Several objects' 3D files (GLB), each under the file name the script gave it; a model the exporter refuses is tried again without its colours. */
export async function catalogueModels(entries: readonly { id: string; file: string }[]): Promise<{ id: string; bytes: number; error?: string }[]> {
  const s = state();
  const exporter = new GLTFExporter();
  const out: { id: string; bytes: number; error?: string }[] = [];
  for (const { id, file } of entries) {
    const object = s.objects.get(id);
    if (!object) { out.push({ id, bytes: 0, error: 'no object' }); continue; }
    let data: ArrayBuffer | null = null, error = '';
    for (const colours of [true, false]) {
      try {
        const result = await exporter.parseAsync(exportObject(object, colours), { binary: true, onlyVisible: false });
        data = result as ArrayBuffer;
        break;
      } catch (e) { error = String(e); console.error(`[catalogue] export of ${id}${colours ? ' with colours' : ''} failed`, e); }
    }
    if (!data) { recordGap(`${id}: its 3D file could not be written (${error})`); out.push({ id, bytes: 0, error }); continue; }
    await writeFile(file, data);
    out.push({ id, bytes: data.byteLength });
  }
  return out;
}

/** Every row's id, costliest first (the order the sheets are numbered in). */
export function catalogueIds(): string[] {
  return [...state().rows].sort((a, b) => b.totalTriangles - a.totalTriangles || b.triangles - a.triangles).map((r) => r.id);
}

/** One object's sheet: rendered and as a hidden-line wireframe side by side, titled; a PNG as base64. */
export async function catalogueSheet(id: string, panel = 800): Promise<string | null> {
  const s = state();
  const object = s.objects.get(id);
  const row = s.rows.find((r) => r.id === id);
  // Something to draw: a mesh of its own or meshes under it.
  if (!object || !row || (object.children.length === 0 && !(object as { geometry?: unknown }).geometry)) return null;
  const W = panel, H = panel;
  const renderer = sheetRenderer(panel);
  const canvas = renderer.domElement;
  renderer.toneMapping = ACESFilmicToneMapping;
  const box = new Box3().setFromObject(object);
  const centre = box.getCenter(new Vector3()), size = box.getSize(new Vector3());
  // The hidden-line wireframe: every copy's surface in white pushed back a little and every triangle's edges over it (three's `wireframe`
  // draws the edges WireframeGeometry gives), so an edge behind a surface is hidden; an instanced mesh with all its copies.
  const wire = new Scene();
  wire.background = new Color(0xffffff);
  object.updateMatrixWorld(true);
  const fillMaterial = new MeshBasicMaterial({ color: 0xf7f8fa, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const edgeMaterial = new MeshBasicMaterial({ color: 0x1b2a3a, wireframe: true });
  const lineMaterial = new LineBasicMaterial({ color: 0x1b2a3a });
  object.traverse((o) => {
    const holder = o as Object3D & { geometry?: BufferGeometry; isMesh?: boolean; isInstancedMesh?: boolean };
    const g = holder.geometry;
    if (!g) return;
    const copies: Object3D[] = [];
    if (holder.isInstancedMesh) {
      const source = o as InstancedMesh;
      for (const material of [fillMaterial, edgeMaterial]) {
        const copy = new InstancedMesh(g, material, source.count);
        copy.instanceMatrix = source.instanceMatrix;
        copy.frustumCulled = false;
        copies.push(copy);
      }
    } else if (holder.isMesh) copies.push(new Mesh(g, fillMaterial), new Mesh(g, edgeMaterial));
    else copies.push(new LineSegments(g, lineMaterial));
    for (const copy of copies) { copy.matrix.copy(o.matrixWorld); copy.matrixAutoUpdate = false; wire.add(copy); }
  });
  const camera = new PerspectiveCamera(30, W / H, Math.max(0.01, size.length() / 100), size.length() * 20 + 10);
  camera.position.copy(centre).addScaledVector(new Vector3(-1, 0.75, 1.25).normalize(), size.length() * 2);
  camera.lookAt(centre);
  const shaded = new Scene();
  shaded.background = new Color(0xe9edf1);
  const sun = new DirectionalLight(0xffffff, 2.6);
  sun.position.set(-1.5, 3, 2);
  shaded.add(new HemisphereLight(0xf4f7ff, 0x8a7f72, 1.4), sun, object);
  const floor = new Mesh(new PlaneGeometry(1, 1), new MeshStandardMaterial({ color: 0xd8d4cc }));
  floor.scale.setScalar(size.length() * 6 + 1);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = box.min.y - size.y * 0.002;
  shaded.add(floor);
  renderer.render(shaded, camera);
  const left = await createImageBitmap(canvas);
  renderer.toneMapping = NoToneMapping;
  renderer.render(wire, camera);
  const right = await createImageBitmap(canvas);
  // The object back where it was (the shaded scene took it), the sheet's own geometries let go.
  shaded.remove(object);
  floor.geometry.dispose(); (floor.material as MeshStandardMaterial).dispose();
  fillMaterial.dispose(); edgeMaterial.dispose(); lineMaterial.dispose();
  const pad = 20, top = 120;
  const page = document.createElement('canvas');
  page.width = W * 2 + pad * 3; page.height = H + top + pad;
  const g = page.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, page.width, page.height);
  g.drawImage(left, pad, top); g.drawImage(right, W + pad * 2, top);
  g.fillStyle = '#141e28'; g.font = `bold ${Math.round(panel / 27)}px Segoe UI, sans-serif`;
  g.fillText(`${row.group} - ${row.name}${row.variation ? ` (${row.variation})` : ''}`, pad, 44);
  g.font = `${Math.round(panel / 36)}px Segoe UI, sans-serif`;
  // Its copies only where a test city counted them (a run without the game has none).
  const copies = row.instancesFrom ? ` x ${row.instances.toLocaleString('en')} copies = ${row.totalTriangles.toLocaleString('en')}` : '';
  g.fillText(`${row.triangles.toLocaleString('en')} triangles${copies}; ${row.vertices.toLocaleString('en')} vertices; ${(row.totalBytes / 1024).toFixed(0)} KB`, pad, 80);
  g.fillText(`${row.solids || row.build}${row.hiddenTriangles ? `; ${row.hiddenTriangles} hidden triangles` : ''}`, pad, 108);
  return page.toDataURL('image/png').split(',')[1] ?? null;
}

/** Puts the camera where the catalogue looks from (`setView` in degrees). */
export function catalogueView(x: number, y: number, zoom: number, azimuth: number, elevation: number): void {
  probe().setView({ x, y, zoom, azimuth: (azimuth * Math.PI) / 180, elevation: (elevation * Math.PI) / 180 });
}

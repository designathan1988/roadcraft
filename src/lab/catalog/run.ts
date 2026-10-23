import {
  ACESFilmicToneMapping, Box3, Color, DirectionalLight, HemisphereLight, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  NoToneMapping, PerspectiveCamera, PlaneGeometry, Scene, SRGBColorSpace, Vector3, WebGLRenderer, WireframeGeometry, type BufferGeometry, type Object3D,
} from 'three';
import { measureItem, type CatalogRow, type ItemSpec } from './items';
import { buildingKitItems, effectItems, elementItems, groundCoverItems, miscItems, sceneryItems, treeItems, vehicleItems } from './kits';
import { peopleAssetItems, peopleItems } from './people';
import { buildingItems, cityCounts, cityLayerItems, destructionPeak, drawCallsByGroup, previewItems, probe, sceneSnapshot, signatureOf, type SceneSeen } from './city';

/** THE CATALOGUE'S RUN IN THE GAME'S PAGE: the kits, then the test city, then the counts and shadows put together (`scripts/model-catalog.mjs` drives it). */

interface State {
  rows: CatalogRow[];
  objects: Map<string, Object3D>;
  signatures: Map<string, string[]>;
  gaps: string[];
  counts: Map<string, { n: number; from: string }>;
  seen: SceneSeen;
  drawCalls: Awaited<ReturnType<typeof drawCallsByGroup>> | null;
  destruction: Record<string, number> | null;
}

const state = (): State => {
  const w = window as unknown as { __catalogue?: State };
  w.__catalogue ??= { rows: [], objects: new Map(), signatures: new Map(), gaps: [], counts: new Map(), seen: { bySignature: new Map(), layers: new Map() }, drawCalls: null, destruction: null };
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
  } catch (error) {
    recordGap(`${base}: measuring failed: ${String(error)}`);
  }
}

/** Runs one group's builder; a group that fails is listed, the others go on. */
async function group(name: string, run: () => void | Promise<void>): Promise<void> {
  try { await run(); } catch (error) { recordGap(`${name}: could not be built: ${String(error)}`); }
}

/** Every kit, each object and variation built on its own; `proxies` the garment and hair files, `targetBytes` the shape targets' files. */
export async function catalogueKits(proxies: readonly string[], targetBytes: number): Promise<number> {
  await group('building kit and furniture', () => buildingKitItems(add));
  await group('landscape kit, street furniture, poles', () => sceneryItems(add));
  await group('ground cover', () => groundCoverItems(add));
  await group('trees', () => treeItems(add));
  await group('landscape elements (glTF)', () => elementItems(add));
  await group('vehicles', () => vehicleItems(add));
  await group('held props, trains, sky', () => miscItems(add));
  await group('effects', () => effectItems(add));
  await group('people: base body and garments', () => peopleAssetItems(add, proxies, targetBytes));
  await group('people: cast and crowd', () => peopleItems(add));
  return state().rows.length;
}

/** The test city is open: its buildings' records built alone, the editor's previews. */
export async function catalogueCityObjects(): Promise<number> {
  await group('buildings', () => buildingItems(add, state().counts));
  await group('editor previews', () => previewItems(add));
  return state().rows.length;
}

/** One view of the test city read. */
export function catalogueLook(): number {
  sceneSnapshot(state().seen);
  return state().seen.layers.size;
}

/** The test city's layers, its counts, every group's draw calls, the destruction's peak; then each row's copies, cost and shadow. */
export async function catalogueFinish(): Promise<number> {
  const s = state();
  await group('test city layers', () => cityLayerItems(add, s.seen, s.counts));
  await group('test city counts', () => cityCounts(s.counts));
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
    else if (named.length) { row.instances = Math.max(...named.map((l) => l.instances)); row.instancesFrom = `most copies the test city drew in one view (${named.map((l) => l.kind).slice(0, 3).join(', ')})`; }
    else if (shaped.length) { row.instances = Math.max(...shaped.map((m) => m.count)); row.instancesFrom = `most copies the test city drew in one view (same geometry: ${[...shaped[0]!.names].slice(0, 2).join(', ')})`; }
    else { row.instances = 0; row.instancesFrom = 'not found in the test city'; }
    if (row.countKey.startsWith('cast:')) {
      const seated = s.counts.get('cast:seated')?.n ?? 0;
      const cast = s.rows.filter((r) => r.countKey.startsWith('cast:')).length || 1;
      row.instances = Math.round(seated / cast); row.instancesFrom = 'people seated in vehicles, shared evenly over the cast';
    }
    row.totalTriangles = row.preview ? 0 : row.triangles * row.instances;
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

type SceneLayer = SceneSeen['layers'] extends Map<string, infer L> ? L : never;

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
export function catalogueResult(): { rows: CatalogRow[]; gaps: string[]; drawCalls: State['drawCalls']; destruction: State['destruction']; scene: unknown[] } {
  const s = state();
  const scene = [...s.seen.layers.values()].sort((a, b) => b.triangles - a.triangles).map((l) => ({
    layer: l.layer, kind: l.kind, meshes: l.meshes, copies: l.instances, triangles: l.triangles, bytes: l.bytes, casts: [...l.casts], materials: [...l.materials], released: l.released,
  }));
  return { rows: s.rows, gaps: s.gaps, drawCalls: s.drawCalls, destruction: s.destruction, scene };
}

/** One object's sheet: rendered and as a hidden-line wireframe side by side, titled; a PNG as base64. */
export async function catalogueSheet(id: string): Promise<string | null> {
  const s = state();
  const object = s.objects.get(id);
  const row = s.rows.find((r) => r.id === id);
  if (!object || !row || object.children.length === 0) return null;
  const W = 800, H = 800;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  const box = new Box3().setFromObject(object);
  const centre = box.getCenter(new Vector3()), size = box.getSize(new Vector3());
  // The wireframe made before anything is drawn: an upload lets some geometries' arrays go (`mesh/gpuOnly.ts`), and the edges are read from them.
  const wire = new Scene();
  wire.background = new Color(0xffffff);
  object.updateMatrixWorld(true);
  object.traverse((o) => {
    const g = (o as { geometry?: BufferGeometry }).geometry;
    if (!g) return;
    const fill = new Mesh(g, new MeshBasicMaterial({ color: 0xf7f8fa, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
    const lines = new LineSegments(new WireframeGeometry(g), new LineBasicMaterial({ color: 0x1b2a3a }));
    fill.matrix.copy(o.matrixWorld); fill.matrixAutoUpdate = false;
    lines.matrix.copy(o.matrixWorld); lines.matrixAutoUpdate = false;
    wire.add(fill, lines);
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
  renderer.dispose();
  const pad = 20, top = 120;
  const page = document.createElement('canvas');
  page.width = W * 2 + pad * 3; page.height = H + top + pad;
  const g = page.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, page.width, page.height);
  g.drawImage(left, pad, top); g.drawImage(right, W + pad * 2, top);
  g.fillStyle = '#141e28'; g.font = 'bold 30px Segoe UI, sans-serif';
  g.fillText(`${row.group} - ${row.name}${row.variation ? ` (${row.variation})` : ''}`, pad, 44);
  g.font = '22px Segoe UI, sans-serif';
  g.fillText(`${row.triangles.toLocaleString('en')} triangles x ${row.instances.toLocaleString('en')} copies = ${row.totalTriangles.toLocaleString('en')}; ${row.vertices.toLocaleString('en')} vertices; ${(row.totalBytes / 1024).toFixed(0)} KB`, pad, 80);
  g.fillText(`${row.solids || row.build}${row.hiddenTriangles ? `; ${row.hiddenTriangles} hidden triangles` : ''}`, pad, 108);
  return page.toDataURL('image/png').split(',')[1] ?? null;
}

/** Puts the camera where the catalogue looks from (`setView` in degrees). */
export function catalogueView(x: number, y: number, zoom: number, azimuth: number, elevation: number): void {
  probe().setView({ x, y, zoom, azimuth: (azimuth * Math.PI) / 180, elevation: (elevation * Math.PI) / 180 });
}

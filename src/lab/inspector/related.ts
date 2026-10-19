import type { Object3D } from 'three';
import { BUILDING_SWITCHES, LAYER_SWITCHES } from '@render/effectSwitches';
import { countMemory } from '@render/memoryCounters';

/** WHAT ELSE TOUCHES THE SELECTION: the effects panel's switches that hide it (by the layer groups `renderer.ts` `switchedOff` names and the buildings' parts and pieces, `buildingSwitches.ts`), the lab's optimisations of its system, its draws in the GPU tab's last capture, its memory, and the code that makes it (the dev server's source search, `scripts/vite/labSource.ts`). */

/** Each layer switch by the names of the groups it hides (`renderer.ts` `switchedOff`, the scene as built: `world`, `agent-parts`, `buildings-layer`...). */
const LAYER_BY_NAME: readonly (readonly [RegExp, (typeof LAYER_SWITCHES)[number]])[] = [
  [/^terrain-water|water/, 'water'],
  [/^terrain-|^flat-world/, 'terrain'],
  [/^roads-far-tiles$/, 'farRoads'],
  [/^road-network$|^road-structure-details$|^road-stand-ins$/, 'roads'],
  [/^buildings-layer$/, 'buildings'],
  [/^ground-cover$|^nature-cards$|^nature-forest$|^painted-forest$|^planted-forest$|^garden-|^far-forest/, 'vegetation'],
  [/^street-furniture$|^grass$/, 'furniture'],
  [/^signs$|^barriers$|^utilities$|^elements$/, 'props'],
  [/^transit$/, 'transit'],
  [/^agent-parts$/, 'people'],
  [/^densityCars$/, 'farTraffic'],
  [/^traffic-signals$/, 'signals'],
  [/^exhaust$/, 'particles'],
  [/^rain$|^lightning$/, 'weather'],
];

/** The buildings layer's roots (`BuildingLayer.roots`, named in `buildings/layer.ts`) and the switch of each. */
const BUILDING_ROOTS: readonly (readonly [RegExp, (typeof BUILDING_SWITCHES)[number]])[] = [
  [/^buildings-far$/, 'bMasses'],
  [/^buildings-far-tiles$/, 'bFarTiles'],
  [/^signature-buildings$/, 'bSignatures'],
  [/^building-part-cells$|^building-parts$/, 'bParts'],
  [/^flags$/, 'bFlags'],
  [/^buildings$/, 'bDetail'],
];

/** A piece of a building by its mesh's name (`buildingSwitches.ts` KIND_SWITCH). */
function buildingKindSwitch(name: string): (typeof BUILDING_SWITCHES)[number] | null {
  if (name === 'building-shell') return 'bShell';
  if (/^building-(glass|glassDark|glassRail)$/.test(name)) return 'bGlass';
  if (/^building-(frame|door|shutter)$/.test(name)) return 'bFrames';
  if (/^building-(railing|roofRailing|awning|column|water|lamp|wash|fin|louvre|brise)$/.test(name)) return 'bFacadeDetails';
  if (/^building-(lotBox|lotRail|lotSlab)$/.test(name)) return 'bLots';
  if (name.startsWith('building-furniture-')) return 'bFurniture';
  if (name.startsWith('building-')) return 'bProps';
  return null;
}

export interface SwitchLink { readonly key: string; readonly why: string }

/** The switches that hide the object or what it hangs from. */
export function switchesOf(object: Object3D): SwitchLink[] {
  const out: SwitchLink[] = [];
  const add = (key: string, why: string): void => { if (!out.some((s) => s.key === key)) out.push({ key, why }); };
  const chain: Object3D[] = [];
  for (let o: Object3D | null = object; o && o.parent; o = o.parent) chain.push(o);
  const inBuildings = chain.some((o) => o.name === 'buildings-layer');
  for (const o of chain) {
    for (const [re, key] of LAYER_BY_NAME) if (o.name && re.test(o.name)) add(key, `camada "${o.name}"`);
    if (inBuildings) {
      for (const [re, key] of BUILDING_ROOTS) if (o.name && re.test(o.name)) add(key, `raiz dos prédios "${o.name}"`);
      const kind = buildingKindSwitch(o.name);
      if (kind) add(kind, `peça "${o.name}"`);
    }
  }
  if (inBuildings) add('bShadows', 'sombras dos prédios');
  if ((object as { isLight?: boolean }).isLight || object.name === 'room-light') add('pointLights', 'luz pontual');
  return out;
}

/** The lab's optimisation systems (`optimizations.ts` OptSystem) that bear on the object's layer; the global ones always. */
export function optimizationSystemsOf(switches: readonly SwitchLink[], object: Object3D): string[] {
  const systems = new Set<string>(['renderer', 'culling', 'materials', 'textures', 'shadows', 'post', 'uploads']);
  const keys = new Set(switches.map((s) => s.key));
  if (keys.has('buildings')) systems.add('buildings');
  if (keys.has('terrain')) systems.add('terrain');
  if (keys.has('water')) systems.add('water');
  if (keys.has('roads') || keys.has('farRoads')) systems.add('roads');
  if (keys.has('vegetation') || keys.has('furniture')) systems.add('vegetation');
  if (keys.has('people')) { systems.add('people'); if (/car-|bus|truck|vehicle|bicycle|moto|van/.test(object.name)) systems.add('vehicles'); }
  if (keys.has('particles')) systems.add('particles');
  return [...systems];
}

/** The object's own memory (its subtree): buffers and textures, CPU and GPU. */
export function memoryOf(object: Object3D, uniformsOf?: (material: object) => Record<string, { value: unknown }> | undefined): ReturnType<typeof countMemory> {
  return countMemory(object, uniformsOf ? { uniformsOf } : {});
}

/** The GPU tab's last captured draws of an object (`window.__labGpu.drawsOf`); null when no capture or no GPU tab. */
export interface GpuDraw { readonly index: number; readonly pass: string; readonly program: string; readonly triangles: number; readonly instances: number; readonly calls: number; readonly target: string; readonly material: string }
export function gpuDrawsOf(object: Object3D): { readonly captured: boolean; readonly draws: GpuDraw[] } {
  const probe = (window as unknown as { __labGpu?: { drawsOf?(o: Object3D): GpuDraw[]; lastCapture?(): unknown } }).__labGpu;
  if (!probe?.drawsOf) return { captured: false, draws: [] };
  try {
    return { captured: !!probe.lastCapture?.(), draws: probe.drawsOf(object) };
  } catch (error) {
    console.warn('lab inspector: __labGpu.drawsOf failed', error);
    return { captured: false, draws: [] };
  }
}

/** One place in the sources a name is made (the dev server's search). */
export interface SourceHit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  /** The lines round it. */
  readonly context: string;
  readonly start: number;
  /** What it matched: the whole name, or a template's fixed part. */
  readonly how: string;
  readonly score: number;
}

/** The places in `src/` that make a name (`GET /__lab/source-find`, dev server only); an error's text when the server cannot answer. */
export async function findSource(name: string): Promise<SourceHit[] | string> {
  if (!name) return 'sem nome para procurar';
  try {
    const response = await fetch(`/__lab/source-find?q=${encodeURIComponent(name)}`);
    if (!response.ok) return `o servidor respondeu ${response.status} (só no servidor de desenvolvimento)`;
    const body = await response.json() as { hits?: SourceHit[] };
    return body.hits ?? [];
  } catch (error) {
    console.warn('lab inspector: source search failed', error);
    return `busca indisponível: ${String(error)}`;
  }
}

/** The file opened in the editor at its line (Vite's `/__open-in-editor`, the `launch-editor` middleware, dev server only). */
export function openInEditor(file: string, line: number): void {
  void fetch(`/__open-in-editor?file=${encodeURIComponent(`${file}:${line}`)}`).then((r) => {
    if (!r.ok) console.warn('lab inspector: editor not opened', r.status);
  }, (error: unknown) => console.warn('lab inspector: editor not opened', error));
}

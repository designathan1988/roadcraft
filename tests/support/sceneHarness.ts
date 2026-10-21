import type { BatchedMesh, InstancedMesh, Object3D } from 'three';

import { Engine } from '@core/engine';
import { restoreInto } from '@editor/history';
import { buildSmallCityMap } from '@editor/smallCityMap';
import type { QualityLevel } from '@render/quality';
import { createSceneRenderer, type SceneHandle } from '@render/renderer';
import { SimClient } from '@sim/host/simClient';
import { RoadDoc, type SerializedDoc } from '@world/doc';
import { Network } from '@world/network';
import { RELIEF_FLAT } from '@world/terrain';
import { NullCanvas, nullRenderer } from './nullGpu';

/**
 * THE SMALL CITY OPENED ON THE NULL GPU, shared by the scene's census (`tests/census/sceneCensus.spec.ts`) and the tiers' budgets
 * (`tests/perf/budgets.spec.ts`): the real scene renderer on three's WebGLRenderer over a null WebGL2 context (`nullGpu.ts`, its page
 * installed by the spec), the small city of seed 7 opened as the menu opens it (`main.ts` openCity), the camera put where
 * `window.__roadcraft.setView` puts it, and frames drawn until a view stands.
 */

export const WIDTH = 1280;
export const HEIGHT = 720;
/** Frames the opening, or a view, may take before the harness gives up on it. */
const MOST_FRAMES = 600;
/** Frames in a row with the same count for a view to be taken as settled. */
const STILL_FRAMES = 8;

/** A view as `scripts/look/verify.json` setView takes it: x, y, zoom, azimuth and elevation in degrees. */
export type View = readonly [x: number, y: number, zoom: number, azimuth: number, elevation: number];
/** The views of the game's photographs (`scripts/look/verify.json`): the whole small city, the district over the centre, the street. */
export const MAP: View = [0, 0, 0.6, 45, 48];
export const DISTRICT: View = [0, 0, 2.5, 45, 48];
export const STREET: View = [60, 0, 5, 20, 35];

/** A turn of the event loop: what the frame left to promises, imports and timers runs, as between two animation frames. */
const turn = (): Promise<void> => new Promise((done) => setImmediate(done));

export interface City { readonly scene: SceneHandle; readonly doc: RoadDoc; readonly net: Network; readonly sim: SimClient }

/** One frame as `main.ts` draws it: the network caught up, the scene drawn, the page's loop turned. */
async function frame(city: City): Promise<void> {
  if (city.net.revision !== city.doc.revision) city.net.rebuild();
  city.scene.draw(city.net, city.sim, 1, 1 / 60);
  await turn();
}

/** The camera where `window.__roadcraft.setView` puts it (`main.ts`). */
export function setView(scene: SceneHandle, [x, y, zoom, azimuth, elevation]: View): void {
  const view = scene.viewport;
  view.moveTo({ x, y });
  view.zoomAt(WIDTH / 2, HEIGHT / 2, zoom / Math.max(0.001, view.zoom), WIDTH, HEIGHT);
  view.setOrbit((azimuth * Math.PI) / 180, (elevation * Math.PI) / 180);
  view.moveTo({ x, y });
}

interface Counted { objects: number; drawn: number }
export interface Census { byName: Record<string, Counted>; objects: number; drawn: number; draws: number; triangles: number; points: number; lines: number }

/** Every visible drawable under the scene, by name without digits (how many objects, how many things drawn), and three's last frame. */
function census(scene: SceneHandle): Census {
  const byName = new Map<string, Counted>();
  let objects = 0, drawn = 0;
  scene.scene.traverseVisible((o: Object3D) => {
    const kind = o as Object3D & { isMesh?: boolean; isInstancedMesh?: boolean; isBatchedMesh?: boolean; isPoints?: boolean; isLine?: boolean };
    if (!kind.isMesh && !kind.isPoints && !kind.isLine) return;
    let things = 1;
    if (kind.isInstancedMesh) things = (o as InstancedMesh).count;
    else if (kind.isBatchedMesh) {
      // Its visible instances (three r186 keeps them in `_instanceInfo`; `instanceCount` counts the hidden too).
      const info = (o as BatchedMesh & { _instanceInfo: readonly { active: boolean; visible: boolean }[] })._instanceInfo;
      things = info.reduce((n, i) => n + (i.active && i.visible ? 1 : 0), 0);
    }
    const name = (o.name || o.type).replace(/\d+/g, '');
    const row = byName.get(name) ?? { objects: 0, drawn: 0 };
    row.objects++;
    row.drawn += things;
    byName.set(name, row);
    objects++;
    drawn += things;
  });
  const sorted: Record<string, Counted> = {};
  for (const key of [...byName.keys()].sort()) sorted[key] = byName.get(key)!;
  const render = scene.gl.info.render;
  return { byName: sorted, objects, drawn, draws: render.calls, triangles: render.triangles, points: render.points, lines: render.lines };
}

/** A view settled, and the most three issued in one frame on the way there (`peak`: the frames that drew the shadow cascades whole). */
export interface Settled { readonly census: Census; readonly peak: { readonly draws: number; readonly triangles: number } }

/**
 * Frames until the view stands: the same census `STILL_FRAMES` frames in a row, the world's work done, and a frame drawn (a quality
 * change holds the last picture while its programs build: such a frame issues no draw at all, `renderer.ts` compileChanged).
 */
export async function settle(city: City): Promise<Settled> {
  let last = '', still = 0, peakDraws = 0, peakTriangles = 0;
  for (let frames = 0; frames < MOST_FRAMES; frames++) {
    await frame(city);
    const now = census(city.scene);
    peakDraws = Math.max(peakDraws, now.draws);
    peakTriangles = Math.max(peakTriangles, now.triangles);
    const key = JSON.stringify(now);
    still = key === last && now.draws > 0 && !city.scene.worldBusy ? still + 1 : 0;
    last = key;
    if (still >= STILL_FRAMES) return { census: now, peak: { draws: peakDraws, triangles: peakTriangles } };
  }
  throw new Error(`the view did not settle in ${MOST_FRAMES} frames`);
}

/** The small city of seed 7 opened as the menu opens it on tier `quality`, the camera at the district view, frames until the curtain comes down. */
export async function openSmallCity(quality: QualityLevel = 'ultra'): Promise<City> {
  return (await openCityMap(buildSmallCityMap(7), null, { quality })).city;
}

/** One frame of an opening as the probes see it: the frame's number, and what the reveal still waited for (`SceneHandle.openingState`). */
export type OpeningFrame = { readonly frame: number } & ReturnType<SceneHandle['openingState']>;

/**
 * A city opened as the menu opens it (`main.ts` openCity): `table`, its buildings' table as the city's worker prepares it (`prepareCity`);
 * `large`, scoped to its opening view (`scopeOpening`, a city of over 5,000 buildings). Frames until the curtain comes down, each frame's
 * wait given to `onFrame`; `frames`, how many it took.
 */
export async function openCityMap(data: SerializedDoc, table: ArrayBufferLike | null, options: { quality?: QualityLevel; large?: boolean; view?: View; onFrame?: (state: OpeningFrame, scene: SceneHandle) => void } = {}): Promise<{ city: City; frames: number }> {
  const doc = new RoadDoc();
  doc.terrainRelief = RELIEF_FLAT;
  const net = new Network(doc);
  const sim = new SimClient(doc, net);
  const canvas = new NullCanvas(WIDTH, HEIGHT);
  const view = options.view ?? DISTRICT;
  const scene = createSceneRenderer(canvas as unknown as HTMLCanvasElement, { x: 0, y: 0 }, view[2], options.quality ?? 'ultra', () => {}, new Engine(), undefined, nullRenderer);
  scene.setSkyMode('day');
  const city = { scene, doc, net, sim };
  // The empty map the game starts on, drawn once.
  await frame(city);
  if (options.large) scene.scopeOpening(true);
  restoreInto(doc, { ...data, relief: RELIEF_FLAT, markingStyle: 'br' }, net, table);
  sim.load();
  scene.beginLoad();
  setView(scene, view);
  let frames = 0;
  for (; scene.opening; frames++) {
    if (frames >= MOST_FRAMES) throw new Error(`the opening was not shown in ${MOST_FRAMES} frames`);
    await frame(city);
    options.onFrame?.({ frame: frames, ...scene.openingState() }, scene);
  }
  return { city, frames };
}

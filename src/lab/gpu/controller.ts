import type { RenderTarget } from 'three';
import type { LabContext } from '../labTypes';
import { createGpuProbe, type DrawRecord, type GpuProbe, type LayerCount } from './probe';
import { createPassTimer, spread, type PassFrame, type PassTimer } from './passTimer';
import { createDebugViews, type DebugViews } from './views';
import { createProgramTracker, type ProgramTracker } from './programs';
import { scanGpuObjects, type GpuObjects } from './memory';

/** THE LAB'S GPU AREA, ITS STATE: the per-pass timing mode, the frame capture, the live counters by layer, the debug views, the programs and the GPU's objects. The tabs (`passesTab.ts`, `frameTab.ts`, `objectsTab.ts`) draw it; the report and `window.__labGpu` read it. */

export const PASS_LABELS: Record<string, string> = {
  shadows: 'Mapas de sombra',
  scene: 'Cena (sem sombras)',
  gtao: 'GTAO',
  canyon: 'Luz de cânion',
  bloom: 'Bloom',
  clouds: 'Nuvens',
  smaa: 'SMAA',
  output: 'Saída',
};
export const PASS_ORDER = ['shadows', 'scene', 'gtao', 'canyon', 'bloom', 'clouds', 'smaa', 'output'];

export interface PassRow {
  readonly pass: string;
  readonly label: string;
  readonly frames: number;
  readonly avg: number;
  readonly p95: number;
  readonly max: number;
  /** Of the frames' summed average, %. */
  readonly share: number;
}

export interface Capture {
  readonly t: number;
  readonly records: readonly DrawRecord[];
  readonly targets: readonly RenderTarget[];
}

export interface AggregateRow {
  readonly key: string;
  calls: number;
  draws: number;
  triangles: number;
  vertices: number;
  instances: number;
  readonly programs: Set<string>;
  readonly materials: Set<string>;
}

export interface GpuLab {
  readonly ctx: LabContext;
  readonly probe: GpuProbe;
  readonly views: DebugViews;
  readonly programs: ProgramTracker;
  readonly passTiming: boolean;
  /** Per-pass timing on: the whole-frame timer paused, the frames drawn one after another while on. */
  setPassTiming(on: boolean): void;
  passRows(): PassRow[];
  passFrames(): readonly PassFrame[];
  readonly timer: PassTimer | null;
  readonly liveLayers: boolean;
  setLiveLayers(on: boolean): void;
  /** The last frame's draws by layer (live counters). */
  layerRows(): { layer: string; calls: number; triangles: number }[];
  readonly lastCapture: Capture | null;
  /** One frame's every draw (the next frame drawn). */
  capture(): Promise<Capture>;
  /** Scanned again when asked (`refreshObjects`). */
  objects(): GpuObjects;
  refreshObjects(): GpuObjects;
  readonly contextEvents: readonly { t: number; kind: string }[];
  /** The report's section. */
  report(): unknown;
  dispose(): void;
}

/** Records grouped by `key`. */
export function aggregate(records: readonly DrawRecord[], key: (r: DrawRecord) => string): AggregateRow[] {
  const rows = new Map<string, AggregateRow>();
  for (const r of records) {
    const k = key(r);
    let row = rows.get(k);
    if (!row) { row = { key: k, calls: 0, draws: 0, triangles: 0, vertices: 0, instances: 0, programs: new Set(), materials: new Set() }; rows.set(k, row); }
    row.calls += r.calls;
    row.draws++;
    row.triangles += r.triangles;
    row.vertices += r.vertices;
    row.instances += r.instances;
    row.programs.add(r.programKey);
    row.materials.add(`${r.material}:${r.materialName}`);
  }
  return [...rows.values()];
}

const CAPTURE_GIVE_UP_FRAMES = 60;
/** The chain's passes that read the scene's depth (`effectSwitches.ts` POST_SWITCHES). */
const DEPTH_PASSES = ['ambientOcclusion', 'canyonLight', 'clouds'];
const TOP = 25;

export function createGpuLab(ctx: LabContext): GpuLab {
  const renderer = ctx.scene.gl;
  const probe = createGpuProbe(renderer, ctx.scene.scene);
  /** The depth-reading passes as they stood before a recolouring view switched them off (null: not switched). */
  let depthPasses: Record<string, boolean> | null = null;
  const views = createDebugViews(ctx.scene.scene, renderer.capabilities.reversedDepthBuffer, (view) => {
    // Overdraw and normals leave a depth the occlusion and the clouds read as nothing like the scene (the last fragment's, or a colour of no light): those passes off while shown, as they were after.
    const recolour = view === 'overdraw' || view === 'normals';
    if (recolour && !depthPasses) {
      const now = ctx.effects.snapshot();
      depthPasses = Object.fromEntries(DEPTH_PASSES.map((k) => [k, now[k] !== false]));
      ctx.effects.setMany(Object.fromEntries(DEPTH_PASSES.map((k) => [k, false])));
    } else if (!recolour && depthPasses) {
      ctx.effects.setMany(depthPasses);
      depthPasses = null;
    }
    probe.update();
    ctx.emit('gpu.view', `vista de depuração: ${view}`, { view });
    ctx.requestDraw();
  });
  probe.views = views;
  const programs = createProgramTracker(ctx, renderer, () => probe.pass);
  let timer: PassTimer | null = null;
  let liveLayers = false;
  let lastLayers = new Map<string, LayerCount>();
  let lastCapture: Capture | null = null;
  let objects: GpuObjects | null = null;
  let pending: { resolve: (c: Capture) => void; waited: number } | null = null;
  let stopFrames: (() => void) | null = null;
  const contextEvents: { t: number; kind: string }[] = [];

  const canvas = renderer.domElement;
  const onLost = (e: Event): void => {
    contextEvents.push({ t: performance.now(), kind: 'perdido' });
    ctx.emit('gpu.context', 'contexto WebGL perdido', { type: e.type });
  };
  const onRestored = (e: Event): void => {
    contextEvents.push({ t: performance.now(), kind: 'restaurado' });
    ctx.emit('gpu.context', 'contexto WebGL restaurado', { type: e.type });
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  const finishCapture = (): void => {
    if (!pending) return;
    const records = probe.capture ?? [];
    lastCapture = { t: performance.now(), records, targets: [...probe.targets] };
    probe.capture = null;
    probe.targets.clear();
    const done = pending;
    pending = null;
    listen();
    const tris = records.reduce((a, r) => a + r.triangles, 0);
    ctx.emit('gpu.capture', `quadro capturado: ${records.length} desenhos, ${Math.round(tris).toLocaleString('pt-BR')} triângulos`, { draws: records.length, triangles: tris });
    done.resolve(lastCapture);
  };

  const onFrame = (): void => {
    if (timer) {
      timer.frameEnded();
      timer.poll();
      // Measured frame after frame while the mode is on (the loop draws on demand otherwise). DO NOT ask while the opening is still being put together: no chain is drawn then, and frames asked back to back starve the workers it waits on (`renderer.ts` lookAgain).
      if (!ctx.scene.opening) ctx.requestDraw();
    }
    if (probe.layers) {
      lastLayers = probe.layers;
      probe.layers = new Map();
    }
    if (pending) {
      if ((probe.capture?.length ?? 0) > 0 || ++pending.waited > CAPTURE_GIVE_UP_FRAMES) finishCapture();
      else if (!ctx.scene.opening) ctx.requestDraw();
    }
  };
  /** The frames listened to only while something needs them; the hooks in only then. */
  function listen(): void {
    probe.update();
    const want = timer !== null || liveLayers || pending !== null;
    if (want && !stopFrames) stopFrames = ctx.onFrame(onFrame);
    else if (!want && stopFrames) { stopFrames(); stopFrames = null; }
  }

  const passRows = (): PassRow[] => {
    const frames = timer?.frames ?? [];
    const labels = new Set<string>();
    for (const f of frames) for (const k of f.keys()) labels.add(k);
    const rows = [...labels].map((pass) => {
      const values = frames.map((f) => f.get(pass) ?? 0);
      return { pass, label: PASS_LABELS[pass] ?? pass, frames: frames.filter((f) => f.has(pass)).length, ...spread(values), share: 0 };
    });
    const total = rows.reduce((a, r) => a + r.avg, 0);
    return rows.map((r) => ({ ...r, share: total > 0 ? (100 * r.avg) / total : 0 }));
  };

  const scan = (): GpuObjects => (objects = scanGpuObjects(renderer, ctx.scene.scene, lastCapture?.targets ?? []));

  const lab: GpuLab = {
    ctx,
    probe,
    views,
    programs,
    get passTiming() { return timer !== null; },
    setPassTiming(on) {
      if (on === (timer !== null)) return;
      if (on) {
        if (!ctx.scene.gpu.supported) return;
        ctx.scene.gpu.pause(true);
        timer = createPassTimer(renderer);
        probe.timer = timer;
        ctx.emit('gpu.passTiming', 'tempo por passe ligado (cronômetro do quadro pausado)');
        ctx.requestDraw();
      } else {
        timer?.dispose();
        timer = null;
        probe.timer = null;
        ctx.scene.gpu.pause(false);
        ctx.emit('gpu.passTiming', 'tempo por passe desligado');
      }
      listen();
    },
    passRows,
    passFrames: () => timer?.frames ?? [],
    get timer() { return timer; },
    get liveLayers() { return liveLayers; },
    setLiveLayers(on) {
      liveLayers = on;
      probe.layers = on ? new Map() : null;
      if (!on) lastLayers = new Map();
      listen();
      ctx.requestDraw();
    },
    layerRows: () => [...lastLayers].map(([layer, c]) => ({ layer, calls: c.calls, triangles: c.triangles })),
    get lastCapture() { return lastCapture; },
    capture() {
      if (pending) return new Promise((resolve) => { const before = pending!.resolve; pending!.resolve = (c) => { before(c); resolve(c); }; });
      return new Promise((resolve) => {
        pending = { resolve, waited: 0 };
        probe.capture = [];
        probe.targets.clear();
        listen();
        ctx.requestDraw();
      });
    },
    objects: () => objects ?? scan(),
    refreshObjects: scan,
    contextEvents,
    report() {
      const records = lastCapture?.records ?? [];
      const top = (rows: AggregateRow[]): unknown[] => rows.sort((a, b) => b.triangles - a.triangles).slice(0, TOP)
        .map((r) => ({ key: r.key, draws: r.draws, calls: r.calls, triangles: r.triangles, vertices: r.vertices, instances: r.instances, programs: r.programs.size, materials: r.materials.size }));
      const o = scan();
      const sum = (list: readonly { bytes: number }[]): number => list.reduce((a, r) => a + r.bytes, 0);
      const big = <T extends { bytes: number }>(list: readonly T[]): T[] => [...list].sort((a, b) => b.bytes - a.bytes).slice(0, TOP);
      return {
        passTiming: timer ? { on: true, frames: timer.frames.length, skipped: timer.skipped, disjoint: timer.disjoint, passes: passRows() } : { on: false },
        debugView: views.current,
        liveLayers: liveLayers ? lab.layerRows() : null,
        capture: lastCapture ? {
          ageMs: Math.round(performance.now() - lastCapture.t),
          draws: records.length,
          calls: records.reduce((a, r) => a + r.calls, 0),
          triangles: records.reduce((a, r) => a + r.triangles, 0),
          byLayer: top(aggregate(records, (r) => r.layer)),
          byMaterial: top(aggregate(records, (r) => `${r.material} ${r.materialName}`)),
          byProgram: top(aggregate(records, (r) => r.program)),
          byPass: top(aggregate(records, (r) => r.pass)),
        } : null,
        programs: {
          live: programs.rows.filter((r) => r.alive).length,
          made: programs.made,
          released: programs.released,
          newest: programs.rows.slice(-TOP).map((r) => ({ id: r.id, name: r.name, key: r.key, usedTimes: r.usedTimes, alive: r.alive, firstSeenMs: Math.round(r.firstSeen), trigger: r.trigger })),
        },
        memory: {
          textures: o.textures.length, textureBytes: sum(o.textures),
          targets: o.targets.length, targetBytes: sum(o.targets),
          geometries: o.geometries.length, geometryBytes: sum(o.geometries),
          topTextures: big(o.textures), topTargets: big(o.targets), topGeometries: big(o.geometries),
        },
        contextEvents,
      };
    },
    dispose() {
      lab.setPassTiming(false);
      lab.setLiveLayers(false);
      views.dispose();
      programs.dispose();
      probe.dispose();
      stopFrames?.();
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
    },
  };
  return lab;
}

import type { Engine } from '@core/engine';
import type { FrameRecord, FrameTimer } from '@core/health';
import type { SceneHandle } from '@render/renderer';
import type { SimClient } from '@sim/host/simClient';
import type { EffectsWiring } from '../effectsWiring';
import { type LabContext, type LabSubject, type LabEvent, type LabSample, type LabTab } from './labTypes';
import { createLabTabs } from './tabs';
import { createUsageMeter } from './usage';
import { createLabWindow } from './window';
import './lab.css';

/** THE DEBUGGING LAB (F7): one window of tabs over the game - the switches and optimisations, what every system costs, the code that runs, the GPU's passes, the recordings and the tests. Every tab is handed the same context (`labTypes.ts`). */

export interface LabDeps {
  readonly scene: SceneHandle;
  readonly sim: SimClient;
  readonly engine: Engine;
  readonly frameTimer: FrameTimer;
  readonly effects: EffectsWiring;
  /** Picks a quality preset as the menu does (`graphicsWiring.ts`). */
  setPreset(level: string): void;
  requestDraw(): void;
}

export interface Lab {
  readonly context: LabContext;
  toggle(): void;
  /** Opens it, on the tab `id` if given. */
  open(id?: string): void;
  close(): boolean;
  /** After each frame drawn (`main.ts` frame). */
  frameEnded(frame: FrameRecord): void;
}

const EVENTS_KEPT = 5000;

export function createLab(deps: LabDeps): Lab {
  const events: LabEvent[] = [];
  const eventListeners: ((event: LabEvent) => void)[] = [];
  const frameListeners: ((sample: LabSample, frame: FrameRecord) => void)[] = [];
  const sections = new Map<string, () => unknown>();
  let navigateTo: (id: string, params?: Readonly<Record<string, string>>) => void = () => {};
  let investigateWith: (subject: LabSubject) => void = () => {};
  const productListeners: ((name: string, phase: string, ms: number, keys: number, idle: boolean) => void)[] = [];
  const listen = <T>(list: T[], listener: T): (() => void) => {
    list.push(listener);
    return () => { const i = list.indexOf(listener); if (i >= 0) list.splice(i, 1); };
  };
  // The engine's one slot shared: the profiler's listener (DEV) kept, the lab's told after it.
  const before = deps.engine.onRefresh;
  deps.engine.onRefresh = (name, phase, ms, keys, idle) => {
    before?.(name, phase, ms, keys, idle);
    for (const listener of productListeners) listener(name, phase, ms, keys, idle);
  };

  const context: LabContext = {
    scene: deps.scene,
    sim: deps.sim,
    engine: deps.engine,
    frameTimer: deps.frameTimer,
    effects: deps.effects,
    requestDraw: deps.requestDraw,
    quality: {
      level: () => String(deps.scene.quality),
      levels: ['low', 'medium', 'high', 'ultra'],
      setPreset(level) {
        context.emit('quality.preset', `predefinição = ${level}`, { level });
        deps.setPreset(level);
      },
    },
    emit(kind, detail, data) {
      const event: LabEvent = { t: performance.now(), kind, detail, ...(data === undefined ? {} : { data }) };
      events.push(event);
      if (events.length > EVENTS_KEPT) events.splice(0, events.length - EVENTS_KEPT);
      // A copy: a listener that stops itself while told does not skip the next one.
      for (const listener of [...eventListeners]) listener(event);
    },
    onEvent: (listener) => listen(eventListeners, listener),
    onFrame: (listener) => listen(frameListeners, listener),
    onProduct: (listener) => listen(productListeners, listener),
    events: () => events,
    navigate: (id, params) => navigateTo(id, params),
    investigate: (subject) => investigateWith(subject),
    reportSection(name, collect) {
      sections.set(name, collect);
    },
    collectReport() {
      const out: Record<string, unknown> = {};
      for (const [name, collect] of sections) {
        try {
          out[name] = collect();
        } catch (error) {
          console.error(`lab report section ${name} failed`, error);
          out[name] = { error: String(error) };
        }
      }
      return out;
    },
  };
  deps.effects.onChange((key, value) => context.emit(`switch.${key}`, `${key} = ${String(value)}`, { key, value }));

  const tabs: LabTab[] = createLabTabs(context);
  const usage = createUsageMeter(context);
  const win = createLabWindow(context, tabs, usage);
  navigateTo = (id, params) => win.open(id, params);
  investigateWith = (subject) => win.investigate(subject);

  // ---- the frames
  let lastStart = 0;
  const lab: Lab = {
    context,
    open(id) {
      win.open(id);
    },
    close: () => win.close(),
    toggle() {
      if (!win.close()) win.open();
    },
    frameEnded(frame) {
      if (!frameListeners.length) { lastStart = frame.start; return; }
      const scene = deps.scene;
      const ring = scene.gpu.samples;
      const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
      const sample: LabSample = {
        t: frame.end,
        intervalMs: lastStart ? frame.start - lastStart : 0,
        cpuMs: frame.end - frame.start,
        systems: frame.systems,
        gpuMs: scene.gpu.supported && ring.pushed > 0 ? ring.newest(0) : null,
        drawCalls: scene.stats.drawCalls,
        triangles: scene.stats.drawnTriangles,
        heapMB: heap ? heap.usedJSHeapSize / 1048576 : null,
        pixelRatio: scene.gl.getPixelRatio(),
      };
      lastStart = frame.start;
      for (const listener of frameListeners) listener(sample, frame);
    },
  };
  return lab;
}

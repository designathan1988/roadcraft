import type { Engine } from '@core/engine';
import type { FrameRecord, FrameTimer } from '@core/health';
import type { SceneHandle } from '@render/renderer';
import type { SimClient } from '@sim/host/simClient';
import type { EffectsWiring } from '../effectsWiring';
import { LAB_REFRESH_MS, type LabContext, type LabEvent, type LabSample, type LabTab } from './labTypes';
import { createLabTabs } from './tabs';
import './lab.css';

/** THE DEBUGGING LAB (F7): one window of tabs over the game - the switches and optimisations, what every system costs, the code that runs, the GPU's passes, the recordings and the tests. Every tab is handed the same context (`labTypes.ts`). */

export interface LabDeps {
  readonly scene: SceneHandle;
  readonly sim: SimClient;
  readonly engine: Engine;
  readonly frameTimer: FrameTimer;
  readonly effects: EffectsWiring;
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
    emit(kind, detail, data) {
      const event: LabEvent = { t: performance.now(), kind, detail, ...(data === undefined ? {} : { data }) };
      events.push(event);
      if (events.length > EVENTS_KEPT) events.splice(0, events.length - EVENTS_KEPT);
      for (const listener of eventListeners) listener(event);
    },
    onEvent: (listener) => listen(eventListeners, listener),
    onFrame: (listener) => listen(frameListeners, listener),
    onProduct: (listener) => listen(productListeners, listener),
    events: () => events,
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

  // ---- the window
  const panel = document.createElement('aside');
  panel.className = 'lab-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Laboratório de depuração');
  const header = document.createElement('header');
  const title = document.createElement('strong');
  title.textContent = 'Laboratório';
  const tabBar = document.createElement('nav');
  tabBar.className = 'lab-tabs';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'lab-close';
  close.textContent = '×';
  close.title = 'Fechar (Esc, F7)';
  header.append(title, tabBar, close);
  const body = document.createElement('section');
  body.className = 'lab-body';
  panel.append(header, body);
  document.body.appendChild(panel);

  // Dragged by its head.
  header.addEventListener('pointerdown', (e) => {
    if (e.target !== header && e.target !== title) return;
    const rect = panel.getBoundingClientRect();
    const dx = e.clientX - rect.left, dy = e.clientY - rect.top;
    const move = (m: PointerEvent): void => {
      panel.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, m.clientX - dx))}px`;
      panel.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, m.clientY - dy))}px`;
      panel.style.right = 'auto';
    };
    const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  const tabs: LabTab[] = createLabTabs(context);
  let current: LabTab | null = null;
  let timer: number | null = null;
  const buttons = new Map<string, HTMLButtonElement>();
  for (const tab of tabs) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = tab.title;
    b.onclick = () => show(tab.id);
    buttons.set(tab.id, b);
    tabBar.appendChild(b);
  }

  function show(id: string): void {
    const tab = tabs.find((t) => t.id === id) ?? tabs[0];
    if (!tab) return;
    if (current && current !== tab) current.unmount?.();
    current = tab;
    for (const [key, b] of buttons) b.classList.toggle('on', key === tab.id);
    body.replaceChildren();
    tab.mount(body);
    try { window.localStorage.setItem('roadcraft.lab.tab', tab.id); } catch (error) { console.warn('lab tab not kept', error); }
  }
  const tick = (): void => {
    try {
      current?.refresh?.();
    } catch (error) {
      console.error('lab tab refresh failed', error);
    }
  };

  // ---- the frames
  let lastStart = 0;
  const lab: Lab = {
    context,
    open(id) {
      panel.hidden = false;
      let kept: string | null = null;
      try { kept = window.localStorage.getItem('roadcraft.lab.tab'); } catch (error) { console.warn('lab tab not read', error); }
      show(id ?? current?.id ?? kept ?? tabs[0]?.id ?? '');
      timer ??= window.setInterval(tick, LAB_REFRESH_MS);
      context.emit('lab.open', 'laboratório aberto');
    },
    close() {
      if (panel.hidden) return false;
      panel.hidden = true;
      current?.unmount?.();
      current = null;
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      return true;
    },
    toggle() {
      if (!lab.close()) lab.open();
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
  close.onclick = () => lab.close();
  return lab;
}

import type { Engine } from '@core/engine';
import type { FrameRecord, FrameTimer } from '@core/health';
import type { SceneHandle } from '@render/renderer';
import type { SimClient } from '@sim/host/simClient';
import type { EffectsWiring } from '../effectsWiring';

/** THE LAB'S CONTRACT: what every tab of the debugging lab (F7, `lab.ts`) is handed and gives back. */

/** Something that happened, on the page's clock (`performance.now()`): a switch flipped, a test begun, a long task, a hitch. */
export interface LabEvent {
  readonly t: number;
  /** Dotted, the area first: `switch.bShadows`, `opt.anisotropy`, `test.sweep`, `quality.preset`, `longtask`... */
  readonly kind: string;
  readonly detail: string;
  readonly data?: unknown;
}

/** One frame as the lab saw it: its times, what it drew, the heap. */
export interface LabSample {
  readonly t: number;
  /** From the last frame's start to this one's: what the player waits. */
  readonly intervalMs: number;
  /** The frame's own work on the main thread (`FrameTimer`). */
  readonly cpuMs: number;
  /** The frame's systems, ms (`FrameSystem`). */
  readonly systems: ReadonlyMap<string, number>;
  /** The GPU time of the newest frame measured (`gpuTimer.ts`, a few frames late); null: no timer. */
  readonly gpuMs: number | null;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly heapMB: number | null;
  readonly pixelRatio: number;
}

export interface LabContext {
  readonly scene: SceneHandle;
  readonly sim: SimClient;
  readonly engine: Engine;
  readonly frameTimer: FrameTimer;
  /** The switches, the building settings and every optimisation (`effectsWiring.ts`). */
  readonly effects: EffectsWiring;
  /** A frame asked for. */
  requestDraw(): void;
  /** Told to every listener and kept for the recorder. */
  emit(kind: string, detail: string, data?: unknown): void;
  /** Every event from now on; the call returned stops it. */
  onEvent(listener: (event: LabEvent) => void): () => void;
  /** Every frame from now on, once it is drawn; the call returned stops it. */
  onFrame(listener: (sample: LabSample, frame: FrameRecord) => void): () => void;
  /** Every refresh of the engine's products (`Engine.onRefresh`, shared with the profiler). */
  onProduct(listener: (name: string, phase: string, ms: number, keys: number, idle: boolean) => void): () => void;
  /** The events kept (the last 5000). */
  events(): readonly LabEvent[];
  /** A section every report carries (the recorder's, the tests'): `collect` asked when the report is made, its answer JSON-able. Each area registers its own (the consumers, the code profile, the GPU passes...). */
  reportSection(name: string, collect: () => unknown): void;
  /** Every section registered, collected now (`name` → data; a failing one gives its error). */
  collectReport(): Record<string, unknown>;
  /** Shows the tab `id` (the lab opened if closed) and hands it `params` (`LabTab.focus`): a usage meter clicked opens what consumes it. */
  navigate(id: string, params?: Readonly<Record<string, string>>): void;
}

/** A tab of the lab: built once, mounted when shown, refreshed a few times a second while shown. */
export interface LabTab {
  readonly id: string;
  readonly title: string;
  /** The tab's content into `host` (emptied before). */
  mount(host: HTMLElement): void;
  /** While shown, every `LAB_REFRESH_MS`. */
  refresh?(): void;
  /** Hidden (another tab, or the lab closed). */
  unmount?(): void;
  /** Asked to show something in particular, after `mount` (`LabContext.navigate`): e.g. `{ category: 'GPU' }`, `{ filter: 'shadow' }`, `{ id: 'bShadows' }`. */
  focus?(params: Readonly<Record<string, string>>): void;
}

export const LAB_REFRESH_MS = 300;

import { gpuLedger } from '@render/gpuLedger';
import type { LabContext, LabSample } from './labTypes';

/** THE LAB'S USAGE METERS: how much of each resource the game is taking now, as a share - the main thread, the GPU, the JS heap, the video memory, the disk - over the last second. */

export interface UsageReading {
  readonly id: 'cpu' | 'gpu' | 'ram' | 'vram' | 'disk' | 'fps' | 'draws';
  readonly label: string;
  /** 0..100, null when it cannot be read here. */
  readonly percent: number | null;
  /** The value as shown under the share ("12,4 ms", "812 MB / 4 GB"). */
  readonly detail: string;
  /** What the share is a share of. */
  readonly title: string;
}

export interface UsageMeter {
  readings(): readonly UsageReading[];
  /** The last minute of each share, one value a second (sparklines). */
  history(id: UsageReading['id']): readonly number[];
  /** The lab window opened or closed: the GPU's objects are scanned only while it is open (MDN `requestIdleCallback`). */
  setActive(active: boolean): void;
  dispose(): void;
}

const WINDOW_MS = 1000;
const HISTORY = 60;
const mb = (bytes: number): string => (bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(2)} GB` : `${(bytes / 1048576).toFixed(0)} MB`);

export function createUsageMeter(ctx: LabContext): UsageMeter {
  const frames: LabSample[] = [];
  const histories = new Map<UsageReading['id'], number[]>();
  let storage: { usage: number; quota: number } | null = null;
  let lastSecond = 0;
  let current: UsageReading[] = [];

  const readStorage = (): void => {
    if (!navigator.storage?.estimate) return;
    void navigator.storage.estimate().then((e) => { storage = { usage: e.usage ?? 0, quota: e.quota ?? 0 }; },
      (error: unknown) => console.warn('lab: storage estimate unread', error));
  };
  /** The video memory as found on the GPU (`lab/gpu` objects: textures and geometries, buffers shared counted once) plus the frame's targets and shadow maps: DO NOT add `gpuLedger.bytes()` to `targetBytes()`, the ledger holds those targets too, and it holds neither the textures nor the detail's geometry. */
  let vramFound: number | null = null;
  let active = false;
  let idle: number | null = null;
  const readVram = (): void => {
    const gpu = (window as unknown as { __labGpu?: { objects(): { textures: { bytes: number }[]; geometries: { bytes: number }[] } } }).__labGpu;
    if (!gpu) return;
    try {
      const o = gpu.objects();
      vramFound = o.textures.reduce((a, x) => a + x.bytes, 0) + o.geometries.reduce((a, x) => a + x.bytes, 0) + ctx.scene.targetBytes();
    } catch (error) {
      console.warn('lab: video memory not scanned', error);
    }
  };
  /** The scan walks the whole scene (textures and geometries), 170 ms in the audit: only when the lab is open, in an idle period, and never in the middle of a frame. */
  const scanWhenIdle = (): void => {
    if (!active || idle !== null) return;
    idle = window.requestIdleCallback(() => {
      idle = null;
      if (active) readVram();
    }, { timeout: 2_000 });
  };

  const compute = (now: number): UsageReading[] => {
    while (frames.length && frames[0]!.t < now - WINDOW_MS) frames.shift();
    const span = frames.length > 1 ? Math.max(1, frames[frames.length - 1]!.t - frames[0]!.t + frames[0]!.intervalMs) : WINDOW_MS;
    let cpu = 0, gpu = 0, gpuN = 0, draws = 0;
    for (const f of frames) {
      cpu += f.cpuMs;
      draws += f.drawCalls;
      if (f.gpuMs !== null) { gpu += f.gpuMs; gpuN++; }
    }
    const n = frames.length;
    const fps = n > 1 ? (n - 1) / ((frames[n - 1]!.t - frames[0]!.t) / 1000) : 0;
    const gpuAvg = gpuN ? gpu / gpuN : null;
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    // The scene's own targets are cheap; the full scan is the lab's, and only while its window is open.
    const vram = vramFound ?? gpuLedger.bytes();
    const counted = gpuLedger.bytes();
    const cap = gpuLedger.cap;
    const clamp = (v: number): number => Math.max(0, Math.min(100, v));
    return [
      { id: 'cpu', label: 'CPU', percent: n ? clamp((cpu / span) * 100) : null,
        detail: n ? `${(cpu / n).toFixed(1)} ms/quadro` : 'parado', title: 'Thread principal: o tempo dos quadros sobre o tempo passado (último segundo). Clique: o que consome a CPU.' },
      { id: 'gpu', label: 'GPU', percent: gpuAvg === null ? null : clamp(((gpuAvg * n) / span) * 100),
        detail: gpuAvg === null ? 'sem medidor' : `${gpuAvg.toFixed(1)} ms/quadro`, title: 'O tempo da GPU por quadro vezes os quadros, sobre o tempo passado. Clique: os passes da GPU.' },
      { id: 'ram', label: 'RAM', percent: heap ? clamp((heap.usedJSHeapSize / heap.jsHeapSizeLimit) * 100) : null,
        detail: heap ? `${mb(heap.usedJSHeapSize)} / ${mb(heap.jsHeapSizeLimit)}` : 'indisponível', title: 'Heap JS da página sobre o limite do heap. Clique: o que ocupa a memória.' },
      { id: 'vram', label: 'VRAM', percent: Number.isFinite(cap) && cap > 0 ? clamp((vram / cap) * 100) : null,
        detail: `${mb(vram)}${Number.isFinite(cap) ? ` / ${mb(cap)}` : ''} (o jogo conta ${mb(counted)})`, title: 'Memória de vídeo achada na GPU (texturas + geometrias + alvos e sombras) sobre o teto do dispositivo; entre parênteses o que o gpuLedger do jogo conta. Clique: os objetos na GPU.' },
      { id: 'disk', label: 'Disco', percent: storage && storage.quota > 0 ? clamp((storage.usage / storage.quota) * 100) : null,
        detail: storage ? `${mb(storage.usage)} / ${mb(storage.quota)}` : 'indisponível', title: 'Armazenamento do site (IndexedDB, OPFS, cache) sobre a cota. Clique: o que usa o disco.' },
      { id: 'fps', label: 'FPS', percent: n > 1 ? clamp((fps / 60) * 100) : null,
        detail: n > 1 ? `${fps.toFixed(0)} q/s` : 'parado', title: 'Quadros por segundo sobre 60. Clique: a visão geral.' },
      { id: 'draws', label: 'Draws', percent: n ? clamp((draws / n / 1000) * 100) : null,
        detail: n ? `${Math.round(draws / n)} chamadas` : '-', title: 'Chamadas de desenho por quadro sobre 1000 (o orçamento da vista). Clique: capturar um quadro.' },
    ];
  };

  const stop = ctx.onFrame((sample) => {
    frames.push(sample);
    if (sample.t - lastSecond >= 1000) {
      lastSecond = sample.t;
      current = compute(sample.t);
      for (const r of current) {
        const h = histories.get(r.id) ?? [];
        h.push(r.percent ?? 0);
        if (h.length > HISTORY) h.shift();
        histories.set(r.id, h);
      }
    }
  });

  return {
    readings() {
      // Nothing drawn for a while (the game still): the frames of the window are stale.
      if (!frames.length || performance.now() - frames[frames.length - 1]!.t > 2000) current = compute(performance.now());
      return current.length ? current : compute(performance.now());
    },
    history: (id) => histories.get(id) ?? [],
    setActive(next) {
      if (next === active) return;
      active = next;
      if (idle !== null) { window.cancelIdleCallback(idle); idle = null; }
      if (!next) return;
      readStorage();
      scanWhenIdle();
    },
    dispose() {
      stop();
      if (idle !== null) window.cancelIdleCallback(idle);
    },
  };
}

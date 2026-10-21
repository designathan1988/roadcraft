import { LONG_FRAME_MS } from '@core/health';
import { jobPoolStats } from '@/jobs/jobPool';
import { gpuLedger } from '@render/gpuLedger';
import type { LabContext, LabSample } from '../labTypes';
import { MeterBook, type ResourceCategory, type MeterKind } from './meter';

/** THE RESOURCES' COLLECTOR: every source of cost the lab reads, gathered into one book of meters (`meter.ts`) and the overview's frames - the frames' systems, the platform's measures, long tasks and long animation frames with their scripts, the engine's products, the heap, video memory by owner, the job pool, the simulation's worker, storage and the network */

/** One frame kept for the overview's graphs. */
export interface FramePoint {
  readonly t: number;
  readonly interval: number;
  readonly cpu: number;
  /** Null: no new GPU time this frame (the timer is a few frames late, or absent). */
  readonly gpu: number | null;
  readonly draws: number;
  readonly triangles: number;
  readonly heap: number | null;
}

/** A long animation frame as kept (W3C Long Animation Frames: `duration`, `blockingDuration`, `scripts`). */
export interface LongFrame {
  readonly t: number;
  readonly duration: number;
  readonly blocking: number;
  readonly scripts: readonly { readonly what: string; readonly url: string; readonly duration: number; readonly forced: number }[];
}

/** A slow reading of the platform, taken now and then: storage, the user agent's memory, the battery. */
export interface PlatformReadings {
  storage: { usage: number; quota: number; details: Record<string, number>; persisted: boolean | null; at: number } | null;
  idbNames: string[] | null;
  opfs: { files: number; bytes: number; truncated: boolean } | null;
  uaMemory: { bytes: number; at: number; ms: number; breakdown: { scope: string; url: string; bytes: number; types: string }[] } | null;
  uaMemoryError: string | null;
  uaMemoryRunning: boolean;
  battery: { charging: boolean; level: number } | null;
}

/** One reading of the GPU's objects (`renderer.info`), for the growth checks. */
export interface GlPoint {
  readonly t: number;
  readonly geometries: number;
  readonly textures: number;
  readonly programs: number;
  readonly heap: number | null;
}

/** How long the overview's frames are kept, ms. */
const FRAMES_KEPT_MS = 60_000;
/** Readings of the GPU's objects kept (one a second): ten minutes. */
const GL_POINTS_KEPT = 600;
/** The slow readings' period: the pool, the ledger, the targets each second; storage every `STORAGE_EVERY` of them. */
const POLL_MS = 1000;
const STORAGE_EVERY = 15;
/** The user agent's memory measured at random times, a mean of this apart (MDN `measureUserAgentSpecificMemory`: a Poisson process, never in step with what the player does). */
const UA_MEMORY_MEAN_MS = 60_000;
/** The origin's private file system walked at most this many entries deep in all. */
const OPFS_MOST = 4000;

type Heap = { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
type ScriptEntry = { duration: number; invoker?: string; invokerType?: string; sourceURL?: string; sourceFunctionName?: string; sourceCharPosition?: number; forcedStyleAndLayoutDuration?: number };
type LoafEntry = PerformanceEntry & { blockingDuration?: number; scripts?: readonly ScriptEntry[] };
type ResourceEntry = PerformanceResourceTiming;

/** A URL shown short: its path without the query, the host only when it is not this page's. */
export function shortUrl(url: string): string {
  if (!url) return '';
  try {
    const u = new URL(url, location.href);
    const path = u.pathname.replace(/^\/@fs\/.*?\/src\//, 'src/').replace(/^\/src\//, 'src/');
    return u.origin === location.origin ? path : `${u.host}${path}`;
  } catch (error) {
    console.warn('lab: unreadable url', url, error);
    return url;
  }
}

/** A GPU ledger's owner named: a string as it is (its first two `|` parts), an object by its name or its type. */
export function ownerLabel(owner: unknown): string {
  if (typeof owner === 'string') return owner.split('|').slice(0, 2).join(' ');
  const o = owner as { name?: unknown; type?: unknown; constructor?: { name?: string } } | null;
  if (o && typeof o.name === 'string' && o.name) return o.name;
  if (o && typeof o.type === 'string') return o.type;
  return o?.constructor?.name ?? typeof owner;
}

export interface Collector {
  readonly book: MeterBook;
  /** The frames of the last 60 s, oldest first. */
  frames(): readonly FramePoint[];
  readonly longFrames: LongFrame[];
  /** Times of the long tasks seen (`longtask`), the last 500. */
  readonly longTasks: number[];
  readonly glPoints: GlPoint[];
  readonly platform: PlatformReadings;
  /** Times the page was hidden and shown again (`visibilitychange`), the last 50. */
  readonly visibility: { t: number; hidden: boolean }[];
  /** When collecting began, and when it was last reset. */
  readonly startedAt: number;
  readonly resetAt: number;
  /** Every meter emptied, and the long frames and tasks forgotten. */
  reset(): void;
  /** The user agent's memory measured now (it may take seconds: the browser waits for its next collection). */
  measureMemory(): Promise<void>;
  /** Storage, the databases and the private file system read again. */
  readStorage(): Promise<void>;
}

export function createCollector(ctx: LabContext): Collector {
  const book = new MeterBook();
  const kept: FramePoint[] = [];
  let firstKept = 0;
  const longFrames: LongFrame[] = [];
  const longTasks: number[] = [];
  const glPoints: GlPoint[] = [];
  const visibility: { t: number; hidden: boolean }[] = [];
  const platform: PlatformReadings = { storage: null, idbNames: null, opfs: null, uaMemory: null, uaMemoryError: null, uaMemoryRunning: false, battery: null };
  let lastGpuPushed = -1;
  let lastHeap: number | null = null;
  let lastTick = -1;
  let polls = 0;
  let lastSubmitted = -1;
  let lastPollAt = performance.now();
  const startedAt = performance.now();
  let resetAt = startedAt;

  const event = (key: string, name: string, category: ResourceCategory, source: string, unit: string, value: number, t: number, kind: MeterKind = 'event'): void => {
    book.meter(key, name, category, source, unit, kind).add(value, t);
  };
  const gauge = (key: string, name: string, category: ResourceCategory, source: string, unit: string, value: number, t: number, note = ''): void => {
    const m = book.meter(key, name, category, source, unit, 'gauge');
    m.add(value, t);
    m.note = note;
  };

  // ---- the frames
  ctx.onFrame((sample: LabSample) => {
    const t = sample.t;
    const ring = ctx.scene.gpu.samples;
    const freshGpu = ctx.scene.gpu.supported && ring.pushed > 0 && ring.pushed !== lastGpuPushed ? ring.newest(0) : null;
    lastGpuPushed = ring.pushed;
    kept.push({ t, interval: sample.intervalMs, cpu: sample.cpuMs, gpu: freshGpu, draws: sample.drawCalls, triangles: sample.triangles, heap: sample.heapMB });
    // Old frames dropped in batches (never one `shift` a frame).
    while (firstKept < kept.length && kept[firstKept]!.t < t - FRAMES_KEPT_MS) firstKept++;
    if (firstKept > 1024) { kept.splice(0, firstKept); firstKept = 0; }

    // The interval is a wait, not work: a level (no total, no ms/s).
    if (sample.intervalMs > 0) event('frame.interval', 'frame: interval', 'CPU-main', 'frame', 'ms', sample.intervalMs, t, 'gauge');
    event('frame.cpu', 'frame: CPU (frame work)', 'CPU-main', 'FrameTimer', 'ms', sample.cpuMs, t);
    for (const [system, ms] of sample.systems) event(`system.${system}`, `system: ${system}`, 'CPU-main', 'FrameTimer', 'ms', ms, t);
    if (freshGpu !== null) event('frame.gpu', 'frame: GPU', 'GPU', 'gpuTimer (EXT_disjoint_timer_query)', 'ms', freshGpu, t);
    event('frame.draws', 'frame: draw calls', 'GPU', 'renderer.stats', 'calls', sample.drawCalls, t);
    event('frame.triangles', 'frame: triangles drawn', 'GPU', 'renderer.stats', 'triangles', sample.triangles, t);
    if (sample.heapMB !== null) {
      gauge('heap.used', 'JS heap used (page)', 'RAM', 'performance.memory', 'MB', sample.heapMB, t);
      // A drop of the heap between two frames: a collection ran (its size, MB).
      if (lastHeap !== null && sample.heapMB < lastHeap - 0.5) event('heap.gc', 'garbage collection (heap drop)', 'RAM', 'performance.memory', 'MB', lastHeap - sample.heapMB, t);
      lastHeap = sample.heapMB;
    }
    // The simulation's worker: its step, each new tick it sent.
    const sim = ctx.sim;
    if (sim.tick !== lastTick) {
      lastTick = sim.tick;
      if (sim.lastStepMs > 0) event('sim.step', 'simulation: step (worker)', 'CPU-worker', 'simClient.lastStepMs', 'ms', sim.lastStepMs, t);
      if (sim.lastSteps > 0) event('sim.steps', 'simulation: steps per tick', 'CPU-worker', 'simClient.lastSteps', 'steps', sim.lastSteps, t);
    }
  });

  // ---- the engine's products
  const idleRuns = new Map<string, number>();
  ctx.onProduct((name, phase, ms, keys, idle) => {
    const key = `product.${name}.${phase}`;
    const m = book.meter(key, `product: ${name} (${phase})`, 'CPU-main', 'Engine.onRefresh', 'ms', 'event');
    m.add(ms, performance.now());
    if (idle) idleRuns.set(key, (idleRuns.get(key) ?? 0) + 1);
    const idles = idleRuns.get(key) ?? 0;
    m.note = `${keys} keys${idles ? ` · IDLE ${idles}× (computed with no input changed)` : ''}`;
  });

  // ---- the platform's timeline (W3C Performance Timeline: PerformanceObserver)
  const supported = typeof PerformanceObserver !== 'undefined' ? PerformanceObserver.supportedEntryTypes : [];
  const observe = (type: string, buffered: boolean, take: (entries: PerformanceEntryList) => void): void => {
    if (!supported.includes(type)) return;
    try {
      new PerformanceObserver((list) => take(list.getEntries())).observe({ type, buffered });
    } catch (error) {
      console.warn(`lab: no ${type} observer`, error);
    }
  };
  observe('measure', false, (entries) => {
    for (const m of entries) {
      const hitch = m.name.startsWith('hitch:');
      const name = hitch ? m.name.slice(6) : m.name;
      event(`measure.${m.name}`, `measure: ${name}`, 'CPU-main', hitch ? 'measureHitch (hitch:)' : 'performance.measure', 'ms', m.duration, m.startTime + m.duration);
    }
  });
  observe('longtask', false, (entries) => {
    for (const e of entries) {
      event('longtask', 'long task (> 50 ms)', 'CPU-main', 'PerformanceObserver longtask', 'ms', e.duration, e.startTime);
      longTasks.push(e.startTime);
      if (longTasks.length > 500) longTasks.splice(0, longTasks.length - 500);
    }
  });
  // Long animation frames (W3C LoAF): the frame, its blocking, and each script over 5 ms with its source (`sourceURL`, `sourceFunctionName`, `invoker`, `forcedStyleAndLayoutDuration`).
  observe('long-animation-frame', true, (entries) => {
    for (const raw of entries) {
      const e = raw as LoafEntry;
      const t = e.startTime + e.duration;
      // Buffered frames from before collecting began (or before a reset) are kept as frames but not metered: a window's ms/s would count them on seconds it never had.
      const metered = t >= resetAt;
      if (metered) event('loaf', 'long animation frame (LoAF)', 'CPU-main', 'PerformanceObserver long-animation-frame', 'ms', e.duration, t);
      if (metered && e.blockingDuration) event('loaf.blocking', 'LoAF: blocking (blockingDuration)', 'CPU-main', 'PerformanceObserver long-animation-frame', 'ms', e.blockingDuration, t);
      const scripts: LongFrame['scripts'][number][] = [];
      for (const s of e.scripts ?? []) {
        const url = shortUrl(s.sourceURL ?? '');
        const fn = s.sourceFunctionName || '(anonymous)';
        const what = `${s.invokerType ?? '?'} ${s.invoker ?? ''} → ${fn}`;
        const where = `${url}${s.sourceCharPosition !== undefined && s.sourceCharPosition >= 0 ? `@${s.sourceCharPosition}` : ''}`;
        const forced = s.forcedStyleAndLayoutDuration ?? 0;
        scripts.push({ what, url: where, duration: s.duration, forced });
        if (!metered) continue;
        const key = `loaf.script.${s.invokerType}.${s.invoker}.${fn}.${url}`;
        const m = book.meter(key, `LoAF script: ${what}`, 'CPU-main', where || 'LoAF scripts', 'ms', 'event');
        m.add(s.duration, t);
        if (forced > 0) {
          const f = book.meter(`${key}.forced`, `forced layout/style: ${fn}`, 'CPU-main', where || 'LoAF scripts', 'ms', 'event');
          f.add(forced, t);
        }
      }
      longFrames.push({ t: e.startTime, duration: e.duration, blocking: e.blockingDuration ?? 0, scripts });
      if (longFrames.length > 300) longFrames.splice(0, longFrames.length - 300);
      if (e.duration >= LONG_FRAME_MS) ctx.emit('resources.loaf', `long frame ${Math.round(e.duration)} ms`, { blocking: e.blockingDuration ?? 0 });
    }
  });
  // The network: every resource the page fetched (W3C Resource Timing), buffered ones too; sizes 0 when cached or cross-origin without Timing-Allow-Origin (MDN).
  observe('resource', true, (entries) => {
    for (const raw of entries) {
      const e = raw as ResourceEntry;
      const url = shortUrl(e.name);
      const t = e.responseEnd || e.startTime + e.duration;
      const m = book.meter(`net.${url}`, `resource: ${url}`, 'Network', e.initiatorType, 'ms', 'event');
      m.add(e.duration, t);
      const cached = e.transferSize === 0 && e.decodedBodySize > 0;
      m.note = `${(e.transferSize / 1024).toFixed(1)} KB transferred · ${(e.decodedBodySize / 1024).toFixed(1)} KB decoded${cached ? ' · cache' : ''}${e.responseStatus ? ` · HTTP ${e.responseStatus}` : ''}`;
      event(`net.bytes.${e.initiatorType}`, `network: bytes transferred (${e.initiatorType})`, 'Network', 'Resource Timing', 'bytes', e.transferSize, t);
    }
  });
  document.addEventListener('visibilitychange', () => {
    visibility.push({ t: performance.now(), hidden: document.hidden });
    if (visibility.length > 50) visibility.shift();
    ctx.emit('resources.visibility', document.hidden ? 'page hidden' : 'page visible');
  });

  // ---- the slow readings
  const poll = (): void => {
    const now = performance.now();
    const seconds = Math.max(0.001, (now - lastPollAt) / 1000);
    lastPollAt = now;
    polls++;
    const heap = (performance as Performance & { memory?: Heap }).memory;
    if (heap) {
      gauge('heap.total', 'JS heap reserved (page)', 'RAM', 'performance.memory', 'MB', heap.totalJSHeapSize / 1048576, now);
      gauge('heap.limit', 'JS heap: limit', 'RAM', 'performance.memory', 'MB', heap.jsHeapSizeLimit / 1048576, now);
    }
    // Video memory: the ledger's classes and its largest owners, the targets, the buildings' detail, three's own counts.
    const byClass = new Map<string, { bytes: number; triangles: number; owners: number }>();
    const byOwner = new Map<string, { bytes: number; cls: string; owners: number }>();
    for (const e of gpuLedger.entries()) {
      const c = byClass.get(e.cls) ?? { bytes: 0, triangles: 0, owners: 0 };
      c.bytes += e.bytes; c.triangles += e.triangles; c.owners++;
      byClass.set(e.cls, c);
      const label = `${e.cls} · ${ownerLabel(e.owner)}`;
      const o = byOwner.get(label) ?? { bytes: 0, cls: e.cls, owners: 0 };
      o.bytes += e.bytes; o.owners++;
      byOwner.set(label, o);
    }
    const owners = [...byOwner].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 40);
    // A class or an owner gone from the book: its level falls to 0 (kept as a row, said so).
    const present = new Set([...[...byClass.keys()].map((c) => `vram.class.${c}`), ...owners.map(([label]) => `vram.owner.${label}`)]);
    for (const m of book.all()) {
      if (!(m.key.startsWith('vram.class.') || m.key.startsWith('vram.owner.')) || present.has(m.key)) continue;
      if (m.read('5s', now).last !== 0) m.add(0, now);
      m.note = 'nothing in the ledger now';
    }
    for (const [cls, c] of byClass) gauge(`vram.class.${cls}`, `VRAM class: ${cls}`, 'VRAM', 'gpuLedger (class)', 'MB', c.bytes / 1048576, now, `${c.owners} owners · ${c.triangles.toLocaleString('en-US')} triangles`);
    for (const [label, o] of owners) {
      gauge(`vram.owner.${label}`, `VRAM owner: ${label}`, 'VRAM', 'gpuLedger (owner)', 'MB', o.bytes / 1048576, now, `${o.owners} entries`);
    }
    const cap = gpuLedger.cap;
    gauge('vram.ledger', 'VRAM: ledger total (gpuLedger)', 'VRAM', 'gpuLedger', 'MB', gpuLedger.bytes() / 1048576, now, Number.isFinite(cap) ? `cap ${(cap / 1048576).toFixed(0)} MB (${((gpuLedger.bytes() / cap) * 100).toFixed(0)}%)` : 'no cap');
    gauge('vram.targets', 'VRAM: render targets and shadows', 'VRAM', 'scene.targetBytes', 'MB', ctx.scene.targetBytes() / 1048576, now);
    gauge('vram.buildingDetail', 'VRAM: building detail', 'VRAM', 'scene.buildingDetailBytes', 'MB', ctx.scene.buildingDetailBytes() / 1048576, now);
    const info = ctx.scene.gl.info;
    const programs = info.programs?.length ?? 0;
    gauge('gl.geometries', 'GPU: live geometries (three)', 'VRAM', 'renderer.info.memory', 'objects', info.memory.geometries, now);
    gauge('gl.textures', 'GPU: live textures (three)', 'VRAM', 'renderer.info.memory', 'objects', info.memory.textures, now);
    gauge('gl.programs', 'GPU: shader programs', 'GPU', 'renderer.info.programs', 'programs', programs, now);
    glPoints.push({ t: now, geometries: info.memory.geometries, textures: info.memory.textures, programs, heap: heap ? heap.usedJSHeapSize / 1048576 : null });
    if (glPoints.length > GL_POINTS_KEPT) glPoints.shift();

    // The job pool.
    const pool = jobPoolStats();
    const busy = pool.workers.filter((w) => w.running !== null || w.laneWork > 0).length;
    gauge('pool.workers', 'job pool: live workers', 'CPU-worker', 'jobPool', 'workers', pool.workers.length, now, `max ${pool.most} (${pool.longMost} long, ${pool.shortMost} short) · ${pool.ports} ports`);
    gauge('pool.busy', 'job pool: busy workers', 'CPU-worker', 'jobPool', 'workers', busy, now);
    gauge('pool.waiting', 'job pool: queue (waiting)', 'CPU-worker', 'jobPool', 'jobs', pool.waiting, now);
    if (lastSubmitted >= 0) gauge('pool.rate', 'job pool: requests per second', 'CPU-worker', 'jobPool', 'jobs/s', (pool.submitted - lastSubmitted) / seconds, now);
    lastSubmitted = pool.submitted;
    pool.workers.forEach((w, i) => {
      const lanes = w.lanes.map(([s, n]) => `${s}×${n}`).join(', ');
      gauge(`pool.worker.${i}`, `worker ${i + 1} (${w.long ? 'long' : 'short'}${w.inPage ? '' : ', desktop process'})`, 'CPU-worker', 'jobPool', 'busy', w.running !== null || w.laneWork > 0 ? 1 : 0, now,
        `${w.failed ? 'FAILED · ' : ''}${w.running ? `running ${w.running} · ` : ''}${lanes ? `lanes ${lanes} · ` : ''}${w.laneWork} pending msgs${w.idleMs !== null ? ` · idle ${(w.idleMs / 1000).toFixed(0)} s` : ''}`);
    });
    // The simulation's worker.
    const stats = ctx.sim.stats;
    if (stats) {
      gauge('sim.vehicles', 'simulation: vehicles', 'CPU-worker', 'simClient.stats', 'vehicles', stats.vehicles, now);
      gauge('sim.people', 'simulation: people', 'CPU-worker', 'simClient.stats', 'people', stats.people, now);
      gauge('sim.stepMs', 'simulation: step (worker stats)', 'CPU-worker', 'simClient.stats.stepMs', 'ms', stats.stepMs, now);
    }
    if (polls % STORAGE_EVERY === 1) void readStorage();
  };

  async function readStorage(): Promise<void> {
    const now = performance.now();
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    try {
      if (storage?.estimate) {
        const e = await storage.estimate() as StorageEstimate & { usageDetails?: Record<string, number> };
        const persisted = storage.persisted ? await storage.persisted() : null;
        platform.storage = { usage: e.usage ?? 0, quota: e.quota ?? 0, details: { ...(e.usageDetails ?? {}) }, persisted, at: now };
        gauge('disk.usage', 'storage: origin usage', 'Disk', 'navigator.storage.estimate', 'MB', (e.usage ?? 0) / 1048576, now,
          `quota ${((e.quota ?? 0) / 1048576).toFixed(0)} MB (${e.quota ? (((e.usage ?? 0) / e.quota) * 100).toFixed(1) : '?'}%)${persisted === null ? '' : persisted ? ' · persistent' : ' · may be evicted'}`);
        // `usageDetails` (Chromium): each storage system with use above 0; a missing key is 0 (MDN).
        for (const [kind, bytes] of Object.entries(e.usageDetails ?? {})) gauge(`disk.detail.${kind}`, `storage: ${kind}`, 'Disk', 'storage.estimate usageDetails', 'MB', bytes / 1048576, now);
      }
    } catch (error) {
      console.warn('lab: storage estimate failed', error);
    }
    try {
      if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
        const dbs = await indexedDB.databases();
        platform.idbNames = dbs.map((d) => `${d.name ?? '?'} v${d.version ?? '?'}`);
        gauge('disk.idb', 'IndexedDB: databases', 'Disk', 'indexedDB.databases', 'databases', dbs.length, now, platform.idbNames.join(', '));
      }
    } catch (error) {
      console.warn('lab: indexedDB.databases failed', error);
    }
    try {
      if (storage?.getDirectory) {
        const root = await storage.getDirectory();
        let files = 0, bytes = 0, seen = 0;
        const walk = async (dir: FileSystemDirectoryHandle): Promise<void> => {
          for await (const handle of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
            if (++seen > OPFS_MOST) return;
            if (handle.kind === 'file') { files++; bytes += (await (handle as FileSystemFileHandle).getFile()).size; } else await walk(handle as FileSystemDirectoryHandle);
          }
        };
        await walk(root);
        platform.opfs = { files, bytes, truncated: seen > OPFS_MOST };
        gauge('disk.opfs', 'OPFS: origin private file system', 'Disk', 'navigator.storage.getDirectory', 'MB', bytes / 1048576, now, `${files} files${seen > OPFS_MOST ? ' (list truncated)' : ''}`);
      }
    } catch (error) {
      console.warn('lab: OPFS walk failed', error);
    }
    const desktop = (window as unknown as { roadcraftDesktop?: unknown }).roadcraftDesktop;
    if (desktop) gauge('disk.desktop', 'desktop saves', 'Disk', 'roadcraftDesktop (save process)', 'on', 1, now, 'written by the desktop process: size not exposed to the page');
    try {
      const getBattery = (navigator as Navigator & { getBattery?: () => Promise<{ charging: boolean; level: number }> }).getBattery;
      if (getBattery) {
        const b = await getBattery.call(navigator);
        platform.battery = { charging: b.charging, level: b.level };
      }
    } catch (error) {
      console.warn('lab: battery not read', error);
    }
  }

  // The user agent's memory (MDN `measureUserAgentSpecificMemory`: cross-origin isolated pages only; the page, its workers, its frames).
  async function measureMemory(): Promise<void> {
    const measure = (performance as Performance & { measureUserAgentSpecificMemory?: () => Promise<{ bytes: number; breakdown: { bytes: number; types: string[]; attribution: { url: string; scope: string }[] }[] }> }).measureUserAgentSpecificMemory;
    if (!measure || !globalThis.crossOriginIsolated) { platform.uaMemoryError = !measure ? 'API missing in this browser' : 'page not isolated (crossOriginIsolated false)'; return; }
    if (platform.uaMemoryRunning) return;
    platform.uaMemoryRunning = true;
    const begun = performance.now();
    try {
      const result = await measure.call(performance);
      const now = performance.now();
      const groups = new Map<string, { scope: string; url: string; bytes: number; types: Set<string> }>();
      for (const b of result.breakdown) {
        const a = b.attribution[0];
        const scope = a?.scope ?? '(no attribution)';
        const url = a ? shortUrl(a.url) : '';
        const key = `${scope}|${url}`;
        const g = groups.get(key) ?? { scope, url, bytes: 0, types: new Set<string>() };
        g.bytes += b.bytes;
        for (const t of b.types) g.types.add(t);
        groups.set(key, g);
      }
      const breakdown = [...groups.values()].map((g) => ({ scope: g.scope, url: g.url, bytes: g.bytes, types: [...g.types].join('/') })).sort((x, y) => y.bytes - x.bytes);
      platform.uaMemory = { bytes: result.bytes, at: now, ms: now - begun, breakdown };
      platform.uaMemoryError = null;
      gauge('ua.total', 'user agent memory (page + workers)', 'RAM', 'measureUserAgentSpecificMemory', 'MB', result.bytes / 1048576, now, `measured in ${((now - begun) / 1000).toFixed(1)} s`);
      for (const g of breakdown) {
        const category: ResourceCategory = 'RAM';
        gauge(`ua.${g.scope}|${g.url}`, `memory: ${g.scope === 'Window' ? 'page' : g.scope === 'DedicatedWorkerGlobalScope' ? 'worker' : g.scope} ${g.url}`, category, 'measureUserAgentSpecificMemory', 'MB', g.bytes / 1048576, now, g.types);
      }
    } catch (error) {
      platform.uaMemoryError = String(error);
      console.warn('lab: measureUserAgentSpecificMemory failed', error);
    } finally {
      platform.uaMemoryRunning = false;
    }
  }
  // Measured at random, a Poisson process (MDN): the next one an exponential time after this one ends.
  const scheduleMemory = (): void => {
    const wait = -Math.log(1 - Math.random()) * UA_MEMORY_MEAN_MS;
    window.setTimeout(() => { void measureMemory().finally(scheduleMemory); }, wait);
  };

  window.setInterval(poll, POLL_MS);
  poll();
  void measureMemory().finally(scheduleMemory);

  const collector: Collector = {
    book,
    frames: () => (firstKept ? kept.slice(firstKept) : kept),
    longFrames,
    longTasks,
    glPoints,
    platform,
    visibility,
    startedAt,
    get resetAt() { return resetAt; },
    reset() {
      book.reset();
      idleRuns.clear();
      longFrames.length = 0;
      longTasks.length = 0;
      resetAt = performance.now();
      ctx.emit('resources.reset', 'consumer measures reset');
    },
    measureMemory,
    readStorage,
  };
  return collector;
}

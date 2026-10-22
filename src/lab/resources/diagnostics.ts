import { integratedGpu } from '@render/gpuLedger';
import { jobPoolStats } from '@/jobs/jobPool';
import { createLabTable } from '../table';
import type { LabContext, LabTab } from '../labTypes';
import type { Collector, GlPoint } from './collector';
import { slope } from './meter';
import { summarize } from './overview';

/** THE LAB'S DIAGNOSTICS ("Checks"): the machine, the browser and the game's resources checked one by one, each with its verdict (ok, warning, problem), what it read and why it matters, and the tab where to look further */

export type Verdict = 'ok' | 'warning' | 'problem' | 'info';

export interface Check {
  readonly id: string;
  readonly title: string;
  readonly verdict: Verdict;
  readonly value: string;
  readonly why: string;
  /** The title of the lab's tab to look at next (clicked: shown). */
  readonly tab: string;
  /** What that tab is asked to show (`LabTab.focus`): the consumers' category, a filter. */
  readonly focus?: Readonly<Record<string, string>>;
}

/** The lab's tabs the checks lead to, by title. */
const TAB_IDS: Readonly<Record<string, string>> = { Overview: 'overview', Consumers: 'consumers', Switches: 'switches' };

const RANK: Readonly<Record<Verdict, number>> = { problem: 3, warning: 2, info: 1, ok: 0 };

/** A GPU named by software (no hardware drawing): every frame on the CPU. */
const SOFTWARE = /SwiftShader|llvmpipe|Software|Microsoft Basic Render/i;

/** A count of the GPU's objects (`renderer.info`) growing over the readings of the last `ms` while the world stood: the slope a minute and the rise. */
function growth(points: readonly GlPoint[], pick: (p: GlPoint) => number | null, ms: number): { perMin: number; rise: number } {
  const now = performance.now();
  const within = points.filter((p) => p.t >= now - ms && pick(p) !== null);
  const pts = within.map((p): [number, number] => [p.t / 60_000, pick(p)!]);
  return { perMin: slope(pts), rise: pts.length ? pts[pts.length - 1]![1] - pts[0]![1] : 0 };
}

/** Every check, now (the storage, the battery and the user agent's memory as last read: `collector.platform`). */
export function runChecks(ctx: LabContext, collector: Collector): Check[] {
  const out: Check[] = [];
  const add = (c: Check): void => { out.push(c); };
  const gl = ctx.scene.gl;
  const raw = gl.getContext() as WebGL2RenderingContext;

  // Cross-origin isolation: SharedArrayBuffer and the user agent's memory need it (MDN crossOriginIsolated).
  add({
    id: 'coi', title: 'Cross-origin isolation (crossOriginIsolated)', tab: 'Consumers', focus: { category: 'RAM' },
    verdict: globalThis.crossOriginIsolated ? 'ok' : 'problem',
    value: String(globalThis.crossOriginIsolated),
    why: globalThis.crossOriginIsolated ? 'SharedArrayBuffer and measureUserAgentSpecificMemory available' : 'no COOP/COEP: no SharedArrayBuffer (the workers\' shared memory) and no user agent memory measure',
  });

  // The GPU and the tier.
  const label = ctx.scene.gpu.label;
  const software = SOFTWARE.test(label);
  add({
    id: 'gpu', title: 'GPU and quality tier', tab: 'Overview',
    verdict: software ? 'problem' : 'ok',
    value: `${label} · ${integratedGpu(label) ? 'integrated' : 'dedicated/unknown'} · quality ${ctx.scene.stats.quality}`,
    why: software ? 'software renderer: every frame drawn by the CPU, timings worthless' : 'hardware GPU; the quality tier is the one picked in the graphics menu',
  });

  // The context alive.
  add({
    id: 'context', title: 'WebGL context', tab: 'Overview',
    verdict: raw.isContextLost() ? 'problem' : 'ok',
    value: `${raw.isContextLost() ? 'LOST' : 'alive'} · ${raw.getParameter(raw.VERSION) as string}`,
    why: 'a lost context wipes every GPU resource until it is restored',
  });

  // The limits that matter to the game's targets and arrays.
  const p = (name: number): number => Number(raw.getParameter(name));
  const maxTex = p(raw.MAX_TEXTURE_SIZE), maxSamples = p(raw.MAX_SAMPLES), layers = p(raw.MAX_ARRAY_TEXTURE_LAYERS), units = p(raw.MAX_COMBINED_TEXTURE_IMAGE_UNITS), ubo = p(raw.MAX_UNIFORM_BLOCK_SIZE), draws = p(raw.MAX_DRAW_BUFFERS), rb = p(raw.MAX_RENDERBUFFER_SIZE);
  const aniso = raw.getExtension('EXT_texture_filter_anisotropic') as { MAX_TEXTURE_MAX_ANISOTROPY_EXT: number } | null;
  const small = maxTex < 8192 || maxSamples < 4 || layers < 256;
  add({
    id: 'limits', title: 'Relevant WebGL limits', tab: 'Overview',
    verdict: small ? 'warning' : 'ok',
    value: `texture ${maxTex} · renderbuffer ${rb} · MSAA ${maxSamples} · layers ${layers} · units ${units} · UBO ${(ubo / 1024).toFixed(0)} KB · draw buffers ${draws} · anisotropy ${aniso ? raw.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number : 'no'}`,
    why: small ? 'limits below what a desktop is expected to have (texture 8192, MSAA 4, 256 layers): high quality may fail' : 'desktop limits: the targets and the array textures fit',
  });

  // The GPU timer.
  const gpu = ctx.scene.gpu;
  add({
    id: 'timer', title: 'GPU timer', tab: 'Overview',
    verdict: gpu.supported ? (gpu.disjoint > 10 ? 'warning' : 'ok') : 'warning',
    value: gpu.supported ? `EXT_disjoint_timer_query_webgl2 · ${gpu.samples.pushed} frames measured · ${gpu.skipped} skipped · ${gpu.disjoint} discarded${gpu.paused ? ' · PAUSED' : ''}` : 'missing',
    why: gpu.supported ? 'real GPU times per frame; discards come from a clock change or a lost context' : 'no extension (off by default in Chrome outside desktop): no GPU time, verdict from the CPU only',
  });

  // The pixel ratio drawn against the screen's.
  const drawn = gl.getPixelRatio(), screen = window.devicePixelRatio;
  add({
    id: 'dpr', title: 'Pixel ratio drawn × the screen\'s', tab: 'Switches',
    verdict: drawn < screen * 0.99 ? 'info' : drawn > screen * 1.01 ? 'warning' : 'ok',
    value: `${drawn.toFixed(2)} drawn · ${screen.toFixed(2)} screen · buffer ${gl.domElement.width}×${gl.domElement.height}`,
    why: drawn < screen * 0.99 ? 'drawing below the screen (reduced or dynamic resolution): fewer pixels, a softer image' : drawn > screen * 1.01 ? 'drawing above the screen: pixels paid for and never seen' : 'one pixel drawn per screen pixel',
  });

  // The pace: vsync or a cap, as the frames show it.
  const s = summarize(ctx, collector, 30_000);
  const hz = s.interval.p50 ? 1000 / s.interval.p50 : null;
  add({
    id: 'vsync', title: 'Frame pace (vsync / cap)', tab: 'Overview',
    verdict: ctx.effects.onDemand ? 'info' : hz !== null && hz < 50 ? 'warning' : 'ok',
    value: ctx.effects.onDemand ? `on demand · ${s.frames} frames in 30 s` : hz === null ? 'no frames' : `~${hz.toFixed(0)} Hz (median interval ${s.interval.p50!.toFixed(1)} ms) · ${s.bound}`,
    why: ctx.effects.onDemand ? 'the game draws only when something changes: the interval does not measure capacity (turn "on demand" off to measure)' : 'requestAnimationFrame follows the screen\'s vsync; below a steady 50 Hz the game is not keeping up',
  });

  // A hidden page: rAF stops, timers are throttled (Chrome 88: checked once a second while hidden, chained ones once a minute after 5 min hidden and silent).
  const hiddenNow = document.hidden;
  const hides = collector.visibility.filter((v) => v.hidden).length;
  add({
    id: 'visibility', title: 'Page visibility / background throttling', tab: 'Consumers', focus: { category: '' },
    verdict: hiddenNow ? 'warning' : hides > 0 ? 'info' : 'ok',
    value: `${document.visibilityState} · hidden ${hides}× since the lab began`,
    why: hiddenNow ? 'hidden: requestAnimationFrame stopped and timers throttled (1×/s; 1×/min after 5 min hidden): measures stopped or false' : hides ? 'there were hidden stretches: the session\'s measures include stopped frames' : 'visible the whole time',
  });

  // Shader programs growing: compiles after the opening (each a hitch).
  const prog = growth(collector.glPoints, (p) => p.programs, 60_000);
  const progNow = collector.glPoints[collector.glPoints.length - 1]?.programs ?? 0;
  add({
    id: 'programs', title: 'Shader programs (recompiles)', tab: 'Consumers', focus: { category: 'GPU', filter: 'programs' },
    verdict: prog.rise > 5 ? 'warning' : 'ok',
    value: `${progNow} programs · +${prog.rise} in the last minute`,
    why: prog.rise > 5 ? 'new programs being compiled during play: each compile is a hitch (a material with variants, defines changing)' : 'program count stable',
  });

  // Geometries and textures growing: a leak (made, never disposed).
  const geo = growth(collector.glPoints, (p) => p.geometries, 120_000);
  const tex = growth(collector.glPoints, (p) => p.textures, 120_000);
  const last = collector.glPoints[collector.glPoints.length - 1];
  const leaking = (geo.perMin > 50 && geo.rise > 100) || (tex.perMin > 10 && tex.rise > 20);
  add({
    id: 'objects', title: 'Live geometries and textures (leak)', tab: 'Consumers', focus: { category: 'VRAM' },
    verdict: leaking ? 'warning' : 'ok',
    value: `${last?.geometries ?? '?'} geometries (${geo.perMin >= 0 ? '+' : ''}${geo.perMin.toFixed(0)}/min) · ${last?.textures ?? '?'} textures (${tex.perMin >= 0 ? '+' : ''}${tex.perMin.toFixed(1)}/min) over 2 min`,
    why: leaking ? 'growing without stop: something creates without dispose (with the camera still it should settle; while moving the streaming goes up and down)' : 'count stable',
  });

  // The heap's slope.
  const heap = growth(collector.glPoints, (p) => p.heap, 180_000);
  add({
    id: 'heap', title: 'JS heap growth', tab: 'Overview',
    verdict: heap.perMin > 120 ? 'problem' : heap.perMin > 30 ? 'warning' : 'ok',
    value: `${last?.heap?.toFixed(0) ?? '?'} MB · ${heap.perMin >= 0 ? '+' : ''}${heap.perMin.toFixed(1)} MB/min over 3 min`,
    why: heap.perMin > 30 ? 'heap rising steadily: a leak or an unbounded cache (compare before/after a collection)' : 'heap stable between collections',
  });

  // Long tasks a minute.
  const now = performance.now();
  const tasks = collector.longTasks.filter((t) => t >= now - 60_000).length;
  const loafs = collector.longFrames.filter((l) => l.t >= now - 60_000).length;
  add({
    id: 'longtasks', title: 'Long tasks and LoAF per minute', tab: 'Consumers', focus: { category: 'CPU-main', filter: 'LoAF' },
    verdict: tasks + loafs > 30 ? 'problem' : tasks + loafs > 5 ? 'warning' : 'ok',
    value: `${tasks} long tasks · ${loafs} long frames in the last minute`,
    why: 'each blocks input for over 50 ms (W3C Long Tasks / LoAF): see the attributed scripts in Consumers',
  });

  // The pool saturated: every worker busy with jobs waiting.
  const pool = jobPoolStats();
  const busy = pool.workers.filter((w) => w.running !== null || w.laneWork > 0).length;
  const waitMeter = collector.book.get('pool.waiting')?.read('30s', now);
  const saturated = pool.workers.length >= pool.most && busy === pool.workers.length && pool.waiting > 0;
  add({
    id: 'workers', title: 'Pool workers saturated', tab: 'Consumers', focus: { category: 'CPU-worker' },
    verdict: saturated && (waitMeter?.avg ?? 0) > 5 ? 'warning' : pool.workers.some((w) => w.failed) ? 'problem' : 'ok',
    value: `${busy}/${pool.workers.length} busy (max ${pool.most}) · ${pool.waiting} queued (30 s average ${(waitMeter?.avg ?? 0).toFixed(1)}) · ${pool.workers.filter((w) => w.failed).length} failed · ${navigator.hardwareConcurrency} cores`,
    why: saturated ? 'every worker busy and the queue growing: off-page work waits (tiles and far levels fall behind)' : 'the pool has headroom',
  });

  // Storage quota.
  const st = collector.platform.storage;
  const share = st && st.quota ? st.usage / st.quota : null;
  add({
    id: 'storage', title: 'Storage quota', tab: 'Consumers', focus: { category: 'Disk' },
    verdict: share === null ? 'info' : share > 0.8 ? 'problem' : share > 0.5 ? 'warning' : st?.persisted === false ? 'info' : 'ok',
    value: st ? `${(st.usage / 1048576).toFixed(1)} MB of ${(st.quota / 1048576).toFixed(0)} MB (${((share ?? 0) * 100).toFixed(1)}%) · ${st.persisted ? 'persistent' : 'not persistent'}` : 'not read yet',
    why: share !== null && share > 0.5 ? 'near the quota: writes (saves, the derived cache) may fail with QuotaExceededError' : st?.persisted === false ? '"best-effort" storage: the browser may evict it under disk pressure (StorageManager.persist())' : 'storage headroom',
  });

  // Video memory against the ledger's cap.
  const ledger = collector.book.get('vram.ledger')?.read('5s', now);
  add({
    id: 'vram', title: 'Video memory × the ledger cap', tab: 'Consumers', focus: { category: 'VRAM' },
    verdict: 'info',
    value: `${ledger?.last?.toFixed(0) ?? '?'} MB · ${ledger?.note ?? ''}`,
    why: 'the cap is estimated (WebGL does not expose VRAM): the ledger (gpuLedger) refuses detail above it',
  });

  // The machine.
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  add({
    id: 'machine', title: 'Machine (cores, memory)', tab: 'Overview',
    verdict: navigator.hardwareConcurrency < 4 ? 'warning' : 'ok',
    value: `${navigator.hardwareConcurrency} logical cores · deviceMemory ${memory ?? '?'} GB (the browser caps it at 8)`,
    why: navigator.hardwareConcurrency < 4 ? 'few cores: the job pool gets 1-2 workers' : 'enough cores for the pool',
  });

  // The battery (no web API tells the OS's energy saver: only charging and level, MDN getBattery).
  const bat = collector.platform.battery;
  add({
    id: 'battery', title: 'Battery / power saving', tab: 'Overview',
    verdict: bat && !bat.charging ? 'warning' : 'info',
    value: bat ? `${bat.charging ? 'charging' : 'on battery'} · ${(bat.level * 100).toFixed(0)}%` : 'API unavailable',
    why: bat && !bat.charging ? 'on battery the system and the browser may lower the CPU/GPU clocks and cap frames (power saving is not exposed to the page)' : 'no web API exposes the system\'s power-saving mode; only charging and level',
  });

  // The user agent's memory, workers included.
  const ua = collector.platform.uaMemory;
  add({
    id: 'uamemory', title: 'User agent memory (page + workers)', tab: 'Consumers', focus: { category: 'RAM', filter: 'memory' },
    verdict: ua ? (ua.bytes > 3 * 2 ** 30 ? 'problem' : ua.bytes > 2 * 2 ** 30 ? 'warning' : 'ok') : 'info',
    value: ua ? `${(ua.bytes / 1048576).toFixed(0)} MB · ${ua.breakdown.length} parts · ${((now - ua.at) / 1000).toFixed(0)} s ago` : collector.platform.uaMemoryError ?? (collector.platform.uaMemoryRunning ? 'measuring…' : 'not measured yet'),
    why: 'the page and its workers share one 4 GB V8 cage (jobPool.ts): above 3 GB Chrome may kill the page',
  });

  return out.sort((a, b) => RANK[b.verdict] - RANK[a.verdict]);
}

export function createDiagnosticsTab(ctx: LabContext, collector: Collector): LabTab {
  let checks: Check[] = [];
  let summaryEl: HTMLElement | null = null;
  const table = createLabTable<Check>({
    columns: [
      { key: 'verdict', label: 'Verdict', value: (c) => c.verdict },
      { key: 'rank', label: '!', value: (c) => RANK[c.verdict], title: 'severity (3 problem, 2 warning, 1 info, 0 ok)' },
      { key: 'title', label: 'Check', value: (c) => c.title },
      { key: 'value', label: 'Reading', value: (c) => c.value },
      { key: 'why', label: 'Explanation', value: (c) => c.why },
      { key: 'tab', label: 'See in', value: (c) => `→ ${c.tab}`, title: 'click the row to open the tab' },
    ],
    rows: () => checks,
    sort: { key: 'rank', desc: true },
    categoryKey: 'verdict',
    onRow: (c) => ctx.navigate(TAB_IDS[c.tab] ?? 'overview', c.focus ?? {}),
  });
  let ranAt = -Infinity;
  /** The checks read WebGL's parameters and walk the readings: once a second is enough. */
  const run = (force = false): void => {
    const now = performance.now();
    if (!force && now - ranAt < 1000) return;
    ranAt = now;
    checks = runChecks(ctx, collector);
  };

  const mount = (host: HTMLElement): void => {
    const bar = document.createElement('div');
    bar.className = 'lab-row';
    const again = document.createElement('button');
    again.type = 'button';
    again.textContent = 'Read storage and memory again';
    again.onclick = () => { void Promise.all([collector.readStorage(), collector.measureMemory()]).then(() => { run(true); refresh(); }); };
    summaryEl = document.createElement('span');
    summaryEl.className = 'lab-muted';
    bar.append(again, summaryEl);
    host.append(bar, table.element);
    run(true);
    refresh();
  };

  function refresh(): void {
    run();
    table.refresh();
    if (summaryEl) {
      const count = (v: Verdict): number => checks.filter((c) => c.verdict === v).length;
      summaryEl.textContent = `${count('problem')} problems · ${count('warning')} warnings · ${count('ok')} ok · ${count('info')} informational · the table's rows lead to the tab shown`;
    }
  }

  return { id: 'diagnostics', title: 'Checks', mount, refresh, unmount: () => { summaryEl = null; } };
}

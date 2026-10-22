import { LONG_FRAME_MS } from '@core/health';
import type { LabContext, LabTab } from '../labTypes';
import type { Collector, FramePoint } from './collector';
import { percentileOf, slope } from './meter';

/** THE LAB'S OVERVIEW ("Visão geral"): the frame's numbers live with their last 60 s drawn, the percentiles, the hitches, the settings, and what the numbers say (GPU- or CPU-bound, long tasks, a heap that grows) */

/** One graph of the overview: what it reads of a frame, its unit, its colour. */
interface Kpi {
  readonly id: string;
  readonly label: string;
  readonly unit: string;
  readonly color: string;
  /** Null: no value this frame (a GPU time not come in yet). */
  value(f: FramePoint): number | null;
  /** A line drawn across the graph (a budget), if any. */
  readonly line?: number;
}

/** The overview's verdicts, read by the report and the diagnostics too. */
export interface OverviewSummary {
  readonly windowS: number;
  readonly frames: number;
  readonly fps: number | null;
  readonly interval: { readonly p50: number | null; readonly p95: number | null; readonly p99: number | null };
  readonly cpu: { readonly p50: number | null; readonly p95: number | null; readonly p99: number | null };
  readonly gpu: { readonly p50: number | null; readonly p95: number | null; readonly p99: number | null };
  readonly draws: number | null;
  readonly triangles: number | null;
  readonly heapMB: number | null;
  /** MB a minute, least squares over the window. */
  readonly heapSlope: number;
  /** Frames whose own work passed `LONG_FRAME_MS`. */
  readonly hitches: number;
  readonly longFrames: number;
  readonly longTasks: number;
  readonly bound: 'GPU' | 'CPU' | 'vsync' | 'ocioso' | 'misto' | 'indefinido';
  readonly boundWhy: string;
  readonly warnings: readonly { readonly level: 'aviso' | 'problema'; readonly text: string }[];
}

const KPIS: readonly Kpi[] = [
  { id: 'interval', label: 'Intervalo do quadro', unit: 'ms', color: '#2fb3a0', value: (f) => (f.interval > 0 ? f.interval : null), line: 1000 / 60 },
  { id: 'fps', label: 'FPS', unit: 'qps', color: '#7fd1ff', value: (f) => (f.interval > 0 ? 1000 / f.interval : null), line: 60 },
  { id: 'cpu', label: 'CPU do quadro', unit: 'ms', color: '#ffc35a', value: (f) => f.cpu, line: LONG_FRAME_MS },
  { id: 'gpu', label: 'GPU do quadro', unit: 'ms', color: '#ff7a6b', value: (f) => f.gpu, line: 1000 / 60 },
  { id: 'draws', label: 'Chamadas de desenho', unit: '', color: '#b48cff', value: (f) => f.draws },
  { id: 'triangles', label: 'Triângulos', unit: '', color: '#9fdc6a', value: (f) => f.triangles },
  { id: 'heap', label: 'Heap JS', unit: 'MB', color: '#e88fd0', value: (f) => f.heap },
];

/** The heap growing faster than this, MB a minute, over the window: a leak suspected (a game standing still holds its heap level between collections). */
const HEAP_GROWS_MB_MIN = 30;

const spread = (values: number[]): OverviewSummary['interval'] => ({ p50: percentileOf(values, 50), p95: percentileOf(values, 95), p99: percentileOf(values, 99) });

/** What the frames of the last `windowMs` say. */
export function summarize(ctx: LabContext, collector: Collector, windowMs = 60_000): OverviewSummary {
  const now = performance.now();
  const frames = collector.frames().filter((f) => f.t >= now - windowMs);
  const intervals = frames.map((f) => f.interval).filter((v) => v > 0);
  const cpu = frames.map((f) => f.cpu);
  const gpu = frames.map((f) => f.gpu).filter((v): v is number => v !== null);
  const last = frames[frames.length - 1];
  const heapPoints = frames.filter((f) => f.heap !== null).map((f): [number, number] => [f.t / 60_000, f.heap!]);
  const heapSlope = slope(heapPoints);
  const span = frames.length > 1 ? (frames[frames.length - 1]!.t - frames[0]!.t) / 1000 : 0;
  const fps = span > 0 ? (frames.length - 1) / span : null;
  const iv = spread(intervals), c = spread(cpu), g = spread(gpu);
  const hitches = cpu.filter((v) => v > LONG_FRAME_MS).length;
  const longFrames = collector.longFrames.filter((l) => l.t >= now - windowMs).length;
  const longTasks = collector.longTasks.filter((t) => t >= now - windowMs).length;

  // Who sets the pace: the GPU's time against the CPU's work and against the interval (Chrome/MDN: a frame waits on the slower of the two).
  let bound: OverviewSummary['bound'] = 'indefinido';
  let boundWhy = 'quadros insuficientes na janela';
  const onDemand = ctx.effects.onDemand;
  if (intervals.length >= 10 && iv.p50 !== null && c.p50 !== null) {
    const frameMs = iv.p50;
    if (onDemand && frameMs > 40 && c.p50 < frameMs / 3 && (g.p50 ?? 0) < frameMs / 3) {
      bound = 'ocioso';
      boundWhy = `quadros sob demanda: o jogo desenha só quando algo muda (intervalo mediano ${frameMs.toFixed(1)} ms, CPU ${c.p50.toFixed(1)} ms) - desligue "sob demanda" nos Interruptores para medir carga contínua`;
    } else if (g.p50 !== null && g.p50 > c.p50 * 1.2 && g.p50 > frameMs * 0.7) {
      bound = 'GPU';
      boundWhy = `GPU mediana ${g.p50.toFixed(1)} ms contra CPU ${c.p50.toFixed(1)} ms com intervalo ${frameMs.toFixed(1)} ms: a GPU dita o ritmo (reduza resolução, sombras, pós-processamento)`;
    } else if (c.p50 > frameMs * 0.7 && (g.p50 === null || c.p50 > g.p50 * 1.2)) {
      bound = 'CPU';
      boundWhy = `CPU mediana ${c.p50.toFixed(1)} ms ocupa ${((c.p50 / frameMs) * 100).toFixed(0)}% do intervalo ${frameMs.toFixed(1)} ms${g.p50 !== null ? ` (GPU ${g.p50.toFixed(1)} ms)` : ''}: o thread principal dita o ritmo (veja Consumo › CPU-main)`;
    } else if (c.p50 < frameMs * 0.5 && (g.p50 ?? 0) < frameMs * 0.5) {
      bound = 'vsync';
      boundWhy = `CPU ${c.p50.toFixed(1)} ms e GPU ${g.p50 === null ? '?' : g.p50.toFixed(1)} ms bem abaixo do intervalo ${frameMs.toFixed(1)} ms (~${(1000 / frameMs).toFixed(0)} Hz): limitado pelo vsync/limite de quadros`;
    } else {
      bound = 'misto';
      boundWhy = `CPU ${c.p50.toFixed(1)} ms e GPU ${g.p50 === null ? '?' : g.p50.toFixed(1)} ms próximos, intervalo ${frameMs.toFixed(1)} ms: ambos pesam`;
    }
  }

  const warnings: { level: 'aviso' | 'problema'; text: string }[] = [];
  if (!ctx.scene.gpu.supported) warnings.push({ level: 'aviso', text: 'sem medidor de tempo da GPU (EXT_disjoint_timer_query_webgl2): o veredito GPU/CPU usa só a CPU' });
  if (hitches > 0) warnings.push({ level: hitches > 5 ? 'problema' : 'aviso', text: `${hitches} quadros com trabalho > ${LONG_FRAME_MS} ms na janela (engasgos)` });
  if (longTasks > 0 || longFrames > 0) warnings.push({ level: longFrames > 10 ? 'problema' : 'aviso', text: `${longFrames} quadros de animação longos (LoAF) e ${longTasks} tarefas longas na janela: veja Consumo › scripts de LoAF` });
  if (heapPoints.length > 30 && heapSlope > HEAP_GROWS_MB_MIN) warnings.push({ level: heapSlope > HEAP_GROWS_MB_MIN * 4 ? 'problema' : 'aviso', text: `heap crescendo ${heapSlope.toFixed(0)} MB/min na janela` });
  if (document.hidden) warnings.push({ level: 'aviso', text: 'página oculta: o navegador suspende requestAnimationFrame e estrangula temporizadores' });
  if (iv.p99 !== null && iv.p50 !== null && iv.p99 > iv.p50 * 3 && iv.p99 > 50 && !onDemand) warnings.push({ level: 'aviso', text: `intervalo irregular: p99 ${iv.p99.toFixed(0)} ms contra mediana ${iv.p50.toFixed(1)} ms` });

  return {
    windowS: windowMs / 1000, frames: frames.length, fps, interval: iv, cpu: c, gpu: g,
    draws: last?.draws ?? null, triangles: last?.triangles ?? null, heapMB: last?.heap ?? null, heapSlope,
    hitches, longFrames, longTasks, bound, boundWhy, warnings,
  };
}

const n1 = (v: number | null, digits = 1): string => (v === null ? '—' : v.toLocaleString('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: digits }));
const big = (v: number | null): string => (v === null ? '—' : v >= 1e6 ? `${(v / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} M` : v >= 1e4 ? `${(v / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : Math.round(v).toLocaleString('pt-BR'));

/** A graph of `values` over the last `spanMs` into `canvas`, its budget line dashed. */
function drawSpark(canvas: HTMLCanvasElement, points: readonly (readonly [number, number])[], now: number, spanMs: number, kpi: Kpi): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 240, h = canvas.clientHeight || 46;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (!points.length) return;
  // Scaled to the 99th percentile (a 3 s frame of the opening would flatten the rest), the budget line kept in view; past it drawn at the top.
  const top = Math.max(kpi.line ?? 0, percentileOf(points.map(([, v]) => v), 99) ?? 0) * 1.08 || 1;
  const x = (t: number): number => w - ((now - t) / spanMs) * w;
  const y = (v: number): number => h - 2 - (Math.min(v, top) / top) * (h - 4);
  if (kpi.line !== undefined) {
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.setLineDash([3, 3]);
    g.beginPath();
    g.moveTo(0, y(kpi.line));
    g.lineTo(w, y(kpi.line));
    g.stroke();
    g.setLineDash([]);
  }
  g.strokeStyle = kpi.color;
  g.lineWidth = 1.2;
  g.beginPath();
  points.forEach(([t, v], i) => (i ? g.lineTo(x(t), y(v)) : g.moveTo(x(t), y(v))));
  g.stroke();
}

export function createOverviewTab(ctx: LabContext, collector: Collector): LabTab {
  const SPAN_OPTIONS = [30_000, 60_000] as const;
  let spanMs: number = 60_000;
  let host: HTMLElement | null = null;
  const tiles = new Map<string, { value: HTMLElement; sub: HTMLElement; canvas: HTMLCanvasElement }>();
  let verdictEl: HTMLElement | null = null;
  let pctEl: HTMLElement | null = null;
  let warnEl: HTMLElement | null = null;
  let settingsEl: HTMLElement | null = null;

  const mount = (into: HTMLElement): void => {
    host = into;
    tiles.clear();
    const bar = document.createElement('div');
    bar.className = 'lab-row';
    const label = document.createElement('span');
    label.className = 'lab-muted';
    label.textContent = 'Janela dos gráficos:';
    bar.appendChild(label);
    for (const ms of SPAN_OPTIONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `${ms / 1000} s`;
      b.classList.toggle('on', ms === spanMs);
      b.onclick = () => { spanMs = ms; for (const x of bar.querySelectorAll('button')) x.classList.toggle('on', x === b); refresh(); };
      bar.appendChild(b);
    }
    verdictEl = document.createElement('div');
    verdictEl.className = 'labres-verdict';
    const grid = document.createElement('div');
    grid.className = 'labres-kpis';
    for (const kpi of KPIS) {
      const tile = document.createElement('div');
      tile.className = 'labres-kpi';
      const head = document.createElement('div');
      head.className = 'labres-kpi-head';
      const name = document.createElement('span');
      name.textContent = kpi.label;
      name.style.color = kpi.color;
      const value = document.createElement('strong');
      head.append(name, value);
      const sub = document.createElement('div');
      sub.className = 'lab-muted labres-kpi-sub';
      const canvas = document.createElement('canvas');
      canvas.className = 'labres-spark';
      tile.append(head, canvas, sub);
      grid.appendChild(tile);
      tiles.set(kpi.id, { value, sub, canvas });
    }
    const h1 = document.createElement('h3');
    h1.textContent = 'Percentis e engasgos';
    pctEl = document.createElement('div');
    pctEl.className = 'lab-card';
    const h2 = document.createElement('h3');
    h2.textContent = 'Avisos';
    warnEl = document.createElement('ul');
    warnEl.className = 'lab-card labres-warnings';
    const h3 = document.createElement('h3');
    h3.textContent = 'Configuração atual';
    settingsEl = document.createElement('div');
    settingsEl.className = 'lab-card labres-settings';
    into.append(bar, verdictEl, grid, h1, pctEl, h2, warnEl, h3, settingsEl);
    refresh();
  };

  function refresh(): void {
    if (!host || !verdictEl || !pctEl || !warnEl || !settingsEl) return;
    const now = performance.now();
    const frames = collector.frames().filter((f) => f.t >= now - spanMs);
    for (const kpi of KPIS) {
      const tile = tiles.get(kpi.id)!;
      const points: [number, number][] = [];
      if (kpi.id === 'fps') {
        // Frames counted over the second before each one: 1/interval of a single frame reads as noise.
        let from = 0;
        frames.forEach((f, i) => {
          while (frames[from]!.t < f.t - 1000) from++;
          if (f.t - frames[0]!.t >= 1000) points.push([f.t, i - from + 1]);
        });
      } else for (const f of frames) { const v = kpi.value(f); if (v !== null) points.push([f.t, v]); }
      const values = points.map(([, v]) => v);
      const lastV = values.length ? values[values.length - 1]! : null;
      const unit = kpi.unit ? ` ${kpi.unit}` : '';
      tile.value.textContent = kpi.id === 'draws' || kpi.id === 'triangles' ? big(lastV) : `${n1(lastV)}${unit}`;
      const p50 = percentileOf(values, 50), p95 = percentileOf(values, 95), max = percentileOf(values, 100);
      tile.sub.textContent = kpi.id === 'draws' || kpi.id === 'triangles'
        ? `p50 ${big(p50)} · p95 ${big(p95)} · máx ${big(max)}`
        : `p50 ${n1(p50)} · p95 ${n1(p95)} · máx ${n1(max)}${unit}`;
      drawSpark(tile.canvas, points, now, spanMs, kpi);
    }
    const s = summarize(ctx, collector, spanMs);
    verdictEl.className = `labres-verdict labres-bound-${s.bound}`;
    verdictEl.textContent = `Veredito: ${s.bound === 'GPU' ? 'limitado pela GPU' : s.bound === 'CPU' ? 'limitado pela CPU' : s.bound === 'vsync' ? 'limitado pelo vsync' : s.bound === 'ocioso' ? 'ocioso (sob demanda)' : s.bound === 'misto' ? 'CPU e GPU equilibradas' : 'indefinido'} — ${s.boundWhy}`;
    pctEl.replaceChildren(table([
      ['', 'p50', 'p95', 'p99'],
      ['Intervalo (ms)', n1(s.interval.p50), n1(s.interval.p95), n1(s.interval.p99)],
      ['CPU (ms)', n1(s.cpu.p50), n1(s.cpu.p95), n1(s.cpu.p99)],
      ['GPU (ms)', n1(s.gpu.p50), n1(s.gpu.p95), n1(s.gpu.p99)],
    ]), line(`${s.frames} quadros em ${s.windowS} s · ${s.fps === null ? '—' : n1(s.fps)} quadros/s · engasgos (CPU > ${LONG_FRAME_MS} ms): ${s.hitches} · LoAF: ${s.longFrames} · tarefas longas: ${s.longTasks} · tendência do heap ${s.heapSlope >= 0 ? '+' : ''}${n1(s.heapSlope)} MB/min (coletas a puxam para baixo)`));
    warnEl.replaceChildren(...(s.warnings.length ? s.warnings : [{ level: 'ok', text: 'nada a apontar na janela' }]).map((w) => {
      const li = document.createElement('li');
      li.className = w.level === 'problema' ? 'lab-bad' : w.level === 'aviso' ? 'lab-warn' : 'lab-good';
      li.textContent = `${w.level}: ${w.text}`;
      return li;
    }));
    settingsEl.textContent = settingsSummary(ctx);
  }

  return { id: 'overview', title: 'Visão geral', mount, refresh, unmount: () => { host = null; } };
}

/** The settings that change the numbers, in one paragraph. */
export function settingsSummary(ctx: LabContext): string {
  const snap = ctx.effects.snapshot();
  const off = Object.entries(snap).filter(([, v]) => v === false).map(([k]) => k);
  const gl = ctx.scene.gl;
  const canvas = gl.domElement;
  return [
    `qualidade ${ctx.scene.stats.quality}`,
    `pixel ratio desenhado ${gl.getPixelRatio().toFixed(2)} (tela ${window.devicePixelRatio.toFixed(2)})`,
    `buffer ${canvas.width}×${canvas.height}`,
    `resolução ${String(snap['resolution'] ?? '?')}`,
    `quadros ${ctx.effects.onDemand ? 'sob demanda' : 'contínuos'}`,
    `simulação ${ctx.effects.simulation ? 'ligada' : 'desligada'} (tráfego ${ctx.effects.traffic ? 'sim' : 'não'}, pedestres ${ctx.effects.pedestrians ? 'sim' : 'não'}, crescimento ${ctx.effects.growth ? 'sim' : 'não'})`,
    `desligados: ${off.length ? off.join(', ') : 'nenhum'}`,
  ].join(' · ');
}

function table(rows: readonly (readonly string[])[]): HTMLTableElement {
  const t = document.createElement('table');
  t.className = 'labres-pct';
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    for (const cell of r) {
      const td = document.createElement(i === 0 ? 'th' : 'td');
      td.textContent = cell;
      tr.appendChild(td);
    }
    t.appendChild(tr);
  });
  return t;
}

function line(text: string): HTMLElement {
  const p = document.createElement('div');
  p.className = 'lab-muted';
  p.textContent = text;
  return p;
}

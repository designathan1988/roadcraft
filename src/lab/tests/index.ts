import type { LabContext, LabTab } from '../labTypes';
import { icon } from '../icons';
import { createLabTable, type LabColumn } from '../table';
import { BENCHMARK_LABELS, type BenchmarkKind, type BenchmarkOptions, type BenchmarkResult, type BenchRow, runBenchmark } from './benchmarks';
import { sweepItems } from './items';
import { type Cancel, VIEW_LABELS, type ViewId } from './measure';
import { createProbesTab } from './probes';
import { runSweep, type SweepOptions, type SweepResult, type SweepRow } from './sweep';

/** THE LAB'S TESTS (F7): the A/B sweep of every switch and optimisation, the benchmarks, the probes. One test at a time; every result kept
 *  for the lab's report (`tests` section) and for a script (`window.__labTests`, `scripts/lab/sweep.mjs`). Measures on a GPU other programs
 *  share are not measures: the sweep says its noise, and the headless runner refuses a busy machine. */

type TestResult = SweepResult | BenchmarkResult;

export interface LabTests {
  sweep(options?: SweepOptions): Promise<SweepResult>;
  benchmark(kind: BenchmarkKind, options?: BenchmarkOptions): Promise<BenchmarkResult>;
  results(): readonly TestResult[];
  items(): readonly { id: string; label: string; group: string; value: unknown }[];
  cancel(): void;
  running(): string | null;
}

/** Results kept (each sweep and benchmark run). */
const KEPT = 30;

export function createTestTabs(ctx: LabContext): LabTab[] {
  const results: TestResult[] = [];
  let running: { name: string; cancel: Cancel } | null = null;
  let progressLine = '';
  /** Each tab's status line, by tab (a mount replaces its own). */
  const listeners = new Map<string, () => void>();
  const changed = (): void => { for (const l of listeners.values()) l(); };

  const exclusive = async <T extends TestResult>(name: string, job: (cancel: Cancel) => Promise<T>): Promise<T> => {
    if (running) throw new Error(`outro teste em andamento: ${running.name}`);
    const cancel: Cancel = { stopped: false };
    running = { name, cancel };
    progressLine = `${name}: início`;
    changed();
    try {
      const result = await job(cancel);
      results.push(result);
      if (results.length > KEPT) results.splice(0, results.length - KEPT);
      return result;
    } finally {
      running = null;
      progressLine = '';
      changed();
    }
  };
  const progress = (line: string): void => { progressLine = line; changed(); };

  const api: LabTests = {
    sweep: (options = {}) => exclusive('varredura A/B', (cancel) => runSweep(ctx, options, cancel, progress)),
    benchmark: (kind, options = {}) => {
      if (!(kind in BENCHMARK_LABELS)) return Promise.reject(new Error(`benchmark: ${Object.keys(BENCHMARK_LABELS).join(' | ')}`));
      return exclusive(BENCHMARK_LABELS[kind], (cancel) => runBenchmark(ctx, kind, options, cancel, progress));
    },
    results: () => results,
    items: () => sweepItems(ctx).map((i) => ({ id: i.id, label: i.label, group: i.group, value: i.get() })),
    cancel: () => { if (running) running.cancel.stopped = true; },
    running: () => (running ? `${running.name} · ${progressLine}` : null),
  };
  (window as unknown as { __labTests: LabTests }).__labTests = api;
  ctx.reportSection('tests', () => ({ running: api.running(), results }));

  const statusLine = (tab: string): HTMLElement => {
    const line = document.createElement('div');
    line.className = 'lab-row lab-warn';
    const draw = (): void => { line.textContent = running ? `Em andamento: ${running.name} · ${progressLine}` : ''; };
    listeners.set(tab, draw);
    draw();
    return line;
  };
  const failed = (error: unknown): void => {
    console.error('lab test failed', error);
    progressLine = `falhou: ${String(error)}`;
    ctx.emit('test.error', String(error));
    changed();
  };

  return [sweepTab(ctx, api, results, statusLine, failed), benchTab(api, results, statusLine, failed), createProbesTab()];
}

const num = (label: string, value: number, min: number, max: number): HTMLInputElement => {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  input.title = label;
  input.style.width = '5em';
  return input;
};
const labelled = (text: string, control: HTMLElement): HTMLLabelElement => {
  const l = document.createElement('label');
  l.append(`${text} `, control);
  return l;
};
const button = (text: string, onclick: () => void, iconName?: string): HTMLButtonElement => {
  const b = document.createElement('button');
  b.type = 'button';
  if (iconName) b.append(icon(iconName), ` ${text}`);
  else b.textContent = text;
  b.onclick = onclick;
  return b;
};
const warningsOf = (result: TestResult | undefined): string => (result?.warnings.length ? `Avisos: ${result.warnings.join(' · ')}` : '');

function sweepTab(ctx: LabContext, api: LabTests, results: readonly TestResult[], statusLine: (tab: string) => HTMLElement, failed: (e: unknown) => void): LabTab {
  const chosen = new Set<string>();
  const lastSweep = (): SweepResult | undefined => [...results].reverse().find((r): r is SweepResult => r.kind === 'sweep');
  const sign = (v: number | null): string => (v === null ? '—' : `${v > 0 ? '+' : ''}${v.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}`);
  const columns: LabColumn<SweepRow>[] = [
    { key: 'label', label: 'Item', value: (r) => r.label, title: 'O interruptor ou a otimização invertida' },
    { key: 'group', label: 'Grupo', value: (r) => r.group },
    { key: 'ab', label: 'A → B', value: (r) => `${r.a} → ${r.b}` },
    { key: 'gpuA', label: 'GPU A', value: (r) => r.gpuA, title: 'Mediana da GPU nas duas janelas A (ms)' },
    { key: 'gpuB', label: 'GPU B', value: (r) => r.gpuB, title: 'Mediana da GPU na janela B (ms)' },
    { key: 'gpuDelta', label: 'Δ GPU', value: (r) => r.gpuDelta, format: sign, title: 'B − média das A (ms): negativo = mais barato' },
    { key: 'gpuDeltaPct', label: 'Δ%', value: (r) => r.gpuDeltaPct, format: sign },
    { key: 'cpuDelta', label: 'Δ CPU', value: (r) => r.cpuDelta, format: sign },
    { key: 'frameDelta', label: 'Δ quadro', value: (r) => r.frameDelta, format: sign },
    { key: 'callsDelta', label: 'Δ chamadas', value: (r) => r.callsDelta, format: sign },
    { key: 'trianglesDelta', label: 'Δ triângulos', value: (r) => r.trianglesDelta, format: sign },
    { key: 'noise', label: 'Ruído', value: (r) => r.noise, title: 'O que o Δ precisa passar: as A afastadas, o erro das medianas, o espalhamento das repetições, ≥ 2 % de A' },
    { key: 'drift', label: 'Deriva A/A', value: (r) => r.drift },
    { key: 'newPrograms', label: 'Programas', value: (r) => r.newPrograms, title: 'Programas compilados ao inverter' },
    { key: 'flags', label: 'Alertas', value: (r) => [r.sceneChanged ? 'cena mudou' : '', r.unsettled ? 'não assentou' : '', r.basis === 'frame' ? 'sem GPU' : ''].filter(Boolean).join(', ') },
    { key: 'verdict', label: 'Veredito', value: (r) => r.verdict },
  ];
  const table = createLabTable<SweepRow>({ columns, rows: () => lastSweep()?.rows ?? [], sort: { key: 'gpuDelta', desc: false }, categoryKey: 'verdict' });
  let info: HTMLElement | null = null;
  let start: HTMLButtonElement | null = null;
  let drawn = '';
  const redraw = (force = true): void => {
    const now = `${results.length}|${api.running() !== null}`;
    if (!force && now === drawn) return;
    drawn = now;
    table.refresh();
    const last = lastSweep();
    if (info) info.textContent = last ? `Última: ${new Date(last.startedAt).toLocaleString('pt-BR')} · vista ${VIEW_LABELS[last.view]} · ${last.frames} quadros × ${last.reps} rep · ${Math.round(last.ms / 1000)} s · ${last.gpuLabel}. ${warningsOf(last)}` : 'Nenhuma varredura ainda. Resultados só são comparáveis numa máquina livre (a GPU compartilhada dá ruído).';
    if (start) start.disabled = api.running() !== null;
  };
  let mounted: HTMLElement | null = null;
  const remount = (): void => { if (mounted) { const host = mounted; host.replaceChildren(); mountInto(host); } };
  function mountInto(host: HTMLElement): void {
    mounted = host;
    const items = sweepItems(ctx);
    const groups = [...new Set(items.map((i) => i.group))];
    const pick = document.createElement('div');
    pick.className = 'lab-grid';
    pick.style.cssText = 'grid-template-columns:repeat(auto-fill,minmax(210px,1fr));max-height:28vh;overflow:auto';
    for (const group of groups) {
      const box = document.createElement('fieldset');
      box.className = 'lab-card';
      box.style.margin = '0';
      const legend = document.createElement('legend');
      const all = document.createElement('input');
      all.type = 'checkbox';
      legend.append(all, ` ${group}`);
      box.appendChild(legend);
      const checks: HTMLInputElement[] = [];
      for (const item of items.filter((i) => i.group === group)) {
        const c = document.createElement('input');
        c.type = 'checkbox';
        c.checked = chosen.has(item.id);
        c.onchange = () => { if (c.checked) chosen.add(item.id); else chosen.delete(item.id); };
        checks.push(c);
        const l = labelled('', c);
        l.append(` ${item.label} `);
        const now = document.createElement('span');
        now.className = 'lab-muted';
        now.textContent = String(item.get());
        l.append(now);
        l.style.display = 'block';
        box.appendChild(l);
      }
      all.checked = checks.every((c) => c.checked);
      all.onchange = () => { for (const c of checks) { c.checked = all.checked; c.dispatchEvent(new Event('change')); } };
      pick.appendChild(box);
    }
    const view = document.createElement('select');
    for (const [id, label] of Object.entries(VIEW_LABELS)) view.appendChild(new Option(label, id));
    const origin = document.createElement('input');
    origin.type = 'checkbox';
    origin.title = 'As vistas padrão em volta do centro da cidade (0, 0), não da câmera';
    const frames = num('Quadros por janela', 120, 10, 2000);
    const reps = num('Repetições', 1, 1, 10);
    const settleMax = num('Espera máxima para assentar, s', 20, 2, 120);
    start = button('Iniciar varredura', () => {
      if (!chosen.size) { if (info) info.textContent = 'Escolha ao menos um item (ou marque um grupo).'; return; }
      api.sweep({ items: [...chosen], view: view.value as ViewId, origin: origin.checked, frames: Number(frames.value), reps: Number(reps.value), settleMaxMs: Number(settleMax.value) * 1000 })
        .then(() => redraw(), failed);
      redraw();
    }, 'play');
    const all = button('Tudo', () => { for (const i of items) chosen.add(i.id); remount(); });
    const none = button('Nada', () => { chosen.clear(); remount(); });
    const stop = button('Parar', () => api.cancel(), 'stop');
    const row1 = document.createElement('div');
    row1.className = 'lab-row lab-card';
    row1.append(labelled('Vista', view), labelled('centro (0,0)', origin), labelled('Quadros', frames), labelled('Repetições', reps), labelled('Assentar até (s)', settleMax), all, none, start, stop);
    const help = document.createElement('div');
    help.className = 'lab-muted';
    help.textContent = 'Para cada item: cena assentada (relógio da simulação parado), janela A, inverte, espera compilar e estabilizar, janela B, volta, janela A de novo (A/B/A detecta deriva). Δ = B − média das A; veredito "ruído" quando |Δ| não passa o ruído.';
    info = document.createElement('div');
    info.className = 'lab-muted';
    host.append(help, pick, row1, statusLine('sweep'), info, table.element);
    redraw();
  }
  return {
    id: 'tests-sweep',
    title: 'Varredura A/B',
    mount: mountInto,
    refresh: () => redraw(false),
    unmount() { info = null; start = null; drawn = ''; mounted = null; },
    /** `{ id }` an item checked (`switch.bloom` or `bloom`), `{ group }` a group's items checked: the sweep set up from elsewhere in the lab. */
    focus(params) {
      for (const i of sweepItems(ctx)) if (params['id'] === i.id || params['id'] === i.label || (params['group'] && i.group.startsWith(params['group']))) chosen.add(i.id);
      remount();
    },
  };
}

function benchTab(api: LabTests, results: readonly TestResult[], statusLine: (tab: string) => HTMLElement, failed: (e: unknown) => void): LabTab {
  const rows = (): BenchRow[] => {
    // The newest run of each benchmark.
    const newest = new Map<BenchmarkKind, BenchmarkResult>();
    for (const r of results) if (r.kind === 'benchmark') newest.set(r.bench, r);
    return [...newest.values()].flatMap((r) => r.rows);
  };
  const columns: LabColumn<BenchRow>[] = [
    { key: 'bench', label: 'Teste', value: (r) => BENCHMARK_LABELS[r.bench] },
    { key: 'case', label: 'Caso', value: (r) => r.case },
    { key: 'metric', label: 'Medida', value: (r) => r.metric },
    { key: 'value', label: 'Valor', value: (r) => r.value },
    { key: 'unit', label: 'Unidade', value: (r) => r.unit },
    { key: 'reference', label: 'Referência', value: (r) => r.reference },
    { key: 'status', label: 'Estado', value: (r) => r.status },
  ];
  const table = createLabTable<BenchRow>({ columns, rows, sort: { key: 'status', desc: false }, categoryKey: 'bench', limit: 1000 });
  let info: HTMLElement | null = null;
  let drawn = '';
  const redraw = (force = true): void => {
    const now = `${results.length}|${api.running() !== null}`;
    if (!force && now === drawn) return;
    drawn = now;
    table.refresh();
    const done = results.filter((r): r is BenchmarkResult => r.kind === 'benchmark');
    if (info) info.textContent = done.length ? done.slice(-5).map((r) => `${BENCHMARK_LABELS[r.bench]} ${new Date(r.startedAt).toLocaleTimeString('pt-BR')} (${Math.round(r.ms / 1000)} s${r.cancelled ? ', interrompido' : ''}) ${warningsOf(r)}`).join('\n') : 'Nenhum benchmark ainda.';
  };
  return {
    id: 'tests-bench',
    title: 'Benchmarks',
    mount(host) {
      const kind = document.createElement('select');
      for (const [id, label] of Object.entries(BENCHMARK_LABELS)) kind.appendChild(new Option(label, id));
      const frames = num('Quadros por janela', 120, 10, 2000);
      const seconds = num('Segundos (vazamento, estabilidade)', 30, 5, 3600);
      const origin = document.createElement('input');
      origin.type = 'checkbox';
      const run = button('Rodar', () => {
        api.benchmark(kind.value as BenchmarkKind, { frames: Number(frames.value), seconds: Number(seconds.value), origin: origin.checked }).then(() => redraw(), failed);
      }, 'play');
      const stop = button('Parar', () => api.cancel(), 'stop');
      const row = document.createElement('div');
      row.className = 'lab-row lab-card';
      row.append(labelled('Teste', kind), labelled('Quadros', frames), labelled('Segundos', seconds), labelled('centro (0,0)', origin), run, stop);
      const help = document.createElement('div');
      help.className = 'lab-muted';
      help.textContent = 'Vistas: mapa, bairro e rua contra VIEW_BUDGETS (e o __roadcraft.budget). Estresse: velocidade 1/2/4× e tráfego 3×. Vazamento: câmera circulando por N s, heap, geometrias, texturas, programas e gpuLedger; inclinação por minuto e o retido ao voltar. Shaders: inverte o que compila programas e conta engasgos. Estabilidade: N s com o jogo rodando.';
      info = document.createElement('pre');
      host.append(help, row, statusLine('bench'), info, table.element);
      redraw();
    },
    refresh: () => redraw(false),
    unmount() { info = null; drawn = ''; },
  };
}

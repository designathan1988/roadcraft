import type { LabTab } from '../labTypes';
import { icon } from '../icons';
import { createLabTable, type LabColumn, type LabTable } from '../table';
import type { Aggregate, EdgeStat } from './aggregate';
import { recursionRows, suspects, type FunctionRow, type Suspect } from './analysis';
import type { CodeState } from './state';
import { createCodeViewer } from './viewer';

/** THE "CODE" TAB: the page's JavaScript sampled live, by function (self and total time, its TypeScript file and line), the selected function's callers and callees, the hot stacks, recursion and the suspects; the code of whatever is clicked. */

type Section = 'functions' | 'stacks' | 'recursion' | 'suspects';

interface EdgeRow { readonly fn: FunctionRow | null; readonly key: string; readonly ms: number; readonly pct: number; readonly samples: number }
interface StackRow { readonly label: string; readonly depth: number; readonly ms: number; readonly pct: number; readonly leaf: string; readonly where: string }

const ms2 = (v: number): string => v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pct = (v: number): string => `${v.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;

const fnColumns = (): LabColumn<FunctionRow>[] => [
  { key: 'name', label: 'Function', value: (r) => r.stat.id.name },
  { key: 'self', label: 'Self ms', value: (r) => r.stat.selfMs, format: ms2, bar: true, title: 'Time with the function on top of the stack' },
  { key: 'total', label: 'Total ms', value: (r) => r.stat.totalMs, format: ms2, bar: true, title: 'Time with the function anywhere on the stack (including what it calls)' },
  { key: 'where', label: 'File:line', value: (r) => r.where },
  { key: 'selfPct', label: 'Self %', value: (r) => r.selfPct, format: pct },
  { key: 'totalPct', label: 'Total %', value: (r) => r.totalPct, format: pct },
  { key: 'frame', label: 'ms/frame', value: (r) => r.msPerFrame, format: (v) => v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 }), title: 'Total divided by the frames drawn in the windows' },
  { key: 'samples', label: 'Samples', value: (r) => r.stat.totalSamples },
  { key: 'category', label: 'Category', value: (r) => r.category },
  { key: 'rec', label: 'Recursion', value: (r) => (r.stat.recursionDepth > 1 ? r.stat.recursionDepth : null), title: 'Most times in the same stack' },
];

export function createCodeTab(state: CodeState): LabTab {
  const { sampler, store } = state;
  let host: HTMLElement | null = null;
  let section: Section = 'functions';
  let selected: string | null = null;
  let drawnVersion = -1, drawnMapped = -1, drawnView = '';
  /** The code shown (`file:line`): not drawn again on every window, so a scrolled viewer stays put. */
  let shownCode = '';
  let rows: FunctionRow[] = [];
  let found: Suspect[] = [];
  let agg: Aggregate = sampler.aggregate(state.view);
  const byKey = new Map<string, FunctionRow>();

  // ---- controls
  const root = document.createElement('div');
  const controls = document.createElement('div');
  controls.className = 'lab-row';
  const live = document.createElement('button');
  live.type = 'button';
  live.title = 'Samples back-to-back windows while this tab is open';
  const record = document.createElement('button');
  record.type = 'button';
  record.title = 'Records until stopped, even with the tab closed (see Show: Recording)';
  const select = (label: string, options: readonly [string, string][], value: string, change: (v: string) => void): HTMLLabelElement => {
    const l = document.createElement('label');
    l.textContent = `${label} `;
    const s = document.createElement('select');
    for (const [v, text] of options) s.append(new Option(text, v));
    s.value = value;
    s.onchange = () => change(s.value);
    l.append(s);
    return l;
  };
  const windowSel = select('Window', [['2000', '2 s'], ['3000', '3 s'], ['5000', '5 s'], ['10000', '10 s']], String(sampler.windowMs), (v) => { sampler.windowMs = Number(v); });
  const intervalSel = select('Interval', [['1', '1 ms (the browser minimum)'], ['10', '10 ms'], ['16', '16 ms'], ['33', '33 ms'], ['50', '50 ms']], String(sampler.intervalMs), (v) => { sampler.intervalMs = Number(v); });
  const viewSel = select('Show', [['last', 'Last window'], ['session', 'Session (cumulative)'], ['recording', 'Recording']], state.view, (v) => { state.view = v as typeof state.view; redraw(true); });
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.textContent = 'Reset session';
  reset.onclick = () => { sampler.resetSession(); redraw(true); };
  controls.append(live, record, windowSel, intervalSel, viewSel, reset);
  const status = document.createElement('div');
  status.className = 'lab-code-note';
  const summary = document.createElement('div');
  summary.className = 'lab-code-summary';
  const sections = document.createElement('div');
  sections.className = 'lab-code-sections';
  const sectionButtons = new Map<Section, HTMLButtonElement>();
  for (const [id, text] of [['functions', 'Functions'], ['stacks', 'Hot stacks'], ['recursion', 'Recursion'], ['suspects', 'Suspects']] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.onclick = () => { section = id; showSection(); };
    sectionButtons.set(id, b);
    sections.append(b);
  }

  // ---- tables
  const choose = (key: string | null): void => { if (key) { selected = key; drawSelected(); } };
  const functions = createLabTable<FunctionRow>({ columns: fnColumns(), rows: () => rows, sort: { key: 'self', desc: true }, categoryKey: 'category', onRow: (r) => choose(r.stat.id.key) });
  const stackRows = (): StackRow[] => {
    const span = Math.max(agg.busyMs + agg.idleMs, 1e-9);
    return [...agg.stacks.values()].sort((a, b) => b.ms - a.ms).slice(0, 300).map((s) => {
      const leaf = byKey.get(s.keys[0] ?? '');
      return {
        label: s.keys.slice(0, 8).map((k) => byKey.get(k)?.stat.id.name ?? '?').join(' ← ') + (s.keys.length > 8 ? ' ← …' : ''),
        depth: s.depth, ms: s.ms, pct: (100 * s.ms) / span, leaf: s.keys[0] ?? '', where: leaf?.where ?? '',
      };
    });
  };
  const stacks = createLabTable<StackRow>({
    columns: [
      { key: 'label', label: 'Stack (leaf ← caller)', value: (r) => r.label },
      { key: 'ms', label: 'ms', value: (r) => r.ms, format: ms2, bar: true },
      { key: 'pct', label: '%', value: (r) => r.pct, format: pct },
      { key: 'depth', label: 'Depth', value: (r) => r.depth },
      { key: 'where', label: 'Leaf at', value: (r) => r.where },
    ],
    rows: stackRows, sort: { key: 'ms', desc: true }, onRow: (r) => choose(r.leaf),
  });
  const recursion = createLabTable<FunctionRow>({
    columns: [
      { key: 'name', label: 'Function', value: (r) => r.stat.id.name },
      { key: 'depth', label: 'Max depth', value: (r) => r.stat.recursionDepth },
      { key: 'kind', label: 'Kind', value: (r) => (r.stat.direct ? 'direct' : 'mutual/indirect') },
      { key: 'ms', label: 'Recursive ms', value: (r) => r.stat.recursionMs, format: ms2 },
      { key: 'total', label: 'Total ms', value: (r) => r.stat.totalMs, format: ms2 },
      { key: 'where', label: 'File:line', value: (r) => r.where },
    ],
    rows: () => recursionRows(rows), sort: { key: 'ms', desc: true }, onRow: (r) => choose(r.stat.id.key),
  });
  const suspectTable = createLabTable<Suspect>({
    columns: [
      { key: 'kind', label: 'Suspect', value: (r) => r.kind },
      { key: 'name', label: 'Function', value: (r) => r.name },
      { key: 'value', label: 'Value', value: (r) => r.value, format: ms2, title: 'ms, or frames on the stack for "deep stack"' },
      { key: 'detail', label: 'Why', value: (r) => r.detail },
      { key: 'where', label: 'File:line', value: (r) => r.where },
    ],
    rows: () => found, sort: { key: 'value', desc: true }, categoryKey: 'kind', onRow: (r) => choose(r.key || null),
  });
  const tables: Record<Section, LabTable> = { functions, stacks, recursion, suspects: suspectTable };
  const sectionHost = document.createElement('div');

  // ---- the selected function
  const sel = document.createElement('div');
  sel.className = 'lab-card lab-code-sel';
  const selTitle = document.createElement('div');
  const edgeColumns = (label: string): LabColumn<EdgeRow>[] => [
    { key: 'name', label, value: (r) => r.fn?.stat.id.name ?? r.key },
    { key: 'ms', label: 'ms via this call', value: (r) => r.ms, format: ms2, bar: true },
    { key: 'pct', label: '% of selected', value: (r) => r.pct, format: pct },
    { key: 'samples', label: 'Samples', value: (r) => r.samples },
    { key: 'where', label: 'File:line', value: (r) => r.fn?.where ?? '' },
  ];
  const edgeRows = (side: 'caller' | 'callee'): EdgeRow[] => {
    if (!selected) return [];
    const total = Math.max(byKey.get(selected)?.stat.totalMs ?? 0, 1e-9);
    const out: EdgeRow[] = [];
    const take = (e: EdgeStat): void => {
      const key = side === 'caller' ? e.caller : e.callee;
      out.push({ fn: byKey.get(key) ?? null, key, ms: e.ms, pct: (100 * e.ms) / total, samples: e.samples });
    };
    for (const e of agg.edges.values()) if ((side === 'caller' ? e.callee : e.caller) === selected) take(e);
    return out;
  };
  const callers = createLabTable<EdgeRow>({ columns: edgeColumns('Callers'), rows: () => edgeRows('caller'), sort: { key: 'ms', desc: true }, onRow: (r) => choose(r.key) });
  const callees = createLabTable<EdgeRow>({ columns: edgeColumns('Calls'), rows: () => edgeRows('callee'), sort: { key: 'ms', desc: true }, onRow: (r) => choose(r.key) });
  const viewer = createCodeViewer(store);
  const h = (text: string): HTMLHeadingElement => { const e = document.createElement('h3'); e.textContent = text; return e; };
  sel.append(selTitle, h('Callers (live)'), callers.element, h('What it calls'), callees.element, h('Code'), viewer.element);

  root.append(controls, status, summary, sections, sectionHost, sel);

  function showSection(): void {
    for (const [id, b] of sectionButtons) b.classList.toggle('on', id === section);
    sectionHost.replaceChildren(tables[section].element);
    tables[section].refresh();
  }

  function drawSelected(): void {
    const r = selected ? byKey.get(selected) : undefined;
    if (!r) {
      selTitle.innerHTML = '<span class="lab-muted"></span>';
      selTitle.firstElementChild!.textContent = selected
        ? `${selected.split('@')[0]} was not sampled in what is shown (switch Show to Session).`
        : 'Click a function (in any table) to see its callers, what it calls and its code.';
      callers.refresh(); callees.refresh();
      if (!selected) { viewer.clear(); shownCode = ''; }
      return;
    }
    const s = r.stat;
    selTitle.replaceChildren();
    const name = document.createElement('strong');
    name.textContent = s.id.name;
    const info = document.createElement('span');
    info.className = 'lab-muted';
    info.textContent = ` ${r.where} · ${r.category} · self ${ms2(s.selfMs)} ms (${pct(r.selfPct)}) · total ${ms2(s.totalMs)} ms (${pct(r.totalPct)}) · seen in ${s.windowsSeen} of ${agg.windows} windows${s.recursionDepth > 1 ? ` · recursion up to ${s.recursionDepth}×` : ''}`;
    selTitle.append(name, info);
    callers.refresh(); callees.refresh();
    const code = r.loc ? `${r.loc.file}:${r.loc.line}` : s.id.key;
    if (code === shownCode) return;
    shownCode = code;
    if (r.loc) viewer.show(r.loc.file, r.loc.line, r.loc.column, s.id.name);
    // No map behind it (a prebundled dependency): the script as served, at its generated line; a game module whose map is still coming waits for the next redraw.
    else if (s.id.url.startsWith('http') && !new URL(s.id.url).pathname.startsWith('/src/')) viewer.show(new URL(s.id.url).pathname, s.id.line, s.id.column, `${s.id.name} (generated code)`);
    else viewer.clear();
  }

  function redraw(force: boolean): void {
    agg = sampler.aggregate(state.view);
    const mapped = store.stats().mapped;
    live.replaceChildren(icon('pulse', 13), state.live ? ' Live (on)' : ' Live');
    live.classList.toggle('on', state.live);
    record.replaceChildren(icon('record', 13), sampler.recording ? ' Stop recording' : ' Record');
    record.classList.toggle('on', sampler.recording);
    const mode = sampler.recording ? 'recording' : sampler.running ? 'sampling live' : 'stopped';
    status.textContent = sampler.problem ?? `Profiler: ${mode} · actual interval ${sampler.actualIntervalMs} ms · window ${sampler.windowMs / 1000} s · main thread only (workers not shown) · ${mapped} modules mapped to TypeScript`;
    status.className = sampler.problem ? 'lab-code-note lab-bad' : 'lab-code-note';
    if (!force && agg.version === drawnVersion && mapped === drawnMapped && drawnView === state.view) return;
    drawnVersion = agg.version; drawnMapped = mapped; drawnView = state.view;
    rows = state.rows(agg);
    byKey.clear();
    for (const r of rows) byKey.set(r.stat.id.key, r);
    found = suspects(agg, rows, state.products);
    const span = agg.busyMs + agg.idleMs;
    const item = (label: string, value: string, cls = ''): HTMLElement => { const e = document.createElement('span'); e.innerHTML = `${label} <b class="${cls}"></b>`; e.querySelector('b')!.textContent = value; return e; };
    summary.replaceChildren(
      item('Windows', String(agg.windows)),
      item('Samples', String(agg.samples)),
      item('Sampled time', `${ms2(span)} ms`),
      item('JS busy', span ? pct((100 * agg.busyMs) / span) : '—', agg.busyMs / Math.max(span, 1) > 0.6 ? 'lab-warn' : ''),
      item('GC', `${ms2(agg.gcMs)} ms`),
      item('Frames', String(agg.frames)),
      item('Deepest stack', String(agg.maxDepth), agg.maxDepth >= 60 ? 'lab-warn' : ''),
      item('Functions', String(rows.length)),
      item('Suspects', String(found.length), found.length ? 'lab-warn' : 'lab-good'),
    );
    tables[section].refresh();
    drawSelected();
  }

  live.onclick = () => { state.live = !state.live; sampler.setLive(state.live); redraw(false); };
  record.onclick = () => { sampler.setRecording(!sampler.recording); if (sampler.recording) { state.view = 'recording'; (viewSel.querySelector('select')!).value = 'recording'; } redraw(true); };

  return {
    id: 'code',
    title: 'Code',
    mount(target) {
      host = target;
      host.append(root);
      showSection();
      sampler.setLive(state.live);
      redraw(true);
    },
    refresh: () => redraw(false),
    /** `{ filter }`: the functions whose name or file holds it (an inspected object's code, `ctx.navigate('code', ...)`), over the session; `{ category }` too. */
    focus(params) {
      section = 'functions';
      if (state.view === 'last') { state.view = 'session'; viewSel.querySelector('select')!.value = 'session'; }
      showSection();
      redraw(true);
      functions.setFilter({ text: params['filter'] ?? '', ...(params['category'] ? { category: params['category'] } : {}) });
      const first = rows.find((r) => params['filter'] && (r.stat.id.name === params['filter'] || r.where.includes(params['filter'])));
      if (first) choose(first.stat.id.key);
    },
    unmount() {
      host = null;
      sampler.setLive(false);
    },
  };
}

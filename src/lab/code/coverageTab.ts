import type { LabTab } from '../labTypes';
import { createLabTable } from '../table';
import { declaredFunctions, type DeclaredFunction } from './declared';
import type { CodeState } from './state';
import { createCodeViewer } from './viewer';

/** THE "COVERAGE" TAB: the functions the game's modules declare against the ones the sampling profiler saw this session - an approximate runtime coverage (a sampler misses what runs briefly: "not seen" is a lead, not a proof). The exact one comes from V8's precise coverage (`scripts/lab/coverage.mjs`). */

interface DeclaredRow {
  readonly file: string;
  readonly fn: DeclaredFunction;
  readonly seen: boolean;
  readonly ms: number;
}
interface FileRow {
  readonly file: string;
  readonly declared: number;
  readonly seen: number;
  readonly pct: number;
  readonly ms: number;
}

const ENTRY = '/src/main.ts';
const COMMAND = 'node scripts/lab/coverage.mjs --seconds=60 --city --views';

export interface CoverageResult {
  readonly modules: number;
  readonly declared: number;
  readonly seen: number;
  readonly files: readonly FileRow[];
  readonly unseen: readonly DeclaredRow[];
}

export interface CoverageTab extends LabTab {
  /** The modules crawled from the entry (fetched once) and the coverage computed now. */
  analyse(): Promise<CoverageResult>;
  /** The last result, or null before the first analysis. */
  result(): CoverageResult | null;
}

export function createCoverageTab(state: CodeState): CoverageTab {
  const { store } = state;
  let modules: readonly string[] = [];
  let declared: DeclaredRow[] = [];
  let files: FileRow[] = [];
  let last: CoverageResult | null = null;
  const parsed = new Map<string, DeclaredFunction[]>();

  const root = document.createElement('div');
  const note = document.createElement('p');
  note.className = 'lab-code-note';
  note.textContent = 'Functions declared in the game modules (found in the TypeScript code) against the ones the sampling profiler saw this session (Code tab, "Session"). Sampling misses short functions: "not seen" is a lead to dead code, not proof. Leave the Code tab sampling while you play and come back here.';
  const row = document.createElement('div');
  row.className = 'lab-row';
  const run = document.createElement('button');
  run.type = 'button';
  run.textContent = 'Analyse game modules';
  run.title = `Fetches ${ENTRY} and every module it imports (Vite server), with their source maps`;
  const progress = document.createElement('span');
  progress.className = 'lab-muted';
  const full = document.createElement('button');
  full.type = 'button';
  full.textContent = 'Exact coverage (V8)…';
  row.append(run, progress, full);
  const help = document.createElement('div');
  help.hidden = true;
  help.innerHTML = '<p class="lab-code-note">Exact coverage uses the V8 precise coverage (Chrome DevTools Protocol, Profiler.startPreciseCoverage with call counts and block coverage): it opens the game in headless Chrome, plays for a while, maps each code range to TypeScript through the source maps and runs knip (unused exports and files). With the dev server running, in the project terminal:</p>';
  const cmd = document.createElement('pre');
  cmd.textContent = `${COMMAND}\n# options: --seconds=N (time playing), --city (generates the test city), --views (visits views), --no-knip, --url=http://127.0.0.1:5300/\n# output: lab-reports/coverage-<date>.json and .md`;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy command';
  copy.onclick = () => void navigator.clipboard.writeText(COMMAND).catch((error: unknown) => console.warn('lab code: not copied', error));
  help.append(cmd, copy);
  full.onclick = () => { help.hidden = !help.hidden; };
  const summary = document.createElement('div');
  summary.className = 'lab-code-summary';
  const viewer = createCodeViewer(store);
  const h = (text: string): HTMLHeadingElement => { const e = document.createElement('h3'); e.textContent = text; return e; };
  let fileFilter = '';
  const fileTable = createLabTable<FileRow>({
    columns: [
      { key: 'file', label: 'File', value: (r) => r.file.replace(/^\//, '') },
      { key: 'declared', label: 'Declared', value: (r) => r.declared },
      { key: 'seen', label: 'Seen', value: (r) => r.seen },
      { key: 'pct', label: '% seen', value: (r) => r.pct, format: (v) => `${v.toFixed(0)}%` },
      { key: 'ms', label: 'Sampled ms', value: (r) => r.ms, format: (v) => v.toFixed(1), bar: true },
    ],
    rows: () => files, sort: { key: 'declared', desc: true },
    onRow: (r) => { fileFilter = r.file; fnTable.refresh(); fnTitle.textContent = `Functions of ${r.file.replace(/^\//, '')}`; },
  });
  const fnTitle = h('Functions (all: click a file to filter)');
  const fnTable = createLabTable<DeclaredRow>({
    columns: [
      { key: 'name', label: 'Function', value: (r) => r.fn.name },
      { key: 'seen', label: 'Seen', value: (r) => (r.seen ? 'seen' : 'not seen') },
      { key: 'kind', label: 'Kind', value: (r) => r.fn.kind },
      { key: 'ms', label: 'ms', value: (r) => r.ms, format: (v) => v.toFixed(1) },
      { key: 'where', label: 'File:line', value: (r) => `${r.file.replace(/^\//, '')}:${r.fn.line}` },
    ],
    rows: () => (fileFilter ? declared.filter((d) => d.file === fileFilter) : declared),
    sort: { key: 'where', desc: false }, categoryKey: 'seen', limit: 600,
    onRow: (r) => viewer.show(r.file, r.fn.line, 1, r.fn.name),
  });
  root.append(note, row, help, summary, h('Files'), fileTable.element, fnTitle, fnTable.element, h('Code'), viewer.element);

  /** The coverage from the modules known and the session's samples. */
  function compute(): CoverageResult {
    const seen = state.seenLines();
    declared = [];
    const perFile: FileRow[] = [];
    for (const file of store.files()) {
      if (!file.startsWith('/src/')) continue;
      const text = store.textNow(file);
      if (text === null) continue;
      let fns = parsed.get(file);
      if (!fns) { fns = declaredFunctions(text); parsed.set(file, fns); }
      const lines = seen.get(file);
      let n = 0, msFile = 0;
      for (const fn of fns) {
        const ms = lines?.get(fn.line) ?? 0;
        const hit = lines?.has(fn.line) ?? false;
        if (hit) { n++; msFile += ms; }
        declared.push({ file, fn, seen: hit, ms });
      }
      if (fns.length) perFile.push({ file, declared: fns.length, seen: n, pct: (100 * n) / fns.length, ms: msFile });
    }
    files = perFile;
    const seenCount = declared.filter((d) => d.seen).length;
    last = { modules: modules.length || store.stats().mapped, declared: declared.length, seen: seenCount, files, unseen: declared.filter((d) => !d.seen) };
    summary.replaceChildren();
    for (const [label, value] of [['Modules', String(last.modules)], ['Declared functions', String(last.declared)], ['Seen by the profiler', String(seenCount)], ['Approximate coverage', last.declared ? `${((100 * seenCount) / last.declared).toFixed(1)}%` : '—'], ['Session windows', String(state.sampler.aggregate('session').windows)]] as const) {
      const e = document.createElement('span');
      e.textContent = `${label}: `;
      const b = document.createElement('b');
      b.textContent = value;
      e.append(b);
      summary.append(e);
    }
    fileTable.refresh();
    fnTable.refresh();
    return last;
  }

  const tab: CoverageTab = {
    id: 'coverage',
    title: 'Coverage',
    mount(host) {
      host.append(root);
      compute();
    },
    async analyse() {
      run.disabled = true;
      try {
        modules = await store.crawl(ENTRY, (done, total) => { progress.textContent = `${done} of ${total} modules`; });
        progress.textContent = `${modules.length} modules (${store.stats().failed} failed)`;
      } finally {
        run.disabled = false;
      }
      return compute();
    },
    result: () => last,
    /** `{ filter }`: the declared functions whose name or file holds it. */
    focus(params) {
      fileFilter = '';
      fnTitle.textContent = 'Functions';
      fnTable.setFilter({ text: params['filter'] ?? '' });
    },
  };
  run.onclick = () => void tab.analyse().catch((error: unknown) => { console.error('lab code: coverage failed', error); progress.textContent = `failed: ${String(error)}`; });
  return tab;
}

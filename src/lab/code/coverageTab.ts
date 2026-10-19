import type { LabTab } from '../labTypes';
import { createLabTable } from '../table';
import { declaredFunctions, type DeclaredFunction } from './declared';
import type { CodeState } from './state';
import { createCodeViewer } from './viewer';

/** THE "COBERTURA" TAB: the functions the game's modules declare against the ones the sampling profiler saw this session - an approximate runtime coverage (a sampler misses what runs briefly: "not seen" is a lead, not a proof). The exact one comes from V8's precise coverage (`scripts/lab/coverage.mjs`). */

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
  note.textContent = 'Funções declaradas nos módulos do jogo (achadas no código TypeScript) contra as que o profiler por amostragem viu nesta sessão (aba Código, "Sessão"). Amostragem perde funções curtas: "não vista" é pista de código morto, não prova. Deixe a aba Código amostrando enquanto joga e volte aqui.';
  const row = document.createElement('div');
  row.className = 'lab-row';
  const run = document.createElement('button');
  run.type = 'button';
  run.textContent = 'Analisar módulos do jogo';
  run.title = `Busca ${ENTRY} e todos os módulos que ele importa (servidor do Vite), com seus mapas de código`;
  const progress = document.createElement('span');
  progress.className = 'lab-muted';
  const full = document.createElement('button');
  full.type = 'button';
  full.textContent = 'Cobertura exata (V8)…';
  row.append(run, progress, full);
  const help = document.createElement('div');
  help.hidden = true;
  help.innerHTML = '<p class="lab-code-note">A cobertura exata usa a cobertura precisa do V8 (Chrome DevTools Protocol, Profiler.startPreciseCoverage com contagem de chamadas e blocos): abre o jogo num Chrome sem janela, joga por um tempo, mapeia cada faixa de código ao TypeScript pelos source maps e roda o knip (exports e arquivos não usados). Com o servidor de desenvolvimento rodando, no terminal do projeto:</p>';
  const cmd = document.createElement('pre');
  cmd.textContent = `${COMMAND}\n# opções: --seconds=N (tempo jogando), --city (gera a cidade de teste), --views (visita vistas), --no-knip, --url=http://127.0.0.1:5300/\n# saída: lab-reports/coverage-<data>.json e .md`;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copiar comando';
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
      { key: 'file', label: 'Arquivo', value: (r) => r.file.replace(/^\//, '') },
      { key: 'declared', label: 'Declaradas', value: (r) => r.declared },
      { key: 'seen', label: 'Vistas', value: (r) => r.seen },
      { key: 'pct', label: '% vistas', value: (r) => r.pct, format: (v) => `${v.toFixed(0)}%` },
      { key: 'ms', label: 'ms amostrados', value: (r) => r.ms, format: (v) => v.toFixed(1), bar: true },
    ],
    rows: () => files, sort: { key: 'declared', desc: true },
    onRow: (r) => { fileFilter = r.file; fnTable.refresh(); fnTitle.textContent = `Funções de ${r.file.replace(/^\//, '')}`; },
  });
  const fnTitle = h('Funções (todas: clique num arquivo para filtrar)');
  const fnTable = createLabTable<DeclaredRow>({
    columns: [
      { key: 'name', label: 'Função', value: (r) => r.fn.name },
      { key: 'seen', label: 'Vista', value: (r) => (r.seen ? 'vista' : 'não vista') },
      { key: 'kind', label: 'Tipo', value: (r) => r.fn.kind },
      { key: 'ms', label: 'ms', value: (r) => r.ms, format: (v) => v.toFixed(1) },
      { key: 'where', label: 'Arquivo:linha', value: (r) => `${r.file.replace(/^\//, '')}:${r.fn.line}` },
    ],
    rows: () => (fileFilter ? declared.filter((d) => d.file === fileFilter) : declared),
    sort: { key: 'where', desc: false }, categoryKey: 'seen', limit: 600,
    onRow: (r) => viewer.show(r.file, r.fn.line, 1, r.fn.name),
  });
  root.append(note, row, help, summary, h('Arquivos'), fileTable.element, fnTitle, fnTable.element, h('Código'), viewer.element);

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
    for (const [label, value] of [['Módulos', String(last.modules)], ['Funções declaradas', String(last.declared)], ['Vistas pelo profiler', String(seenCount)], ['Cobertura aproximada', last.declared ? `${((100 * seenCount) / last.declared).toFixed(1)}%` : '—'], ['Janelas da sessão', String(state.sampler.aggregate('session').windows)]] as const) {
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
    title: 'Cobertura',
    mount(host) {
      host.append(root);
      compute();
    },
    async analyse() {
      run.disabled = true;
      try {
        modules = await store.crawl(ENTRY, (done, total) => { progress.textContent = `${done} de ${total} módulos`; });
        progress.textContent = `${modules.length} módulos (${store.stats().failed} falharam)`;
      } finally {
        run.disabled = false;
      }
      return compute();
    },
    result: () => last,
    /** `{ filter }`: the declared functions whose name or file holds it. */
    focus(params) {
      fileFilter = '';
      fnTitle.textContent = 'Funções';
      fnTable.setFilter({ text: params['filter'] ?? '' });
    },
  };
  run.onclick = () => void tab.analyse().catch((error: unknown) => { console.error('lab code: coverage failed', error); progress.textContent = `falhou: ${String(error)}`; });
  return tab;
}

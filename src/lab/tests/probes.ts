import type { LabTab } from '../labTypes';

/** THE PROBES: every `window.__*` the page holds, each function listed, the ones known to only read run by a click and their answer shown
 *  as JSON; and how the specs (vitest) are run - they run in Node, not in the page. */

/** The calls known to only read (`main.ts` probes, the lab's own): anything else is listed, not run - it may move the camera, open a map,
 *  reset a reading (`__gpu(true)`) or grow a building. */
const SAFE: readonly { readonly path: string; readonly args?: readonly unknown[]; readonly note: string }[] = [
  { path: '__gpu', note: 'tempos da GPU desde o último reinício (sem reiniciar)' },
  { path: '__frames', note: 'os últimos quadros por sistema' },
  { path: '__health', note: 'o que quebrou ou foi lento, mais novo primeiro' },
  { path: '__state', note: 'o estado do jogo e as últimas mudanças' },
  { path: '__changes', args: [15], note: 'o diário de mudanças do mapa (15)' },
  { path: '__roadcraft.profiler', note: 'o perfilador cirúrgico' },
  { path: '__roadcraft.ledger', note: 'o livro dos produtos do engine' },
  { path: '__roadcraft.memory', note: 'a memória da cena (percorre a cena)' },
  { path: '__roadcraft.inventory', args: [{ top: 25 }], note: 'tudo que a cena tem, por camada (percorre a cena)' },
  { path: '__roadcraft.budget', args: ['district'], note: 'orçamento do plano, vista bairro' },
  { path: '__roadcraft.budget', args: ['street'], note: 'orçamento do plano, vista rua' },
  { path: '__roadcraft.budget', args: ['map'], note: 'orçamento do plano, vista mapa' },
  { path: '__roadcraft.audit', note: 'as falhas das checagens da simulação' },
  { path: '__lab.collectReport', note: 'o relatório do laboratório, todas as seções' },
  { path: '__lab.events', note: 'os eventos do laboratório' },
  { path: '__labOpt.list', note: 'as otimizações expostas' },
  { path: '__labTests.results', note: 'os resultados destes testes' },
  { path: '__labTests.items', note: 'o que a varredura A/B pode inverter' },
];

/** What the specs are and how they run: `vitest.config.ts`, `vitest.scale.config.ts`, `package.json`. A list of the files is not built into
 *  the page on purpose: `import.meta.glob` would put every spec into the game's build (Vite turns each match into a chunk). `node
 *  scripts/lab/sweep.mjs --specs` lists them from the disk. */
const SPECS_NOTE = [
  'Os testes (vitest) rodam no Node, não na página:',
  '  npm test                         todos (tests/**/*.spec.ts, exceto perf e scale), na fatia da máquina da conversa',
  '  npm run test:scale               as suítes de contagem (tests/perf, tests/scale), um arquivo por vez',
  '  npx vitest run tests/<pasta>     uma pasta (arch, core, render, sim, ui, view, world, editor, people, perf, scale...)',
  '  node scripts/lab/sweep.mjs --specs   lista cada arquivo de teste por pasta',
  'A varredura A/B sem janela (Playwright, recusa máquina ocupada):',
  '  node scripts/lab/sweep.mjs --group "interruptor: pós" --frames 120 --reps 2 [--zoom 4] [--shared-gpu] [--shared-machine]',
].join('\n');

const resolvePath = (path: string): { owner: unknown; fn: unknown } => {
  const parts = path.split('.');
  let owner: unknown = window;
  let value: unknown = window;
  for (const part of parts) {
    owner = value;
    value = value && (typeof value === 'object' || typeof value === 'function') ? (value as Record<string, unknown>)[part] : undefined;
  }
  return { owner, fn: value };
};

/** JSON of anything: Maps and Sets as arrays, cycles and DOM nodes named, long text cut. */
export function safeJson(value: unknown, limit = 200_000): string {
  const seen = new WeakSet<object>();
  const out = JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint') return String(v);
    if (typeof v === 'function') return `ƒ ${(v as { name?: string }).name ?? ''}`;
    if (v instanceof Map) return [...v.entries()];
    if (v instanceof Set) return [...v];
    if (typeof Node !== 'undefined' && v instanceof Node) return `<${v.nodeName}>`;
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[ciclo]';
      seen.add(v);
    }
    return v;
  }, 1) ?? String(value);
  return out.length > limit ? `${out.slice(0, limit)}\n… (${out.length - limit} caracteres cortados)` : out;
}

export function createProbesTab(): LabTab {
  let output: HTMLPreElement | null = null;
  const run = async (path: string, args: readonly unknown[]): Promise<void> => {
    if (!output) return;
    const { owner, fn } = resolvePath(path);
    if (typeof fn !== 'function') { output.textContent = `${path}: não está na página`; return; }
    output.textContent = `${path}(…) rodando`;
    const t0 = performance.now();
    try {
      const value: unknown = await (fn as (...a: unknown[]) => unknown).apply(owner, [...args]);
      output.textContent = `${path}(${args.map((a) => JSON.stringify(a)).join(', ')}) em ${(performance.now() - t0).toFixed(1)} ms\n${safeJson(value)}`;
    } catch (error) {
      console.warn(`lab probe ${path} failed`, error);
      output.textContent = `${path}: erro\n${String(error)}`;
    }
  };
  return {
    id: 'probes',
    title: 'Sondas',
    mount(host) {
      const h = document.createElement('h3');
      h.textContent = 'Sondas da página (window.__*)';
      const note = document.createElement('p');
      note.className = 'lab-muted';
      note.textContent = 'Só as chamadas conhecidas como de leitura têm botão; as outras são listadas (podem mover a câmera, abrir mapa ou zerar leituras).';
      const safeRow = document.createElement('div');
      safeRow.className = 'lab-row';
      for (const s of SAFE) {
        const b = document.createElement('button');
        b.type = 'button';
        const present = typeof resolvePath(s.path).fn === 'function';
        b.textContent = `${s.path}(${(s.args ?? []).map((a) => JSON.stringify(a)).join(', ')})`;
        b.title = s.note + (present ? '' : ' — ausente nesta página');
        b.disabled = !present;
        b.onclick = () => void run(s.path, s.args ?? []);
        safeRow.appendChild(b);
      }
      const all = document.createElement('pre');
      all.textContent = listProbes();
      output = document.createElement('pre');
      output.style.maxHeight = '40vh';
      output.textContent = 'Clique numa sonda para ver o resultado em JSON.';
      const specsTitle = document.createElement('h3');
      specsTitle.textContent = 'Testes automatizados (vitest) e o executor sem janela';
      const specs = document.createElement('pre');
      specs.textContent = SPECS_NOTE;
      host.append(h, note, safeRow, output, all, specsTitle, specs);
    },
    unmount() { output = null; },
  };
}

/** Every `window.__*` and, for objects, their functions and fields, one line each. */
function listProbes(): string {
  const lines: string[] = ['Todas as sondas encontradas:'];
  const keys = Object.getOwnPropertyNames(window).filter((k) => k.startsWith('__') && !k.startsWith('__VUE') && !k.startsWith('__vite')).sort();
  for (const key of keys) {
    const v = (window as unknown as Record<string, unknown>)[key];
    if (typeof v === 'function') { lines.push(`  ${key}(${(v as { length: number }).length} args)`); continue; }
    if (!v || typeof v !== 'object') { lines.push(`  ${key}: ${typeof v}`); continue; }
    const members = Object.keys(v).map((m) => (typeof (v as Record<string, unknown>)[m] === 'function' ? `${m}()` : m));
    lines.push(`  ${key}: ${members.join(', ')}`);
  }
  return lines.join('\n');
}

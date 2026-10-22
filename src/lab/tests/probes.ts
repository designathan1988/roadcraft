import type { LabTab } from '../labTypes';

/** THE PROBES: every `window.__*` the page holds, each function listed, the ones known to only read run by a click and their answer shown
 *  as JSON; and how the specs (vitest) are run - they run in Node, not in the page. */

/** The calls known to only read (`main.ts` probes, the lab's own): anything else is listed, not run - it may move the camera, open a map,
 *  reset a reading (`__gpu(true)`) or grow a building. */
const SAFE: readonly { readonly path: string; readonly args?: readonly unknown[]; readonly note: string }[] = [
  { path: '__gpu', note: 'GPU times since the last reset (without resetting)' },
  { path: '__frames', note: 'the latest frames by system' },
  { path: '__health', note: 'what broke or was slow, newest first' },
  { path: '__state', note: 'the game state and the latest changes' },
  { path: '__changes', args: [15], note: 'the map change log (15)' },
  { path: '__roadcraft.profiler', note: 'the surgical profiler' },
  { path: '__roadcraft.ledger', note: 'the ledger of the engine products' },
  { path: '__roadcraft.memory', note: 'the scene memory (walks the scene)' },
  { path: '__roadcraft.inventory', args: [{ top: 25 }], note: 'everything the scene holds, by layer (walks the scene)' },
  { path: '__roadcraft.budget', args: ['district'], note: 'plan budget, district view' },
  { path: '__roadcraft.budget', args: ['street'], note: 'plan budget, street view' },
  { path: '__roadcraft.budget', args: ['map'], note: 'plan budget, map view' },
  { path: '__roadcraft.audit', note: 'the simulation check failures' },
  { path: '__lab.collectReport', note: 'the lab report, all sections' },
  { path: '__lab.events', note: 'the lab events' },
  { path: '__labOpt.list', note: 'the exposed optimizations' },
  { path: '__labTests.results', note: 'the results of these tests' },
  { path: '__labTests.items', note: 'what the A/B sweep can flip' },
];

/** What the specs are and how they run: `vitest.config.ts`, `vitest.scale.config.ts`, `package.json`. A list of the files is not built into
 *  the page on purpose: `import.meta.glob` would put every spec into the game's build (Vite turns each match into a chunk). `node
 *  scripts/lab/sweep.mjs --specs` lists them from the disk. */
const SPECS_NOTE = [
  'The tests (vitest) run in Node, not in the page:',
  '  npm test                         all (tests/**/*.spec.ts, except perf and scale), on the session machine slice',
  '  npm run test:scale               the counting suites (tests/perf, tests/scale), one file at a time',
  '  npx vitest run tests/<folder>    one folder (arch, core, render, sim, ui, view, world, editor, people, perf, scale...)',
  '  node scripts/lab/sweep.mjs --specs   lists each test file by folder',
  'The headless A/B sweep (Playwright, refuses a busy machine):',
  '  node scripts/lab/sweep.mjs --group "switch: post" --frames 120 --reps 2 [--zoom 4] [--shared-gpu] [--shared-machine]',
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
      if (seen.has(v)) return '[cycle]';
      seen.add(v);
    }
    return v;
  }, 1) ?? String(value);
  return out.length > limit ? `${out.slice(0, limit)}\n… (${out.length - limit} characters cut)` : out;
}

export function createProbesTab(): LabTab {
  let output: HTMLPreElement | null = null;
  const run = async (path: string, args: readonly unknown[]): Promise<void> => {
    if (!output) return;
    const { owner, fn } = resolvePath(path);
    if (typeof fn !== 'function') { output.textContent = `${path}: not in the page`; return; }
    output.textContent = `${path}(…) running`;
    const t0 = performance.now();
    try {
      const value: unknown = await (fn as (...a: unknown[]) => unknown).apply(owner, [...args]);
      output.textContent = `${path}(${args.map((a) => JSON.stringify(a)).join(', ')}) in ${(performance.now() - t0).toFixed(1)} ms\n${safeJson(value)}`;
    } catch (error) {
      console.warn(`lab probe ${path} failed`, error);
      output.textContent = `${path}: error\n${String(error)}`;
    }
  };
  return {
    id: 'probes',
    title: 'Probes',
    mount(host) {
      const h = document.createElement('h3');
      h.textContent = 'Page probes (window.__*)';
      const note = document.createElement('p');
      note.className = 'lab-muted';
      note.textContent = 'Only calls known to be read-only get a button; the others are listed (they may move the camera, open a map or reset readings).';
      const safeRow = document.createElement('div');
      safeRow.className = 'lab-row';
      for (const s of SAFE) {
        const b = document.createElement('button');
        b.type = 'button';
        const present = typeof resolvePath(s.path).fn === 'function';
        b.textContent = `${s.path}(${(s.args ?? []).map((a) => JSON.stringify(a)).join(', ')})`;
        b.title = s.note + (present ? '' : ' — missing on this page');
        b.disabled = !present;
        b.onclick = () => void run(s.path, s.args ?? []);
        safeRow.appendChild(b);
      }
      const all = document.createElement('pre');
      all.textContent = listProbes();
      output = document.createElement('pre');
      output.style.maxHeight = '40vh';
      output.textContent = 'Click a probe to see its result as JSON.';
      const specsTitle = document.createElement('h3');
      specsTitle.textContent = 'Automated tests (vitest) and the headless runner';
      const specs = document.createElement('pre');
      specs.textContent = SPECS_NOTE;
      host.append(h, note, safeRow, output, all, specsTitle, specs);
    },
    unmount() { output = null; },
  };
}

/** Every `window.__*` and, for objects, their functions and fields, one line each. */
function listProbes(): string {
  const lines: string[] = ['All probes found:'];
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

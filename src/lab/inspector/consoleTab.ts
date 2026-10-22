import type { Material, Object3D } from 'three';
import type { LabTab } from '../labTypes';
import { button, el, valueTree } from './dom';
import { materialsOf } from './describe';
import type { InspectorState } from './state';

/** THE CONSOLE TAB: JavaScript evaluated in the page with the inspector's handles in scope - `$sel` (the selection), `$obj` (its 3D object), `$mat` (its first material),
 *  `$scene`, `$gl`, `lab` (the lab's context), `$inspect(obj)`, `$find(text)`, `$_` (the last result) - and the page's probes (`__roadcraft`, `__labOpt`, `__labGpu`...).
 *  An expression's value is shown (awaited when a promise), else the code runs as a function body (`return` gives its value). Enter runs, Shift+Enter a new line, ↑/↓ the history. */

/** The constructor of async functions: the code given awaits freely. */
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;

const HISTORY_KEY = 'roadcraft.lab.console';
const HISTORY_KEPT = 100;

/** Ready-made snippets: the questions asked most of a scene. */
const SNIPPETS: readonly (readonly [string, string])[] = [
  ['Materiais por tipo', `const by = {}; const seen = new Set();
$scene.traverse((o) => { for (const m of [].concat(o.material ?? [])) { if (seen.has(m)) continue; seen.add(m); by[m.type] = (by[m.type] ?? 0) + 1; } });
return by;`],
  ['Programas compilados', `return $gl.info.programs.map((p) => ({ id: p.id, nome: p.name, usos: p.usedTimes })).sort((a, b) => b.usos - a.usos);`],
  ['Malhas com um nome', `return $find('asphalt').map((o) => ({ tipo: o.type, nome: o.name, visível: o.visible, uuid: o.uuid }));`],
  ['Maiores geometrias', `const rows = []; const seen = new Set();
$scene.traverse((o) => { const g = o.geometry; if (!g || seen.has(g)) return; seen.add(g); let b = 0;
  for (const a of Object.values(g.attributes)) b += (a.array ?? a.data?.array)?.byteLength ?? a.keptBytes ?? 0; b += g.index?.array?.byteLength ?? 0;
  rows.push({ nome: o.name, tipo: o.type, mb: +(b / 1048576).toFixed(2) }); });
return rows.sort((a, b) => b.mb - a.mb).slice(0, 25);`],
  ['Objetos por tipo', `const by = {}; $scene.traverse((o) => { by[o.type] = (by[o.type] ?? 0) + 1; }); return by;`],
  ['Renderizador: info', `return { render: { ...$gl.info.render }, memory: { ...$gl.info.memory }, programs: $gl.info.programs?.length, pixelRatio: $gl.getPixelRatio() };`],
  ['Texturas da seleção', `return ($obj ? [].concat($obj.material ?? []) : []).flatMap((m) => Object.entries(m).filter(([, v]) => v?.isTexture).map(([k, t]) => ({ slot: k, nome: t.name, w: t.image?.width, h: t.image?.height, aniso: t.anisotropy })));`],
  ['Selecionar pelo nome', `return $inspect($find('benches')[0]);`],
];

interface Entry { readonly code: string; readonly ok: boolean; readonly value: unknown; readonly ms: number }

export function createConsoleTab(state: InspectorState): LabTab {
  const ctx = state.ctx;
  let output: HTMLElement | null = null;
  let input: HTMLTextAreaElement | null = null;
  let last: unknown = undefined;
  let cursor = -1;
  const history: string[] = (() => {
    try {
      const raw = JSON.parse(window.localStorage.getItem(HISTORY_KEY) ?? '[]') as unknown;
      return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : [];
    } catch (error) {
      console.warn('lab console: history unreadable', error);
      return [];
    }
  })();
  const entries: Entry[] = [];

  const find = (text: string): Object3D[] => {
    const out: Object3D[] = [];
    const t = text.toLowerCase();
    ctx.scene.scene.traverse((o) => { if (`${o.name}`.toLowerCase().includes(t)) out.push(o); });
    return out;
  };
  const inspect = (o: Object3D | null | undefined): string => {
    if (!o?.isObject3D) return 'não é um Object3D';
    state.select({ object: o, instanceId: null, batchId: null, point: null, exact: false, entity: null, entities: [], hits: [], via: 'console' });
    return `selecionado: ${o.type} "${o.name}" (veja o Inspetor)`;
  };

  const scope = (): Record<string, unknown> => {
    const sel = state.selection;
    const obj = sel?.object ?? null;
    return {
      $sel: sel, $obj: obj, $mat: obj ? (materialsOf(obj)[0] as Material | undefined) ?? null : null, $scene: ctx.scene.scene, $gl: ctx.scene.gl, lab: ctx,
      $inspect: inspect, $find: find, $_: last,
    };
  };

  const show = (entry: Entry): void => {
    if (!output) return;
    const block = el('div', `insp-out${entry.ok ? '' : ' err'}`);
    block.appendChild(el('pre', 'insp-out-code', `› ${entry.code}`));
    if (entry.ok) block.appendChild(valueTree(entry.value));
    else {
      const e = entry.value as Error;
      block.appendChild(el('pre', 'lab-bad insp-out-err', `${e?.name ?? 'Erro'}: ${e?.message ?? String(e)}\n${e?.stack?.split('\n').slice(1, 6).join('\n') ?? ''}`));
    }
    block.appendChild(el('span', 'lab-muted insp-out-ms', `${entry.ms.toFixed(1)} ms`));
    output.appendChild(block);
    output.scrollTop = output.scrollHeight;
  };

  const run = async (code: string): Promise<void> => {
    const source = code.trim();
    if (!source) return;
    if (history[history.length - 1] !== source) history.push(source);
    if (history.length > HISTORY_KEPT) history.splice(0, history.length - HISTORY_KEPT);
    try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch (error) { console.warn('lab console: history not kept', error); }
    cursor = -1;
    const vars = scope();
    const names = Object.keys(vars);
    const t0 = performance.now();
    let fn: (...values: unknown[]) => Promise<unknown>;
    try {
      // An expression first (its value shown); a body of statements when it is not one.
      fn = new AsyncFunction(...names, `return (${source}\n);`);
    } catch (notExpression) {
      if (!(notExpression instanceof SyntaxError)) throw notExpression;
      try {
        fn = new AsyncFunction(...names, source);
      } catch (inner) {
        console.warn('lab console: not valid JavaScript', inner);
        const entry: Entry = { code: source, ok: false, value: inner, ms: performance.now() - t0 };
        entries.push(entry);
        show(entry);
        return;
      }
    }
    try {
      const value = await fn(...names.map((n) => vars[n]));
      last = value;
      const entry: Entry = { code: source, ok: true, value, ms: performance.now() - t0 };
      entries.push(entry);
      show(entry);
      ctx.requestDraw();
    } catch (error) {
      console.warn('lab console: evaluation threw', error);
      const entry: Entry = { code: source, ok: false, value: error, ms: performance.now() - t0 };
      entries.push(entry);
      show(entry);
    }
    ctx.emit('console.eval', `console: ${source.split('\n')[0]!.slice(0, 80)}`);
  };

  const onKey = (e: KeyboardEvent): void => {
    if (!input) return;
    // The game's own keys never see what is typed here.
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const code = input.value;
      input.value = '';
      void run(code);
      return;
    }
    const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
    const atEnd = input.selectionStart === input.value.length;
    if (e.key === 'ArrowUp' && atStart && history.length) {
      e.preventDefault();
      cursor = cursor < 0 ? history.length - 1 : Math.max(0, cursor - 1);
      input.value = history[cursor]!;
    } else if (e.key === 'ArrowDown' && atEnd && cursor >= 0) {
      e.preventDefault();
      cursor = cursor + 1 >= history.length ? -1 : cursor + 1;
      input.value = cursor < 0 ? '' : history[cursor]!;
    }
  };

  return {
    id: 'console',
    title: 'Console',
    mount(host) {
      const help = el('p', 'lab-muted', 'Variáveis: $sel (seleção), $obj (objeto 3D), $mat (1º material), $scene, $gl, lab (contexto do laboratório), $inspect(obj), $find(texto), $_ (último resultado); e as sondas da página (__roadcraft, __labOpt, __labGpu, __labInspector…). Enter executa, Shift+Enter quebra a linha, ↑/↓ histórico; use await à vontade.');
      const snippets = el('div', 'lab-row');
      snippets.appendChild(el('span', 'lab-muted', 'Trechos:'));
      for (const [name, code] of SNIPPETS) {
        snippets.appendChild(button('', name, 'Executar este trecho (fica no campo para editar)', () => { if (input) input.value = code; void run(code); }));
      }
      output = el('div', 'insp-console-out');
      for (const entry of entries) show(entry);
      input = el('textarea', 'insp-console-in');
      input.rows = 3;
      input.spellcheck = false;
      input.placeholder = '$obj.material.color.set("#ff0000")';
      input.addEventListener('keydown', onKey);
      const bar = el('div', 'lab-row');
      bar.append(
        button('play', 'Executar', 'Executa (Enter)', () => { if (!input) return; const code = input.value; input.value = ''; void run(code); }),
        button('close', 'Limpar saída', 'Apaga a saída', () => { entries.length = 0; output?.replaceChildren(); }),
      );
      host.append(help, snippets, output, input, bar);
      input.focus();
    },
    unmount() {
      output = null;
      input = null;
    },
    focus(params) {
      if (params['code'] && input) input.value = params['code'];
    },
  };
}

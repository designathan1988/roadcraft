import { OPT_SYSTEM_TITLES, affectsTarget, type OptSystem, type OptTarget, type OptValue } from '@render/optimizations';
import type { OptimizationState } from '../../effectsWiring';
import { icon } from '../icons';
import type { LabContext, LabTab } from '../labTypes';
import './optimizations.css';

/** THE LAB'S OPTIMISATIONS (`render/optimizations.ts`): every optimisation the game does not make and every field of the tier's settings, grouped by system, each set alone and live to measure what it gains; "Reset to default" puts the game back as it draws. Each change is an event (`opt.<id>`) the recorder marks, the ones set go into every report (`optimizations`), and the tests and the object inspector reach them through `window.__labOpt`. */

/** An optimisation as the tests, the inspector and the reports read it: plain JSON. */
interface OptRow {
  readonly id: string;
  readonly system: OptSystem;
  readonly title: string;
  readonly value: OptValue;
  readonly default: OptValue;
  readonly choices: readonly OptValue[];
  /** Any number in it too (a tier's field). */
  readonly range: { readonly min: number; readonly max: number; readonly step: number } | null;
  /** What it changes (`OptimizationSpec.affects`): `all`, `shadows`, `post`, `textures`, `layer:<layer>`, `pass:<pass>`, `name:<glob>`. */
  readonly affects: readonly string[];
}

const rowOf = (state: OptimizationState): OptRow => ({
  id: state.spec.id,
  system: state.spec.system,
  title: state.spec.title,
  value: state.value,
  default: state.spec.choices[0]!.value,
  choices: state.spec.choices.map((c) => c.value),
  range: state.spec.range ?? null,
  affects: state.spec.affects,
});

export function createOptimizationTabs(ctx: LabContext): LabTab[] {
  const control = ctx.effects.optimizations;
  control.onChange((id, value) => ctx.emit(`opt.${id}`, `${id} = ${String(value)}`, { id, value }));
  ctx.reportSection('optimizations', () => ({
    active: control.list().filter((s) => !s.isDefault).map(rowOf),
    renderer: ctx.scene.optimizationReport(),
  }));
  // For the tests, the object inspector and an AI driving the game: each optimisation listed, read, set, all put back; those that change a thing.
  (window as unknown as { __labOpt: unknown }).__labOpt = {
    list: (): OptRow[] => control.list().map(rowOf),
    get: (id: string): OptValue | undefined => control.get(id),
    set: (id: string, value: unknown): boolean => control.set(id, value),
    reset: (): void => control.reset(),
    /** The options that change `target` (its layer, pass, names); with `withAll`, those that change everything too. */
    affecting: (target: OptTarget, withAll = false): OptRow[] => control.list().filter((s) => affectsTarget(s.spec, target, withAll)).map(rowOf),
  };

  let host: HTMLElement | null = null;
  let list: HTMLElement | null = null;
  let summary: HTMLElement | null = null;
  let search: HTMLInputElement | null = null;
  const filter = { text: '', system: '' as OptSystem | '', changedOnly: false, tag: '' };
  /** The option asked for (`focus`): highlighted once drawn. */
  let focused = '';
  /** The values as last drawn: drawn again when one was set elsewhere (the tests, the switches' `setMany`). */
  let drawnKey = '';
  const keyOf = (): string => control.list().map((s) => String(s.value)).join('|');

  const drawList = (): void => {
    if (!list || !summary) return;
    drawnKey = keyOf();
    const states = control.list();
    const active = states.filter((s) => !s.isDefault);
    summary.textContent = active.length ? `${active.length} active: ${active.map((s) => s.spec.title).join(', ')}` : 'None active: the game as it draws today.';
    const text = filter.text.trim().toLowerCase();
    const shown = states.filter((s) => (!filter.system || s.spec.system === filter.system) && (!filter.changedOnly || !s.isDefault)
      && (!filter.tag || s.spec.affects.includes(filter.tag))
      && (!text || `${s.spec.title} ${s.spec.what} ${s.spec.tradeoff} ${s.spec.id} ${OPT_SYSTEM_TITLES[s.spec.system]} ${s.spec.affects.join(' ')}`.toLowerCase().includes(text)));
    const sections: HTMLElement[] = [];
    for (const system of Object.keys(OPT_SYSTEM_TITLES) as OptSystem[]) {
      const of = shown.filter((s) => s.spec.system === system);
      if (!of.length) continue;
      const h = document.createElement('h3');
      h.textContent = `${OPT_SYSTEM_TITLES[system]} (${of.length})`;
      sections.push(h);
      for (const state of of) sections.push(rowElement(state));
    }
    if (!sections.length) {
      const none = document.createElement('p');
      none.className = 'lab-muted';
      none.textContent = 'No optimisation matches this filter.';
      sections.push(none);
    }
    list.replaceChildren(...sections);
    if (focused) {
      const row = list.querySelector<HTMLElement>(`[data-opt="${CSS.escape(focused)}"]`);
      row?.classList.add('opt-focus');
      row?.scrollIntoView({ block: 'center' });
    }
  };

  const set = (id: string, value: unknown): void => { control.set(id, value); drawList(); };

  const rowElement = (state: OptimizationState): HTMLElement => {
    const { spec } = state;
    const row = document.createElement('div');
    row.className = `lab-card opt-item${state.isDefault ? '' : ' opt-on'}`;
    row.dataset['opt'] = spec.id;
    const head = document.createElement('div');
    head.className = 'opt-head';
    const title = document.createElement('strong');
    title.textContent = spec.title;
    title.title = spec.id;
    const badge = document.createElement('span');
    badge.className = `opt-badge ${state.isDefault ? 'lab-muted' : 'lab-warn'}`;
    badge.textContent = state.isDefault ? 'default' : 'changed';
    const choices = document.createElement('div');
    choices.className = 'opt-choices';
    for (const choice of spec.choices) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = choice.label;
      const on = choice.value === state.value;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
      b.onclick = () => set(spec.id, choice.value);
      choices.appendChild(b);
    }
    if (spec.range) {
      // Any number in its range: a slider, and a field for an exact value.
      const { min, max, step } = spec.range;
      const shown = typeof state.value === 'number' ? state.value : null;
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(min); slider.max = String(max); slider.step = String(step);
      slider.value = String(shown ?? min);
      slider.className = 'opt-slider';
      const field = document.createElement('input');
      field.type = 'number';
      field.min = String(min); field.max = String(max); field.step = 'any';
      field.value = shown === null ? '' : String(shown);
      field.placeholder = 'value';
      field.className = 'opt-number';
      slider.oninput = () => { field.value = slider.value; };
      slider.onchange = () => set(spec.id, Number(slider.value));
      field.onchange = () => { if (field.value.trim() !== '') set(spec.id, Number(field.value)); };
      choices.append(slider, field);
    }
    head.append(title, badge, choices);
    const what = document.createElement('p');
    what.className = 'opt-what';
    what.textContent = spec.what;
    const tradeoff = document.createElement('p');
    tradeoff.className = 'opt-tradeoff lab-muted';
    tradeoff.textContent = `Expected gain and cost: ${spec.tradeoff}`;
    const affects = document.createElement('div');
    affects.className = 'opt-affects';
    for (const tag of spec.affects) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `opt-tag${filter.tag === tag ? ' on' : ''}`;
      chip.textContent = tag;
      chip.title = 'Show only the options that affect this';
      chip.onclick = () => { filter.tag = filter.tag === tag ? '' : tag; drawList(); };
      affects.appendChild(chip);
    }
    row.append(head, what, tradeoff, affects);
    return row;
  };

  const tab: LabTab = {
    id: 'optimizations',
    title: 'Optimisations',
    mount(next) {
      host = next;
      const bar = document.createElement('div');
      bar.className = 'lab-table-bar';
      search = document.createElement('input');
      search.type = 'search';
      search.placeholder = 'Filter…';
      search.value = filter.text;
      const input = search;
      input.oninput = () => { filter.text = input.value; focused = ''; drawList(); };
      const system = document.createElement('select');
      system.append(new Option('All systems', ''), ...(Object.keys(OPT_SYSTEM_TITLES) as OptSystem[]).map((s) => new Option(OPT_SYSTEM_TITLES[s], s)));
      system.value = filter.system;
      system.onchange = () => { filter.system = system.value as OptSystem | ''; drawList(); };
      const changed = document.createElement('label');
      const changedBox = document.createElement('input');
      changedBox.type = 'checkbox';
      changedBox.checked = filter.changedOnly;
      changedBox.onchange = () => { filter.changedOnly = changedBox.checked; drawList(); };
      changed.append(changedBox, ' changed only');
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.append(icon('refresh'), 'Reset to default');
      reset.title = 'Every optimisation back to the game as it draws today';
      reset.onclick = () => { control.reset(); drawList(); };
      bar.append(search, system, changed, reset);
      const note = document.createElement('p');
      note.className = 'lab-muted';
      note.textContent = 'What the game does not do today and every field of the graphics tier, one at a time: change it, measure (Recorder, GPU), go back. The first value of each is the game as it is. Every change is marked in the recordings (opt.<id>). The tags say what each one affects: click to filter.';
      summary = document.createElement('p');
      summary.className = 'opt-summary';
      list = document.createElement('div');
      list.className = 'opt-list';
      host.append(bar, note, summary, list);
      drawList();
    },
    focus(params) {
      // `{ id }`: that option shown and lit; `{ filter }`: the list filtered by text; `{ affects }`: by what it changes.
      if (params['id']) { focused = params['id']; filter.text = ''; filter.system = ''; filter.changedOnly = false; filter.tag = ''; }
      if (params['filter'] !== undefined) { filter.text = params['filter']; focused = params['id'] ?? ''; }
      if (params['affects'] !== undefined) filter.tag = params['affects'];
      if (search) search.value = filter.text;
      drawList();
    },
    refresh() {
      if (host && keyOf() !== drawnKey) drawList();
    },
    unmount() {
      host = null;
      list = null;
      summary = null;
      search = null;
    },
  };
  return [tab];
}

import { type Blueprint } from '@world/buildings/blueprints';
import { type Finish } from '@world/buildings/materials';
import {
  type BuilderCategoryId,
  type BuilderSelectionInfo,
  tabSpec,
} from './catalog';
import { applyTranslations, formatDecimal, language, onLanguageChange, parseDecimal, t } from '../i18n';
import { builderIconSvg } from './icons';
import './workspace.css';

/** The Builder's side of the interface: its state */

type ChromeMode = 'road' | 'builder';

export interface BuilderState {
  readonly category: BuilderCategoryId;
  /** The active tool id (may be an action that ran once). */
  readonly tool: string;
  /** The free part the tool has armed, if any. */
  readonly armed: string | null;
  /** Tool ids that are implemented and clickable right now. */
  readonly ready: ReadonlySet<string>;
  readonly floor: { readonly active: number; readonly total: number };
  readonly snap: string;
  readonly grid: boolean;
  readonly hideOthers: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly inspectorOpen: boolean;
  /** True while a gesture is running. */
  readonly busy: boolean;
  readonly selection: BuilderSelectionInfo | null;
  /** One sentence on what the pointer does now. */
  readonly hint: string;
  /** A plan is being drawn: the panel carries Finish, Back and Cancel. */
  readonly planning: boolean;
  readonly planPoints: number;
  readonly userBlueprints: readonly Blueprint[];
  /** The facade pattern of the selected mass, and where a pattern applies. */
  readonly pattern: string | null;
  readonly scope: string;
  /** The selected mass's roof, for the slope controls. */
  readonly roof: { readonly pitch: number; readonly ridge: 'x' | 'y'; readonly fall: number; readonly pitched: boolean } | null;
  /** The material the finish tools would paint now. */
  readonly material: { readonly finish: Finish; readonly colour: number } | null;
  /** What a drawn shape does now. */
  readonly drawAction: string;
}

export interface BuilderActions {
  /** Asks for pictures of the parts a tab is about to show (they arrive a few per frame). */
  requestThumbnails(ids: readonly string[]): void;
  undo(): void;
  redo(): void;
  setCategory(id: BuilderCategoryId): void;
  chooseTool(id: string): void;
  setFloor(n: number): void;
  floorCommand(command: 'insertAbove' | 'insertBelow'): void;
  setSnap(mode: string): void;
  toggleGrid(): void;
  toggleHideOthers(): void;
  toggleInspector(): void;
  selectionAction(name: 'duplicate' | 'mirror' | 'group' | 'save' | 'delete'): void;
  setField(id: string, value: number): void;
  choosePreset(key: string): void;
  chooseUserBlueprint(key: string): void;
  removeUserBlueprint(key: string): void;
  chooseFinish(finish: Finish): void;
  chooseColour(colour: number): void;
  chooseStyle(key: string): void;
  choosePattern(pattern: string): void;
  setScope(scope: string): void;
  setDrawAction(action: string): void;
  planFinish(): void;
  planBack(): void;
  planCancel(): void;
  roofPitch(delta: number): void;
  roofRidge(ridge: 'x' | 'y'): void;
  roofFall(side: number): void;
  /** A view command: frame | top | turnLeft | turnRight. */
  view(id: string): void;
  /** "See inside" for the whole city: toggled, or its floor moved; returns where it stands. */
  seeInside(command: 'toggle' | 'up' | 'down'): { readonly on: boolean; readonly level: number };
}

export interface BuilderWorkspace {
  refresh(state: BuilderState): void;
  /** Shows the see-inside control as it now is (opened by a click on the map). */
  showInside(state: { on: boolean; level: number }): void;
  /** See inside as it is now, and each change of it (a building opened by a click on the map too). */
  inside(): { readonly on: boolean; readonly level: number };
  onInside(listen: (state: { readonly on: boolean; readonly level: number }) => void): void;
  /** Which half of the game the container is driving. */
  setMode(mode: ChromeMode): void;
  /** Opens a tab. */
  showGallery(category: BuilderCategoryId, gallery?: string): void;
  relabel(): void;
  setPresetThumbnails(images: ReadonlyMap<string, string>): void;
  readonly root: HTMLElement;
  /** Interface v2 drives the Builder with the same commands, from its own panels. */
  readonly actions: BuilderActions;
  subscribe(listen: (state: BuilderState) => void): void;
  thumbnail(id: string): string | undefined;
}

export const SNAP_MODES = ['auto', 'grid', 'edge', 'face', 'centre', 'building', 'road', 'off'] as const;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, html?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
};

export function initBuilderWorkspace(actions: BuilderActions): BuilderWorkspace {
  const root = document.getElementById('builder') as HTMLElement;

  // ------------------------------------------------------------ the selection The numbers of what is selected
  const inspector = el('aside', 'bw-inspector');
  inspector.hidden = true;
  const inspectorHead = el('div', 'bw-inspector-head');
  const inspectorTitle = el('span', 'bw-inspector-title');
  const inspectorToggle = el('button', 'bw-icon-button bw-collapse');
  inspectorToggle.type = 'button';
  inspectorToggle.dataset['i18nTitle'] = 'builder.inspector.toggle';
  inspectorToggle.onclick = () => actions.toggleInspector();
  inspectorHead.append(inspectorTitle, inspectorToggle);
  const inspectorActions = el('div', 'bw-inspector-actions');
  const actionButtons = new Map<string, HTMLButtonElement>();
  for (const [name, icon] of [
    ['duplicate', 'duplicate'],
    ['mirror', 'mirror'],
    ['group', 'group'],
    ['save', 'models'],
    ['delete', 'trash'],
  ] as const) {
    const b = el('button', 'bw-icon-button bw-action' + (name === 'delete' ? ' danger' : ''));
    b.type = 'button';
    b.dataset['selectionAction'] = name;
    b.innerHTML = builderIconSvg(icon, 16);
    b.onclick = () => actions.selectionAction(name);
    inspectorActions.appendChild(b);
    actionButtons.set(name, b);
  }
  const inspectorBody = el('div', 'bw-inspector-body');
  inspector.append(inspectorHead, inspectorActions, inspectorBody);

  root.append(inspector);
  // Built after the language was applied: translate its own titles now, and again whenever the language changes.
  applyTranslations(root);
  onLanguageChange(() => applyTranslations(root));

  // ------------------------------------------------------------ state
  let mode: ChromeMode = 'road';
  let lastState: BuilderState | null = null;
  const thumbnails = new Map<string, string>();
  // See inside, as the wiring last told it (`showInside`).
  let insideNow = { on: false, level: 0 };
  const insideListeners: ((state: { readonly on: boolean; readonly level: number }) => void)[] = [];

  // ------------------------------------------------------------ inspector
  /** The language the quick buttons' titles were last written in (`renderInspector`). */
  let titledIn: string | null = null;
  function renderInspector(state: BuilderState): void {
    const info = state.selection;
    inspector.hidden = info === null || mode !== 'builder';
    inspector.classList.toggle('collapsed', !state.inspectorOpen);
    // DO NOT write the DOM each render (each move of the pointer in the builder): the toggle's icon when it flips, the buttons' titles when the language changes.
    if (inspectorToggle.dataset['open'] !== String(state.inspectorOpen)) {
      inspectorToggle.dataset['open'] = String(state.inspectorOpen);
      inspectorToggle.innerHTML = builderIconSvg(state.inspectorOpen ? 'collapse' : 'expand', 14);
    }
    if (titledIn !== language()) {
      titledIn = language();
      for (const [name, b] of actionButtons) {
        const key = `builder.quick.${name}`;
        b.title = t(key);
        b.setAttribute('aria-label', t(key));
      }
    }
    if (!state.inspectorOpen || !info) return;
    const signature = `${info.titleKey}|${info.name}|${info.material ?? ''}|${info.fields.map((f) => `${f.id}:${f.text ?? f.value}`).join(',')}`;
    if (inspectorBody.dataset['signature'] === signature) return;
    const focused = document.activeElement;
    // What is being typed, read before the redraw: removing the field fires its blur, which writes the value out in full.
    const typed = focused instanceof HTMLInputElement && focused.dataset['field'] ? { id: focused.dataset['field'], text: focused.value } : null;
    inspectorBody.dataset['signature'] = signature;
    inspectorBody.innerHTML = '';
    inspectorTitle.textContent = t(info.titleKey);
    const name = el('div', 'bw-inspector-name');
    name.textContent = info.name;
    inspectorBody.appendChild(name);
    for (const field of info.fields) {
      const row = el('label', 'bw-field');
      const label = el('span', 'bw-field-label');
      label.textContent = t(field.labelKey);
      row.appendChild(label);
      if (field.text !== undefined) {
        const value = el('span', 'bw-field-text');
        value.textContent = field.text;
        row.appendChild(value);
        inspectorBody.appendChild(row);
        continue;
      }
      if (field.options) {
        const select = el('select', 'bw-field-input bw-field-select');
        select.dataset['field'] = field.id;
        for (const option of field.options) {
          const o = el('option');
          o.value = String(option.value);
          o.textContent = t(option.labelKey);
          o.selected = option.value === field.value;
          select.appendChild(o);
        }
        select.onchange = () => actions.setField(field.id, Number(select.value));
        row.appendChild(select);
        inspectorBody.appendChild(row);
        continue;
      }
      // A text field, not `type=number`
      const input = el('input', 'bw-field-input');
      input.type = 'text';
      input.inputMode = field.unit === 'count' ? 'numeric' : 'decimal';
      input.autocomplete = 'off';
      input.spellcheck = false;
      const step = field.step ?? (field.unit === 'count' ? 1 : 0.05);
      const shown = (v: number): string => (field.unit === 'count' ? String(Math.round(v)) : formatDecimal(v, 2));
      const clamp = (v: number): number => Math.min(field.max ?? Infinity, Math.max(field.min ?? -Infinity, v));
      // The field being typed in keeps what was typed through the redraw each change causes
      input.value = typed?.id === field.id ? typed.text : shown(field.value);
      input.dataset['field'] = field.id;
      // Live: every key, arrow step or wheel step shows on the building at once, not only when the field is left.
      const nudge = (sign: number): void => {
        const now = parseDecimal(input.value);
        const next = clamp(Math.round(((Number.isFinite(now) ? now : field.value) + sign * step) / step) * step);
        input.value = shown(next);
        actions.setField(field.id, next);
      };
      input.oninput = () => {
        const n = parseDecimal(input.value);
        if (Number.isFinite(n)) actions.setField(field.id, clamp(n));
      };
      input.onblur = () => {
        const n = parseDecimal(input.value);
        input.value = shown(Number.isFinite(n) ? clamp(n) : field.value);
      };
      input.onwheel = (e) => {
        if (document.activeElement !== input) return;
        e.preventDefault();
        nudge(e.deltaY < 0 ? 1 : -1);
      };
      input.onkeydown = (e) => {
        if (e.key === 'Enter') input.blur();
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          nudge(e.key === 'ArrowUp' ? 1 : -1);
        }
        e.stopPropagation();
      };
      row.appendChild(input);
      const unit = el('span', 'bw-field-unit');
      unit.textContent = field.unit === 'deg' ? '°' : field.unit === 'm' ? 'm' : field.unit === 'percent' ? '%' : '';
      row.appendChild(unit);
      inspectorBody.appendChild(row);
    }
    if (info.material !== undefined) {
      const materialRow = el('div', 'bw-field bw-field-material');
      const label = el('span', 'bw-field-label');
      label.textContent = t('builder.field.material');
      const value = el('span', 'bw-field-text');
      value.textContent = info.material;
      materialRow.append(label, value);
      inspectorBody.appendChild(materialRow);
    }
    if (focused instanceof HTMLInputElement && focused.dataset['field']) {
      const again = inspectorBody.querySelector<HTMLInputElement>(`[data-field="${focused.dataset['field']}"]`);
      if (again) {
        again.focus();
        // The caret where the typing was: at the end of what was typed.
        again.setSelectionRange(again.value.length, again.value.length);
      }
    }
  }

  const listeners: ((state: BuilderState) => void)[] = [];
  const refresh = (state: BuilderState): void => {
    lastState = state;
    for (const listen of listeners) listen(state);
    root.dataset['category'] = state.category;
    root.dataset['selection'] = state.selection === null ? 'none' : 'some';
    // A tab that needs a building gives way when the selection goes.
    if (state.selection === null && !state.planning && tabSpec(state.category).needsSelection && !state.armed) {
      actions.setCategory('models');
      return;
    }
    renderInspector(state);
  };

  return {
    refresh,
    showInside(s) {
      insideNow = { on: s.on, level: s.level };
      for (const listen of insideListeners) listen(insideNow);
    },
    inside: () => insideNow,
    onInside(listen) {
      insideListeners.push(listen);
    },
    setMode(next) {
      mode = next;
      root.dataset['mode'] = next;
      // The selection panel belongs to Construction: it stayed on screen over the road tools.
      if (next !== 'builder') inspector.hidden = true;
      else if (lastState) renderInspector(lastState);
    },
    showGallery(category) {
      actions.setCategory(category);
    },
    relabel() {
      inspectorBody.dataset['signature'] = '';
      if (lastState) refresh(lastState);
    },
    root,
    setPresetThumbnails(images) {
      for (const [key, url] of images) thumbnails.set(key, url);
      if (lastState) for (const listen of listeners) listen(lastState);
    },
    actions,
    subscribe(listen) {
      listeners.push(listen);
      if (lastState) listen(lastState);
    },
    thumbnail: (id) => thumbnails.get(id),
  };
}

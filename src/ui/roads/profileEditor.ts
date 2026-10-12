import { CENTRE_LINES, type CentreLine } from '@world/roadSection';
import { PARKING_DEPTH } from '@world/parking';
import {
  CARRIAGEWAY_MATERIALS, type CarriagewayMaterial, FOOTWAY_MATERIALS, type FootwayMaterial, MEDIAN_MATERIALS,
  type MedianMaterial, ROAD_SECTION_LIMITS,
} from '@world/roadSection';
import { ROAD_TYPES } from '@world/roadTypes';
import { type ProfileElement, type ProfileIssue, type RoadProfileSpec, profileIssues, profileWidth } from '@world/roads/profile';
import { type RoadTemplate, classTemplates } from '@world/roads/templates';
import { METERS_PER_UNIT, UNITS_PER_METER } from '@world/units';
import { t } from '../i18n';
import { roadTypeName } from '../labels';
import { drawSection, elementColour, metresText } from './crossSection';
import { deleteTemplate, saveTemplate, savedTemplates } from './templates';
import './roads.css';

/**
 * THE PROFILE EDITOR (docs/VIAS.md V2): the road's cross-section drawn as a
 * street section (`crossSection.ts`), edited the way Streetmix edits a street
 * and Road Builder for Cities: Skylines II builds a road in one panel -
 * templates as cards with the section in miniature, elements added from an
 * icon palette (each put where the road can carry it: a lane beside the
 * lanes of its direction, a parking bay by the kerb), a boundary dragged to
 * change a width, an element dragged to change the order, and the picked
 * element's properties in one block of the interface's own controls
 * (stepper, segmented buttons, switch). Every problem the game cannot build
 * is named in the block of the element that has it (`profileIssues`), with a
 * badge on the element in the picture, and the apply is held back until
 * there is none.
 *
 * While a width or an order is dragged only the picture is redrawn (one SVG
 * string into one container); the panel round it is rebuilt on a discrete
 * change only. The time of each redraw is kept on the stage
 * (`data-redraw-ms`, `data-redraw-max`) for the probes.
 */
export interface ProfileEditorOptions {
  /** What is being edited ("this road", "new roads"). */
  readonly title: string;
  readonly profile: RoadProfileSpec;
  readonly type: number;
  /** Applies the profile to the road being edited; absent when there is none. */
  readonly apply?: (profile: RoadProfileSpec, type: number) => void;
  /** Makes the profile the one new roads are drawn with. */
  readonly drawWith?: (name: string, profile: RoadProfileSpec, type: number) => void;
  /**
   * Docked above the road tool's drawer (the catalogue's "Customise..."),
   * never over it: compact, and folding to its head (the player's order of
   * 2026-10-09).
   */
  readonly docked?: boolean;
  /** Told when a template was saved (the catalogue shows it under "My roads"). */
  readonly onSaved?: () => void;
}

type PaletteKind = 'footway' | 'laneBackward' | 'laneForward' | 'median' | 'parking' | 'cycle';
const PALETTE: readonly PaletteKind[] = ['footway', 'laneBackward', 'laneForward', 'median', 'parking', 'cycle'];

/** Limits of each element's width, whole metres; null for a fixed width. */
const WIDTH_LIMITS: Readonly<Record<ProfileElement['kind'], readonly [number, number] | null>> = {
  footway: [ROAD_SECTION_LIMITS.sidewalk[0] * METERS_PER_UNIT, ROAD_SECTION_LIMITS.sidewalk[1] * METERS_PER_UNIT],
  lane: [ROAD_SECTION_LIMITS.laneWidth[0] * METERS_PER_UNIT, ROAD_SECTION_LIMITS.laneWidth[1] * METERS_PER_UNIT],
  median: [1, ROAD_SECTION_LIMITS.median[1] * METERS_PER_UNIT],
  parking: null,
  cycle: null,
};

const ICON: Record<string, string> = {
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  left: '<path d="M14 6l-6 6 6 6"/>',
  right: '<path d="M10 6l6 6-6 6"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
  ok: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  pencil: '<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>',
  apply: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  footway: '<circle cx="12" cy="4.5" r="1.8"/><path d="M12 7.5v6l-3 7M12 13.5l3 7M8.5 10.5l3.5-3 3.5 3"/>',
  laneForward: '<path d="M3 19h18" opacity=".5"/><path d="M4 11h14M14 6l5 5-5 5"/>',
  laneBackward: '<path d="M3 19h18" opacity=".5"/><path d="M20 11H6M10 6l-5 5 5 5"/>',
  median: '<circle cx="12" cy="8" r="5"/><path d="M12 13v6M5 20h14"/>',
  parking: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M10 16V8h3a2.5 2.5 0 010 5h-3"/>',
  cycle: '<circle cx="6" cy="16" r="3.5"/><circle cx="18" cy="16" r="3.5"/><path d="M6 16l4-7h5l3 7M10 9l3 7h-3M13 6h3"/>',
  blank: '<rect x="4" y="5" width="16" height="14" rx="2" stroke-dasharray="3 3"/>',
  fold: '<path d="M6 15l6-6 6 6"/>',
};
const icon = (name: string): string =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[name] ?? ''}</svg>`;

/** A new element of each kind, as the palette adds it; a lane as wide as the road's others. */
function newElement(kind: PaletteKind, profile: RoadProfileSpec): ProfileElement {
  const laneWidth = profile.elements.find((e) => e.kind === 'lane')?.width ?? 3 * UNITS_PER_METER;
  switch (kind) {
    case 'footway': return { kind: 'footway', width: 2 * UNITS_PER_METER };
    case 'laneForward': return { kind: 'lane', width: laneWidth, dir: 'forward' };
    case 'laneBackward': return { kind: 'lane', width: laneWidth, dir: 'backward' };
    case 'median': return { kind: 'median', width: 2 * UNITS_PER_METER };
    case 'parking': return { kind: 'parking', width: PARKING_DEPTH.parallel };
    case 'cycle': return { kind: 'cycle', width: PARKING_DEPTH.cycle };
  }
}

/**
 * Where the palette puts a new element: where the road can carry it (the
 * order `profileIssues` asks for), next to the picked element when that is
 * one of the right places.
 */
export function insertionIndex(profile: RoadProfileSpec, kind: PaletteKind, selected: number): number {
  const e = profile.elements;
  const n = e.length;
  const hasLeft = e[0]?.kind === 'footway';
  const hasRight = n > 1 && e[n - 1]?.kind === 'footway';
  const lo = hasLeft ? 1 : 0, hi = hasRight ? n - 1 : n;
  const clamp = (i: number): number => Math.max(lo, Math.min(hi, i));
  const lastIndex = (test: (x: ProfileElement) => boolean): number => {
    for (let i = n - 1; i >= 0; i--) if (test(e[i]!)) return i;
    return -1;
  };
  const firstIndex = (test: (x: ProfileElement) => boolean): number => e.findIndex(test);
  const kerbBand = (x: ProfileElement | undefined): boolean => x?.kind === 'parking' || x?.kind === 'cycle';
  const lastBack = lastIndex((x) => x.kind === 'lane' && x.dir === 'backward');
  const lastFwd = lastIndex((x) => x.kind === 'lane' && x.dir === 'forward');
  switch (kind) {
    case 'footway':
      if (!hasLeft) return 0;
      if (!hasRight) return n;
      return clamp(selected + 1);
    case 'laneBackward': {
      if (lastBack >= 0) return lastBack + 1;
      const core = firstIndex((x) => x.kind === 'median' || (x.kind === 'lane' && x.dir === 'forward'));
      if (core >= 0) return core;
      return clamp(kerbBand(e[lo]) ? lo + 1 : lo);
    }
    case 'laneForward': {
      if (lastFwd >= 0) return lastFwd + 1;
      const median = lastIndex((x) => x.kind === 'median');
      if (median >= 0) return median + 1;
      if (lastBack >= 0) return lastBack + 1;
      return clamp(kerbBand(e[hi - 1]) ? hi - 1 : hi);
    }
    case 'median':
      return lastBack >= 0 ? lastBack + 1 : clamp(selected + 1);
    case 'parking':
    case 'cycle': {
      // By the kerb nearest the picked element; the other kerb when that one has its band already.
      const leftFree = !kerbBand(e[lo]), rightFree = !kerbBand(e[hi - 1]);
      const nearLeft = selected >= 0 && selected < n / 2;
      if (nearLeft) return leftFree || !rightFree ? lo : hi;
      return rightFree || !leftFree ? hi : lo;
    }
  }
}

/**
 * The element at `index` made `metres` wide. A lane takes every lane with it:
 * the engine lays the lanes of a road at one width (`profileIssues`
 * 'laneWidths'), so the width of one is the width of all.
 */
export function withWidth(profile: RoadProfileSpec, index: number, metres: number): RoadProfileSpec {
  const target = profile.elements[index];
  if (!target) return profile;
  const width = metres * UNITS_PER_METER;
  return {
    ...profile,
    elements: profile.elements.map((e, i) => (i === index || (target.kind === 'lane' && e.kind === 'lane') ? { ...e, width } : e)),
  };
}

/** The elements with the one at `from` moved to `to`. */
export function moved(profile: RoadProfileSpec, from: number, to: number): RoadProfileSpec {
  if (from === to) return profile;
  const elements = [...profile.elements];
  const [x] = elements.splice(from, 1);
  elements.splice(to, 0, x!);
  return { ...profile, elements };
}

let openEditor: { root: HTMLElement; dispose: () => void } | null = null;

/** Closes the editor if it is open. */
export function closeProfileEditor(): void {
  openEditor?.dispose();
  openEditor?.root.remove();
  openEditor = null;
}

/** Whether the editor is open (the shell keeps its tool while it is). */
export const profileEditorOpen = (): boolean => openEditor !== null;

interface EdgeDrag {
  readonly kind: 'edge';
  readonly pointer: number;
  readonly startX: number;
  readonly start: RoadProfileSpec;
  readonly target: number;
  readonly anchor: 'left' | 'right';
  readonly scale: number;
  readonly startMetres: number;
  readonly count: number;
  readonly limits: readonly [number, number];
}

interface MoveDrag {
  readonly kind: 'move';
  readonly pointer: number;
  readonly startX: number;
  readonly start: RoadProfileSpec;
  readonly from: number;
  readonly centres: readonly number[];
  moving: boolean;
  to: number;
}

export function openProfileEditor(options: ProfileEditorOptions): void {
  closeProfileEditor();
  let profile: RoadProfileSpec = { ...options.profile, elements: [...options.profile.elements] };
  let type = options.type;
  // Every road has a footway at each edge, so the first useful pick is the lanes.
  let selected = Math.min(1, profile.elements.length - 1);
  let saving = false;
  let status = '';
  let drag: EdgeDrag | MoveDrag | null = null;
  let redrawMax = 0;

  const root = document.createElement('section');
  root.className = options.docked ? 'rp-panel docked' : 'rp-panel';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', t('profileEditor.title'));

  // ---- the parts, made once; each is refilled on its own
  const head = div('rp-head');
  const titleBox = document.createElement('div');
  titleBox.innerHTML = `<div class="rp-title"></div><div class="rp-sub"></div>`;
  titleBox.querySelector('.rp-title')!.textContent = t('profileEditor.title');
  titleBox.querySelector('.rp-sub')!.textContent = t('profileEditor.sub', { target: options.title });
  const chip = div('rp-chip');
  const close = iconButton('close', t('profileEditor.close'), closeProfileEditor);
  // Docked: it folds to its head, so the map and the drawer stay in view.
  const fold = iconButton('fold', t('profileEditor.fold'), () => {
    root.classList.toggle('folded');
    fold.setAttribute('aria-expanded', String(!root.classList.contains('folded')));
    place();
  });
  fold.dataset['action'] = 'fold';

  const cards = div('rp-cards');
  cards.setAttribute('aria-label', t('profileEditor.templates'));

  const stage = div('rp-stage');
  stage.setAttribute('aria-label', t('profileEditor.bands'));
  const picture = div('rp-picture');
  const endLeft = div('rp-end rp-end-l');
  endLeft.textContent = t('profileEditor.leftEnd');
  const endRight = div('rp-end rp-end-r');
  endRight.textContent = t('profileEditor.rightEnd');
  stage.append(picture, endLeft, endRight);

  const palette = div('rp-palette');
  const addLabel = div('rp-label');
  addLabel.textContent = t('profileEditor.add');
  palette.append(addLabel);
  for (const kind of PALETTE) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rp-tool';
    b.dataset['palette'] = kind;
    b.innerHTML = `${icon(kind)}<span></span>`;
    b.querySelector('span')!.textContent = t(`profileEditor.palette.${kind}`);
    b.onclick = () => {
      const at = insertionIndex(profile, kind, selected);
      const elements = [...profile.elements];
      elements.splice(at, 0, newElement(kind, profile));
      profile = { ...profile, elements };
      selected = at;
      status = '';
      renderAll();
    };
    palette.append(b);
  }

  const props = div('rp-props');
  const foot = div('rp-foot');
  const nameField = document.createElement('input');
  nameField.type = 'text';
  nameField.className = 'rp-field';
  nameField.maxLength = 40;
  nameField.placeholder = t('profile.templateName');
  nameField.setAttribute('aria-label', t('profile.templateName'));
  nameField.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') save();
    if (event.key === 'Escape') { saving = false; renderFoot(); event.stopPropagation(); }
  });

  // The actions sit in the head, beside the total: the panel stays short enough for a 720-pixel screen.
  head.append(titleBox, chip, foot, ...(options.docked ? [fold] : []), close);
  root.append(head, cards, stage, palette, props);
  // Keys typed here are the editor's, not the game's shortcuts.
  root.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === 'Escape') closeProfileEditor();
    else if (event.key === 'ArrowLeft' && selected > 0) { selected--; renderAll(); }
    else if (event.key === 'ArrowRight' && selected < profile.elements.length - 1) { selected++; renderAll(); }
    else if ((event.key === 'Delete' || event.key === 'Backspace') && profile.elements[selected]) removeSelected();
  });
  document.body.append(root);

  const issues = (): ProfileIssue[] => profileIssues(profile, type);

  // ---- the picture: the only thing redrawn while dragging
  const stageSize = (): { width: number; height: number } => ({
    width: Math.max(320, Math.round(picture.clientWidth || stage.clientWidth || 900)),
    height: options.docked ? 128 : window.innerHeight < 820 ? 160 : 200,
  });
  const drawStage = (extra?: { scale?: number; anchor?: 'left' | 'right'; dragging?: number }): void => {
    const started = performance.now();
    if (!profile.elements.length) {
      picture.innerHTML = `<div class="rp-empty">${icon('blank')}<span></span></div>`;
      picture.querySelector('.rp-empty span')!.textContent = t('profileEditor.empty');
    } else {
      const flagged = new Set(issues().flatMap((issue) => issue.elements));
      const { width, height } = stageSize();
      picture.innerHTML = drawSection(profile, {
        width, height, ...(selected >= 0 ? { selected } : {}), flagged,
        title: t('profile.diagram'), ...extra,
      }).svg;
    }
    chip.textContent = t('profileEditor.totalWidth', { width: metresText(profileWidth(profile)) });
    const ms = performance.now() - started;
    redrawMax = Math.max(redrawMax, ms);
    stage.dataset['redrawMs'] = ms.toFixed(3);
    stage.dataset['redrawMax'] = redrawMax.toFixed(3);
  };

  const svgX = (clientX: number): number => {
    const svg = picture.querySelector('svg');
    if (!svg) return 0;
    const rect = svg.getBoundingClientRect();
    return ((clientX - rect.left) * stageSize().width) / Math.max(1, rect.width);
  };

  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !profile.elements.length) return;
    const target = event.target as Element;
    const { width } = stageSize();
    const fit = drawSection(profile, { width, height: 10, compact: false, labels: false, handles: false });
    const edge = target.closest('[data-edge]');
    if (edge) {
      const i = Number(edge.getAttribute('data-edge'));
      const left = profile.elements[i], right = profile.elements[i + 1];
      if (!left || !right) return;
      // The left element follows the boundary; when its width is fixed, the right one does.
      const pick = WIDTH_LIMITS[left.kind] ? i : WIDTH_LIMITS[right.kind] ? i + 1 : -1;
      if (pick < 0) return;
      const anchor = pick === i ? 'left' : 'right';
      const el = profile.elements[pick]!;
      // A lane carries every lane: the boundary moves by all those on the anchored side.
      const count = el.kind === 'lane'
        ? profile.elements.filter((e, k) => e.kind === 'lane' && (anchor === 'left' ? k <= i : k >= i + 1)).length
        : 1;
      drag = {
        kind: 'edge', pointer: event.pointerId, startX: svgX(event.clientX), start: profile, target: pick, anchor,
        scale: fit.scale, startMetres: el.width * METERS_PER_UNIT, count, limits: WIDTH_LIMITS[el.kind]!,
      };
      selected = pick;
    } else {
      const group = target.closest('[data-index]');
      if (!group) return;
      const from = Number(group.getAttribute('data-index'));
      drag = {
        kind: 'move', pointer: event.pointerId, startX: svgX(event.clientX), start: profile, from,
        centres: fit.spans.map(([a, b]) => (a + b) / 2), moving: false, to: from,
      };
      selected = from;
    }
    // Captured, so a drag that leaves the picture keeps going; a pointer the browser no longer tracks cannot be.
    try { stage.setPointerCapture(event.pointerId); } catch { /* the drag still follows moves over the picture */ }
    stage.classList.add('dragging');
    drawStage(drag.kind === 'edge' ? { scale: drag.scale, anchor: drag.anchor } : undefined);
    event.preventDefault();
  });

  stage.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const dx = svgX(event.clientX) - drag.startX;
    if (drag.kind === 'edge') {
      const ppm = drag.scale / METERS_PER_UNIT;
      const delta = (dx / ppm / drag.count) * (drag.anchor === 'left' ? 1 : -1);
      const metres = Math.max(drag.limits[0], Math.min(drag.limits[1], Math.round(drag.startMetres + delta)));
      const next = withWidth(drag.start, drag.target, metres);
      if (next.elements[drag.target]!.width === profile.elements[drag.target]!.width) return;
      profile = next;
      drawStage({ scale: drag.scale, anchor: drag.anchor });
    } else {
      if (!drag.moving && Math.abs(dx) < 4) return;
      drag.moving = true;
      // The slot under the pointer, among the other elements' centres.
      const x = svgX(event.clientX);
      const to = drag.centres.filter((c, k) => k !== (drag as MoveDrag).from && c < x).length;
      if (to === drag.to && profile !== drag.start) return;
      drag.to = to;
      profile = moved(drag.start, drag.from, to);
      selected = to;
      drawStage({ dragging: to });
    }
  });

  const endDrag = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointer) return;
    drag = null;
    stage.classList.remove('dragging');
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    status = '';
    renderAll();
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  // ---- templates: the classes, the player's own, and a blank road
  const sameAs = (template: RoadTemplate): boolean =>
    template.type === type && JSON.stringify(template.profile) === JSON.stringify(profile);
  const renderCards = (): void => {
    cards.replaceChildren();
    const card = (name: string, on: boolean, art: string, pick: () => void, remove?: () => void, id?: string): void => {
      const box = div(`rp-card${on ? ' on' : ''}`);
      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'rp-card-main';
      main.setAttribute('aria-pressed', String(on));
      if (id) main.dataset['template'] = id;
      main.innerHTML = `<span class="rp-card-art">${art}</span><span class="rp-card-name"></span>`;
      main.querySelector('.rp-card-name')!.textContent = name;
      main.title = name;
      main.onclick = pick;
      box.append(main);
      if (remove) {
        const x = iconButton('close', `${t('profileEditor.deleteTemplate')}: ${name}`, remove);
        x.className = 'rp-card-x';
        box.append(x);
      }
      cards.append(box);
    };
    const templates: RoadTemplate[] = [...classTemplates(), ...savedTemplates()];
    for (const template of templates) {
      const name = template.nameKey ? t(template.nameKey) : template.name ?? template.id;
      card(name, sameAs(template), drawSection(template.profile, { width: 92, height: 34, compact: true }).svg, () => {
        profile = { ...template.profile, elements: [...template.profile.elements] };
        type = template.type;
        selected = Math.min(1, profile.elements.length - 1);
        status = '';
        renderAll();
      }, template.id.startsWith('user:') ? () => { deleteTemplate(template.id); renderCards(); } : undefined, template.id);
    }
    card(t('profileEditor.blank'), profile.elements.length === 0, `<span class="rp-card-blank">${icon('plus')}</span>`, () => {
      profile = { ...profile, elements: [] };
      selected = -1;
      status = '';
      renderAll();
    }, undefined, 'blank');
  };

  // ---- the picked element, and the road as a whole
  const replace = (next: ProfileElement): void => {
    profile = { ...profile, elements: profile.elements.map((e, i) => (i === selected ? next : e)) };
    status = '';
    renderAll();
  };
  const removeSelected = (): void => {
    profile = { ...profile, elements: profile.elements.filter((_, i) => i !== selected) };
    selected = Math.min(selected, profile.elements.length - 1);
    status = '';
    renderAll();
  };
  const moveSelected = (by: -1 | 1): void => {
    const to = selected + by;
    if (to < 0 || to >= profile.elements.length) return;
    profile = moved(profile, selected, to);
    selected = to;
    renderAll();
  };
  const issueLine = (issue: ProfileIssue, link: boolean): HTMLElement => {
    const line = document.createElement(link ? 'button' : 'div');
    line.className = 'rp-issue';
    line.setAttribute('role', link ? 'button' : 'alert');
    line.innerHTML = `${icon('warn')}<span></span>`;
    line.querySelector('span')!.textContent = t(`profile.problem.${issue.problem}`) + (link ? ` ${t('profileEditor.seeIssue')}` : '');
    if (link && line instanceof HTMLButtonElement) {
      line.type = 'button';
      line.onclick = () => { selected = issue.elements[0]!; renderAll(); };
    }
    return line;
  };

  const renderProps = (): void => {
    props.replaceChildren();
    const found = issues();
    const element = profile.elements[selected];
    const block = div('rp-block rp-element');
    if (!element) {
      const hint = div('rp-sub');
      hint.textContent = t('profileEditor.pick');
      block.append(hint);
    } else {
      const top = div('rp-block-head');
      const swatch = document.createElement('span');
      swatch.className = 'rp-swatch';
      swatch.style.background = elementColour(element, profile);
      const name = document.createElement('span');
      name.textContent = element.kind === 'lane'
        ? `${t('profile.element.lane')} · ${t(element.dir === 'forward' ? 'profileEditor.dirForward' : 'profileEditor.dirBackward')}`
        : t(`profile.element.${element.kind}`);
      const actions = div('rp-actions');
      const left = iconButton('left', t('profileEditor.moveLeft'), () => moveSelected(-1));
      left.disabled = selected === 0;
      const right = iconButton('right', t('profileEditor.moveRight'), () => moveSelected(1));
      right.disabled = selected === profile.elements.length - 1;
      const remove = iconButton('trash', t('profileEditor.remove'), removeSelected);
      remove.dataset['action'] = 'remove';
      actions.append(left, right, remove);
      top.append(swatch, name, actions);
      block.append(top);

      const limits = WIDTH_LIMITS[element.kind];
      const here = element.width * METERS_PER_UNIT;
      if (limits) {
        const down = Math.abs(here - Math.round(here)) < 1e-6 ? Math.round(here) - 1 : Math.floor(here);
        const up = Math.abs(here - Math.round(here)) < 1e-6 ? Math.round(here) + 1 : Math.ceil(here);
        const note = div('rp-note');
        note.textContent = element.kind === 'lane' ? t('profileEditor.allLanes') : '';
        block.append(row(t('profileEditor.width'),
          stepper(`${metresText(element.width)} m`, down >= limits[0] ? () => { profile = withWidth(profile, selected, down); renderAll(); } : null,
            up <= limits[1] ? () => { profile = withWidth(profile, selected, up); renderAll(); } : null), note));
      } else {
        const fixed = div('rp-sub');
        fixed.textContent = `${metresText(element.width)} m · ${t('profileEditor.fixedWidth')}`;
        block.append(row(t('profileEditor.width'), fixed));
      }
      if (element.kind === 'lane') {
        block.append(row(t('profileEditor.direction'), segmented(['backward', 'forward'] as const, element.dir,
          (d) => t(d === 'forward' ? 'profileEditor.dirForward' : 'profileEditor.dirBackward'),
          (dir) => replace({ ...element, dir }))));
        // Who drives it (V4): every vehicle, or buses only.
        block.append(row(t('profileEditor.use'), segmented(['all', 'bus'] as const, element.use ?? 'all',
          (u) => t(u === 'bus' ? 'profileEditor.useBus' : 'profileEditor.useAll'), (u) => {
            const { use: _u, ...rest } = element; void _u;
            replace(u === 'bus' ? { ...rest, use: 'bus' } : rest);
          })));
        // The line to the next lane of its direction (V4): dashed or solid.
        const next = profile.elements[selected + 1];
        if (next?.kind === 'lane' && next.dir === element.dir) {
          const busLine = (element.use === 'bus') !== (next.use === 'bus');
          const lineRow = row(t('profileEditor.lineRight'), segmented(['dashed', 'solid'] as const, busLine ? 'solid' : element.line ?? 'dashed',
            (l) => t(l === 'solid' ? 'profileEditor.lineSolid' : 'profileEditor.lineDashed'), (l) => {
              if (busLine) return;
              const { line: _l, ...rest } = element; void _l;
              replace(l === 'solid' ? { ...rest, line: 'solid' } : rest);
            }));
          if (busLine) {
            const note = div('rp-note');
            note.textContent = t('profileEditor.lineBus');
            lineRow.querySelector('.rp-ctrls')?.append(note);
            lineRow.querySelectorAll('button').forEach((b) => { b.disabled = true; });
          }
          block.append(lineRow);
        }
      }
      if (element.kind === 'footway') {
        block.append(row(t('profileEditor.paving'), segmented(FOOTWAY_MATERIALS, element.material ?? 'pavers',
          (m) => t(`profile.materialName.${m}`), (m) => replace({ ...element, material: m as FootwayMaterial }))));
        block.append(row('', toggle(t('profileEditor.flush'), element.flush === true, (on) => {
          const { flush: _f, ...rest } = element; void _f;
          replace(on ? { ...rest, flush: true } : rest);
        })));
      }
      if (element.kind === 'median') {
        block.append(row(t('profileEditor.paving'), segmented(MEDIAN_MATERIALS, element.material ?? 'grass',
          (m) => t(`profile.materialName.${m}`), (m) => replace({ ...element, material: m as MedianMaterial }))));
        block.append(row('', toggle(t('profileEditor.medianFlush'), element.flush === true, (on) => {
          const { flush: _f, ...rest } = element; void _f;
          replace(on ? { ...rest, flush: true } : rest);
        })));
      }
      for (const issue of found.filter((x) => x.elements.includes(selected))) block.append(issueLine(issue, false));
    }

    const road = div('rp-block rp-road');
    const roadHead = div('rp-block-head');
    roadHead.textContent = t('profileEditor.road');
    road.append(roadHead);
    road.append(row(t('profileEditor.class'), segmented(ROAD_TYPES.map((_, i) => String(i)), String(type),
      (i) => roadTypeName(ROAD_TYPES[Number(i)]!), (i) => { type = Number(i); status = ''; renderAll(); }, true)));
    road.append(row(t('profile.material.carriageway'), segmented(CARRIAGEWAY_MATERIALS, profile.carriageway ?? 'asphalt',
      (m) => t(`profile.materialName.${m}`), (m) => { profile = { ...profile, carriageway: m as CarriagewayMaterial }; renderAll(); })));
    const [minSpeed, maxSpeed] = ROAD_SECTION_LIMITS.speedKmh;
    road.append(row(t('profileEditor.speed'), stepper(t('profileEditor.speedValue', { speed: profile.speedKmh }),
      profile.speedKmh - 10 >= minSpeed ? () => { profile = { ...profile, speedKmh: profile.speedKmh - 10 }; renderAll(); } : null,
      profile.speedKmh + 10 <= maxSpeed ? () => { profile = { ...profile, speedKmh: profile.speedKmh + 10 }; renderAll(); } : null,
      t('profileEditor.slower'), t('profileEditor.faster'))));
    // The line between the two directions (V6, MBST LFO-1/2/3), where the two meet with no median.
    const lanesBoth = new Set(profile.elements.flatMap((x) => (x.kind === 'lane' ? [x.dir] : [])));
    if (lanesBoth.size === 2 && !profile.elements.some((x) => x.kind === 'median')) {
      road.append(row(t('profileEditor.centreLine'), segmented(['auto', ...CENTRE_LINES], profile.centreLine ?? 'auto',
        (k) => t(`profileEditor.centreLineName.${k}`), (k) => {
          const { centreLine: _c, ...rest } = profile; void _c;
          profile = k === 'auto' ? rest : { ...rest, centreLine: k as CentreLine };
          renderAll();
        })));
    }
    // A blank road is not a list of faults: the picture says how to start.
    const elsewhere = profile.elements.length ? found.filter((x) => !x.elements.includes(selected)) : [];
    for (const issue of elsewhere) road.append(issueLine(issue, issue.elements.length > 0));
    if (!found.length) {
      const ok = div('rp-ok');
      ok.setAttribute('role', 'status');
      ok.innerHTML = `${icon('ok')}<span></span>`;
      ok.querySelector('span')!.textContent = t('profileEditor.ok');
      road.append(ok);
    }
    props.append(block, road);
  };

  // ---- the actions: save as a template, draw new roads with it, apply it
  const save = (): void => {
    const name = nameField.value.trim();
    const saved = name && !issues().length ? saveTemplate(name, type, profile) : null;
    // Saved, the new card is the answer (picked, at the end of the row); only a refusal is written.
    status = saved ? '' : t('profile.notSaved');
    if (saved) {
      saving = false;
      nameField.value = '';
      renderCards();
      options.onSaved?.();
      [...cards.querySelectorAll<HTMLElement>('[data-template]')].find((b) => b.dataset['template'] === saved.id)
        ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
    renderFoot();
  };
  const renderFoot = (): void => {
    foot.replaceChildren();
    const blocked = issues().length > 0;
    if (saving) {
      const ok = button(t('profileEditor.save'), 'save', save);
      const cancel = button(t('profileEditor.cancel'), null, () => { saving = false; renderFoot(); });
      foot.append(nameField, ok, cancel);
    } else {
      const start = button(t('profileEditor.saveShort'), 'save', () => { saving = true; status = ''; renderFoot(); nameField.focus(); });
      start.disabled = blocked;
      start.dataset['action'] = 'save';
      foot.append(start);
    }
    if (status) {
      const note = div('rp-sub');
      note.setAttribute('role', 'status');
      note.textContent = status;
      foot.append(note);
    }
    if (options.drawWith) {
      const draw = button(t('profileEditor.drawWith'), 'pencil', () => {
        const named = [...classTemplates(), ...savedTemplates()].find(sameAs);
        const name = named ? (named.nameKey ? t(named.nameKey) : named.name ?? '') : t('profileEditor.custom');
        options.drawWith!(name || t('profileEditor.custom'), profile, type);
        closeProfileEditor();
      }, options.apply ? '' : 'primary');
      draw.disabled = blocked;
      draw.dataset['action'] = 'draw';
      foot.append(draw);
    }
    if (options.apply) {
      const apply = button(t('profileEditor.apply'), 'apply', () => { options.apply!(profile, type); closeProfileEditor(); }, 'primary');
      apply.disabled = blocked;
      apply.dataset['action'] = 'apply';
      foot.append(apply);
    }
  };

  const renderAll = (): void => {
    renderCards();
    drawStage();
    renderProps();
    renderFoot();
  };

  // Docked: between the top bar and the drawer, whatever the drawer's height.
  function place(): void {
    if (!options.docked) return;
    const drawer = document.querySelector<HTMLElement>('.v2-drawer:not([hidden])');
    const top = drawer ? drawer.getBoundingClientRect().top : window.innerHeight;
    root.style.bottom = `${Math.max(12, Math.round(window.innerHeight - top + 10))}px`;
  }
  place();
  window.addEventListener('resize', place);
  // The picture follows the panel's width (a resized window, a narrower screen).
  const resize = new ResizeObserver(() => { if (!drag) drawStage(); place(); });
  resize.observe(picture);
  openEditor = { root, dispose: () => { resize.disconnect(); window.removeEventListener('resize', place); } };
  renderAll();
  close.focus();
}

function div(className: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  return d;
}

function iconButton(name: string, label: string, run: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'rp-icon';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = icon(name);
  b.onclick = run;
  return b;
}

function button(label: string, iconName: string | null, run: () => void, kind = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `rp-btn${kind ? ` ${kind}` : ''}`;
  b.innerHTML = `${iconName ? icon(iconName) : ''}<span></span>`;
  b.querySelector('span')!.textContent = label;
  b.onclick = run;
  return b;
}

function row(label: string, ...controls: HTMLElement[]): HTMLDivElement {
  const r = div('rp-row');
  const l = div('rp-label');
  l.textContent = label;
  const c = div('rp-ctrls');
  c.append(...controls);
  r.append(l, c);
  return r;
}

function segmented<T extends string>(values: readonly T[], value: T, label: (v: T) => string, change: (v: T) => void, dense = false): HTMLDivElement {
  const box = div(dense ? 'rp-seg dense' : 'rp-seg');
  box.setAttribute('role', 'radiogroup');
  for (const v of values) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(v === value));
    b.dataset['value'] = v;
    if (v === value) b.classList.add('on');
    b.textContent = label(v);
    b.onclick = () => { if (v !== value) change(v); };
    box.append(b);
  }
  return box;
}

function stepper(value: string, less: (() => void) | null, more: (() => void) | null, lessLabel = t('profileEditor.narrower'), moreLabel = t('profileEditor.wider')): HTMLDivElement {
  const box = div('rp-step');
  const minus = document.createElement('button');
  minus.type = 'button';
  minus.textContent = '−';
  minus.setAttribute('aria-label', lessLabel);
  minus.disabled = !less;
  if (less) minus.onclick = less;
  const out = document.createElement('output');
  out.textContent = value;
  const plus = document.createElement('button');
  plus.type = 'button';
  plus.textContent = '+';
  plus.setAttribute('aria-label', moreLabel);
  plus.disabled = !more;
  if (more) plus.onclick = more;
  box.append(minus, out, plus);
  return box;
}

function toggle(label: string, on: boolean, change: (on: boolean) => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'rp-switch';
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-checked', String(on));
  b.innerHTML = '<span class="track"><span class="knob"></span></span><span class="txt"></span>';
  b.querySelector('.txt')!.textContent = label;
  b.onclick = () => change(!on);
  return b;
}

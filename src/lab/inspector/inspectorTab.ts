import type { BufferGeometry } from 'three';
import type { LabTab } from '../labTypes';
import { button, copyText, el, fold, heading, kv, safeJson, valueTree } from './dom';
import { entityInfo, entityLabel, gameProbe } from './entity';
import { relatedSection } from './relatedView';
import type { Picker } from './pick';
import { geometrySection, materialsSection, objectSection } from './sections';
import type { EntityRef, InspectorState, Selection } from './state';

/** THE INSPECTOR TAB: the picker's button, then everything about the selection - the game's entity (its record, its lot, its traffic), the 3D object,
 *  its geometry and materials with their live edits, what relates to it (switches, optimisations, GPU draws, memory, the code that makes it) - and the edits made. */

export function createInspectorTab(state: InspectorState, picker: Picker, summary: () => unknown): LabTab {
  const ctx = state.ctx;
  let host: HTMLElement | null = null;
  let content: HTMLElement | null = null;
  let live: HTMLElement | null = null;
  let editsBox: HTMLElement | null = null;
  let pickButton: HTMLButtonElement | null = null;
  let stops: (() => void)[] = [];

  const drawPickButton = (): void => {
    if (!pickButton) return;
    pickButton.classList.toggle('on', picker.active);
    pickButton.querySelector('span')!.textContent = picker.active ? 'Picking… (Esc exits)' : 'Pick in game';
  };
  picker.onChange(drawPickButton);

  /** The entity's fields that move (a vehicle, a person), drawn again each refresh. */
  const drawLive = (ref: EntityRef): void => {
    if (!live) return;
    const info = entityInfo(ctx, ref);
    live.replaceChildren(kv(info.rows));
  };

  const entityBlock = (s: Selection, ref: EntityRef): HTMLElement => {
    const box = el('div');
    const info = entityInfo(ctx, ref);
    box.appendChild(heading(`Game entity: ${info.title}`, 'info'));
    live = el('div');
    live.appendChild(kv(info.rows));
    box.appendChild(live);
    const actions = el('div', 'lab-row');
    const game = gameProbe();
    if (info.at && game?.lookAt) {
      const at = info.at;
      actions.appendChild(button('crosshair', 'Focus camera', 'Centres the game camera on this entity (__roadcraft.lookAt)', () => {
        game.lookAt?.(at.x, at.y);
        ctx.emit('inspector.focus', `camera at ${entityLabel(ref)}`);
      }));
    }
    actions.appendChild(button('copy', 'Copy JSON', 'Copies the entity record', () => copyText(safeJson({ entity: ref, record: info.record, ...(info.extra ?? {}) }, 1))));
    box.appendChild(actions);
    box.appendChild(fold('Full record', ref.kind === 'building', valueTree(info.record, 'record')));
    for (const [k, v] of Object.entries(info.extra ?? {})) box.appendChild(fold(k, false, valueTree(v, k)));
    const others = s.entities.filter((e) => e !== ref);
    if (others.length) {
      const row = el('div', 'lab-row');
      row.appendChild(el('span', 'lab-muted', 'Also under the cursor:'));
      for (const e of others) row.appendChild(button('', entityLabel(e), 'Show this entity', () => state.select({ ...s, entity: e })));
      box.appendChild(row);
    }
    return box;
  };

  const drawEdits = (): void => {
    if (!editsBox) return;
    const list = state.edits.list();
    editsBox.replaceChildren(heading(`Live edits (${list.length})`, 'sliders'));
    if (!list.length) { editsBox.appendChild(el('p', 'lab-muted', 'No edits: change a field above to try something without editing the code. Each becomes an event (edit.*) that the recording marks.')); return; }
    const rows = el('div', 'insp-edits');
    for (const e of [...list].reverse()) {
      const row = el('div', 'insp-edit-row');
      row.append(el('span', 'lab-muted', e.kind), el('span', '', `${e.target}.${e.key}`), el('span', 'lab-warn', `${e.was ? `${e.was} → ` : ''}${e.value}`),
        button('', 'undo', 'Undoes this edit', () => state.edits.undo(e.id)));
      rows.appendChild(row);
    }
    editsBox.append(rows, button('refresh', 'Restore all', 'Undoes every edit, last to first', () => state.edits.undoAll()));
  };

  const draw = (): void => {
    if (!content) return;
    live = null;
    const s = state.selection;
    const parts: HTMLElement[] = [];
    if (!s) {
      parts.push(el('p', 'lab-muted', 'Nothing selected. Click "Pick in game" (or Ctrl+Shift+C with the lab open) and hover over the game: what is under the cursor is highlighted; a click selects it (Shift+click keeps picking, Esc or right click exits). Also from the Scene tab or the Console ($inspect(obj)).'));
    } else {
      try {
        if (s.entity) parts.push(entityBlock(s, s.entity));
        if (s.object) {
          parts.push(objectSection(state, s, s.object));
          const geometry = (s.object as { geometry?: BufferGeometry }).geometry;
          if (geometry) parts.push(geometrySection(state, geometry));
          if ((s.object as { material?: unknown }).material) parts.push(materialsSection(state, s.object));
          parts.push(relatedSection(state, s.object));
        } else {
          parts.push(el('p', 'lab-muted', 'No 3D object under the cursor (only the game entity).'));
        }
      } catch (error) {
        console.error('lab inspector: drawing the selection failed', error);
        parts.push(el('pre', 'lab-code lab-bad', `Failed to draw the selection: ${String(error)}\n${(error as Error).stack ?? ''}`));
      }
    }
    editsBox = el('div');
    parts.push(editsBox);
    content.replaceChildren(...parts);
    drawEdits();
  };

  return {
    id: 'inspector',
    title: 'Inspector',
    mount(target) {
      host = target;
      const bar = el('div', 'lab-row insp-bar');
      pickButton = button('pointer', 'Pick in game', 'Picks in the game: hover and click (Ctrl+Shift+C; Esc exits). The clicks never reach the game.', () => (picker.active ? picker.stop() : picker.start()));
      drawPickButton();
      bar.append(
        pickButton,
        button('close', 'Clear', 'Forgets the selection', () => state.select(null)),
        button('copy', 'Copy summary', 'Copies the summary of the selection and the edits (what goes into the report) as JSON', () => copyText(safeJson(summary(), 1))),
        button('tree', 'In scene', 'Shows the selection in the scene tree', () => { if (state.selection?.object) ctx.navigate('scene', { uuid: state.selection.object.uuid }); }),
      );
      content = el('div', 'insp-content');
      host.append(bar, content);
      stops = [state.onSelect(() => draw()), state.edits.onChange(() => drawEdits())];
      draw();
    },
    refresh() {
      const s = state.selection;
      if (s?.entity && (s.entity.kind === 'vehicle' || s.entity.kind === 'person')) drawLive(s.entity);
    },
    unmount() {
      for (const stop of stops) stop();
      stops = [];
      host = null;
      content = null;
      editsBox = null;
      pickButton = null;
    },
    focus(params) {
      if (params['pick'] === '1') picker.start();
    },
  };
}

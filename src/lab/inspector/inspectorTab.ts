import type { BufferGeometry } from 'three';
import type { LabTab } from '../labTypes';
import { button, copyText, el, fold, heading, kv, safeJson, valueTree } from './dom';
import { entityInfo, entityLabel, gameProbe } from './entity';
import { relatedSection } from './relatedView';
import type { Picker } from './pick';
import { geometrySection, materialsSection, objectSection } from './sections';
import type { EntityRef, InspectorState, Selection } from './state';

/** THE INSPETOR TAB: the picker's button, then everything about the selection - the game's entity (its record, its lot, its traffic), the 3D object,
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
    pickButton.querySelector('span')!.textContent = picker.active ? 'Selecionando… (Esc sai)' : 'Selecionar no jogo';
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
    box.appendChild(heading(`Entidade do jogo: ${info.title}`, 'info'));
    live = el('div');
    live.appendChild(kv(info.rows));
    box.appendChild(live);
    const actions = el('div', 'lab-row');
    const game = gameProbe();
    if (info.at && game?.lookAt) {
      const at = info.at;
      actions.appendChild(button('crosshair', 'Focar a câmera', 'Centra a câmera do jogo nesta entidade (__roadcraft.lookAt)', () => {
        game.lookAt?.(at.x, at.y);
        ctx.emit('inspector.focus', `câmera em ${entityLabel(ref)}`);
      }));
    }
    actions.appendChild(button('copy', 'Copiar JSON', 'Copia o registro da entidade', () => copyText(safeJson({ entity: ref, record: info.record, ...(info.extra ?? {}) }, 1))));
    box.appendChild(actions);
    box.appendChild(fold('Registro completo', ref.kind === 'building', valueTree(info.record, 'registro')));
    for (const [k, v] of Object.entries(info.extra ?? {})) box.appendChild(fold(k, false, valueTree(v, k)));
    const others = s.entities.filter((e) => e !== ref);
    if (others.length) {
      const row = el('div', 'lab-row');
      row.appendChild(el('span', 'lab-muted', 'Também sob o cursor:'));
      for (const e of others) row.appendChild(button('', entityLabel(e), 'Mostrar esta entidade', () => state.select({ ...s, entity: e })));
      box.appendChild(row);
    }
    return box;
  };

  const drawEdits = (): void => {
    if (!editsBox) return;
    const list = state.edits.list();
    editsBox.replaceChildren(heading(`Edições ao vivo (${list.length})`, 'sliders'));
    if (!list.length) { editsBox.appendChild(el('p', 'lab-muted', 'Nenhuma edição: mude um campo acima para testar sem editar o código. Cada uma vira um evento (edit.*) que a gravação marca.')); return; }
    const rows = el('div', 'insp-edits');
    for (const e of [...list].reverse()) {
      const row = el('div', 'insp-edit-row');
      row.append(el('span', 'lab-muted', e.kind), el('span', '', `${e.target}.${e.key}`), el('span', 'lab-warn', `${e.was ? `${e.was} → ` : ''}${e.value}`),
        button('', 'desfazer', 'Desfaz esta edição', () => state.edits.undo(e.id)));
      rows.appendChild(row);
    }
    editsBox.append(rows, button('refresh', 'Restaurar tudo', 'Desfaz todas as edições, da última à primeira', () => state.edits.undoAll()));
  };

  const draw = (): void => {
    if (!content) return;
    live = null;
    const s = state.selection;
    const parts: HTMLElement[] = [];
    if (!s) {
      parts.push(el('p', 'lab-muted', 'Nada selecionado. Clique em "Selecionar no jogo" (ou Ctrl+Shift+C com o laboratório aberto) e passe o mouse sobre o jogo: o que está sob o cursor fica destacado; um clique seleciona (Shift+clique continua selecionando, Esc ou botão direito sai). Também pela aba Cena ou pelo Console ($inspect(obj)).'));
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
          parts.push(el('p', 'lab-muted', 'Nenhum objeto 3D sob o cursor (só a entidade do jogo).'));
        }
      } catch (error) {
        console.error('lab inspector: drawing the selection failed', error);
        parts.push(el('pre', 'lab-code lab-bad', `Falha ao desenhar a seleção: ${String(error)}\n${(error as Error).stack ?? ''}`));
      }
    }
    editsBox = el('div');
    parts.push(editsBox);
    content.replaceChildren(...parts);
    drawEdits();
  };

  return {
    id: 'inspector',
    title: 'Inspetor',
    mount(target) {
      host = target;
      const bar = el('div', 'lab-row insp-bar');
      pickButton = button('pointer', 'Selecionar no jogo', 'Seleciona no jogo: passe o mouse e clique (Ctrl+Shift+C; Esc sai). Os cliques não chegam ao jogo.', () => (picker.active ? picker.stop() : picker.start()));
      drawPickButton();
      bar.append(
        pickButton,
        button('close', 'Limpar', 'Esquece a seleção', () => state.select(null)),
        button('copy', 'Copiar resumo', 'Copia o resumo da seleção e das edições (o que vai para o relatório) em JSON', () => copyText(safeJson(summary(), 1))),
        button('tree', 'Na cena', 'Mostra a seleção na árvore da cena', () => { if (state.selection?.object) ctx.navigate('scene', { uuid: state.selection.object.uuid }); }),
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

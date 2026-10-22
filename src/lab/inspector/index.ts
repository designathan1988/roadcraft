import type { Object3D } from 'three';
import type { LabContext, LabTab } from '../labTypes';
import { createConsoleTab } from './consoleTab';
import { pathOf } from './describe';
import { entityLabel } from './entity';
import { createInspectorTab } from './inspectorTab';
import { createHighlight, createPicker } from './pick';
import { createSceneTab } from './sceneTab';
import { createInspectorState, type Selection } from './state';
import './inspector.css';

/** THE LAB'S INSPECTOR, Chrome's element picker for the game: "Inspetor" (pick in the game and see everything about it - the game's entity, the 3D object,
 *  its geometry, materials, program, switches, draws, memory and the code that makes it - and edit it live), "Cena" (the scene's tree) and "Console" (a REPL with the selection in scope).
 *  Ctrl+Shift+C with the lab open starts the picker. The selection and the edits go into every report (`inspector`) and to the probes (`window.__labInspector`). */
export function createInspectorTabs(ctx: LabContext): LabTab[] {
  const state = createInspectorState(ctx);
  const highlight = createHighlight(ctx, 0x2fc2ab);
  const picker = createPicker(state, (s) => {
    state.select(s);
    ctx.navigate('inspector');
  });
  state.onSelect((s) => highlight.show(s?.object ?? null, s?.instanceId ?? null, s?.batchId ?? null));

  const summary = (): unknown => {
    const s = state.selection;
    return {
      selection: s ? {
        via: s.via,
        object: s.object ? { type: s.object.type, name: s.object.name, uuid: s.object.uuid, path: pathOf(s.object), instanceId: s.instanceId, batchId: s.batchId, exact: s.exact } : null,
        entity: s.entity ? entityLabel(s.entity) : null,
        entities: s.entities.map(entityLabel),
        hitsUnderCursor: s.hits.length,
        point: s.point ? [s.point.x, s.point.y, s.point.z].map((v) => Math.round(v * 1000) / 1000) : null,
      } : null,
      edits: state.edits.list().map((e) => ({ kind: e.kind, target: e.target, key: e.key, was: e.was, value: e.value, atMs: Math.round(e.t) })),
    };
  };
  ctx.reportSection('inspector', summary);

  const plain = (object: Object3D): Selection => ({ object, instanceId: null, batchId: null, point: null, exact: false, entity: null, entities: [], hits: [], via: 'console' });
  // For the tests and an AI driving the game: select, pick, read the selection and the edits.
  (window as unknown as { __labInspector: unknown }).__labInspector = {
    state,
    select: (object: Object3D | null) => state.select(object ? plain(object) : null),
    pick: () => { ctx.navigate('inspector'); picker.start(); },
    stopPicking: () => picker.stop(),
    selection: () => state.selection,
    summary,
    edits: () => state.edits.list(),
    undoAll: () => state.edits.undoAll(),
  };

  // Ctrl+Shift+C while the lab is open: the picker (as in the browser's DevTools).
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey && e.shiftKey && e.code === 'KeyC')) return;
    if (!document.querySelector('.lab-panel:not([hidden])')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (picker.active) { picker.stop(); return; }
    ctx.navigate('inspector');
    picker.start();
  }, { capture: true });

  return [createInspectorTab(state, picker, summary), createSceneTab(state), createConsoleTab(state)];
}

import type { Object3D } from 'three';
import { icon } from '../icons';
import type { LabTab } from '../labTypes';
import { button, el, num } from './dom';
import { pathOf, trianglesUnder } from './describe';
import { INSPECTOR_OWN } from './raycast';
import type { InspectorState } from './state';

/** THE CENA TAB: the scene's tree, opened a level at a time (its rows made only when shown), filtered by name or type; each node with its children and triangles,
 *  the hidden ones dimmed, an eye to hide or show it (an edit, undone in the Inspetor); a click selects it in the Inspetor. */

const MAX_CHILDREN = 300;
const MAX_FOUND = 500;

export function createSceneTab(state: InspectorState): LabTab {
  const ctx = state.ctx;
  const open = new Set<Object3D>();
  let list: HTMLElement | null = null;
  let filter = '';
  let filterInput: HTMLInputElement | null = null;
  let stop: (() => void) | null = null;
  /** The rows drawn, by their object: the selection marked without drawing the tree again (a double click needs the same row). */
  const shown = new Map<Object3D, HTMLElement>();
  /** Triangles per node, worked out once per drawing of the tree (a subtree walked each). */
  let triangles = new WeakMap<Object3D, number>();
  const trisOf = (o: Object3D): number => {
    let t = triangles.get(o);
    if (t === undefined) { t = trianglesUnder(o); triangles.set(o, t); }
    return t;
  };

  const select = (o: Object3D): void => {
    state.select({ object: o, instanceId: null, batchId: null, point: null, exact: false, entity: null, entities: [], hits: [], via: 'scene' });
  };

  const row = (o: Object3D, depth: number, path?: string): HTMLElement => {
    const r = el('div', 'insp-node');
    r.style.paddingLeft = `${4 + depth * 14}px`;
    if (!o.visible) r.classList.add('hidden-node');
    if (state.selection?.object === o) r.classList.add('selected');
    const caret = el('button', 'insp-caret', o.children.length ? (open.has(o) ? '▾' : '▸') : '');
    caret.type = 'button';
    caret.disabled = !o.children.length;
    caret.title = open.has(o) ? 'Fechar' : 'Abrir';
    caret.onclick = (e) => { e.stopPropagation(); if (open.has(o)) open.delete(o); else open.add(o); draw(); };
    const eye = el('button', `insp-eye${o.visible ? '' : ' off'}`);
    eye.type = 'button';
    eye.title = o.visible ? 'Ocultar (edição desfazível)' : 'Mostrar';
    eye.appendChild(icon('eye', 13));
    eye.onclick = (e) => {
      e.stopPropagation();
      state.edits.set(o, 'visible', !o.visible, { kind: 'object', target: `${o.type} "${o.name || '—'}"` });
      draw();
    };
    const label = el('span', 'insp-node-label', `${o.name || '(sem nome)'}`);
    const kind = el('span', 'lab-muted', ` ${o.type}`);
    const counts = el('span', 'insp-node-count', `${o.children.length ? `${o.children.length} filhos · ` : ''}${num(trisOf(o))} tri`);
    r.append(caret, eye, label, kind, counts);
    if (path) r.appendChild(el('span', 'insp-node-path', path));
    r.onclick = () => select(o);
    r.ondblclick = () => { select(o); ctx.navigate('inspector'); };
    r.title = pathOf(o);
    shown.set(o, r);
    return r;
  };

  const draw = (): void => {
    if (!list) return;
    triangles = new WeakMap();
    shown.clear();
    const rows: HTMLElement[] = [];
    const scene = ctx.scene.scene;
    const text = filter.trim().toLowerCase();
    if (text) {
      // Filtered: a flat list of the nodes whose name or type has the text, with their path.
      let found = 0;
      scene.traverse((o) => {
        if (found >= MAX_FOUND || o.userData[INSPECTOR_OWN]) return;
        if (`${o.name} ${o.type}`.toLowerCase().includes(text)) { rows.push(row(o, 0, pathOf(o.parent ?? o))); found++; }
      });
      if (found >= MAX_FOUND) rows.push(el('p', 'lab-muted', `Só os primeiros ${MAX_FOUND}: refine o filtro.`));
      if (!found) rows.push(el('p', 'lab-muted', 'Nada com este filtro.'));
    } else {
      const walk = (o: Object3D, depth: number): void => {
        rows.push(row(o, depth));
        if (!open.has(o)) return;
        const children = o.children.filter((c) => !c.userData[INSPECTOR_OWN]);
        for (const c of children.slice(0, MAX_CHILDREN)) walk(c, depth + 1);
        if (children.length > MAX_CHILDREN) rows.push(el('p', 'lab-muted', `… mais ${children.length - MAX_CHILDREN} filhos (use o filtro)`));
      };
      open.add(scene);
      walk(scene, 0);
    }
    list.replaceChildren(...rows);
  };

  /** The tree opened down to an object, and scrolled to it. */
  const reveal = (o: Object3D): void => {
    for (let p = o.parent; p; p = p.parent) open.add(p);
    filter = '';
    if (filterInput) filterInput.value = '';
    draw();
    list?.querySelector('.insp-node.selected')?.scrollIntoView({ block: 'center' });
  };

  return {
    id: 'scene',
    title: 'Cena',
    mount(host) {
      const bar = el('div', 'lab-row');
      filterInput = el('input');
      filterInput.type = 'search';
      filterInput.placeholder = 'Filtrar por nome ou tipo…';
      filterInput.value = filter;
      filterInput.oninput = () => { filter = filterInput!.value; draw(); };
      bar.append(
        filterInput,
        button('refresh', 'Atualizar', 'Lê a cena de novo', () => draw()),
        button('crosshair', 'Ir à seleção', 'Abre a árvore até o objeto selecionado', () => { const o = state.selection?.object; if (o) reveal(o); }),
        button('minus', 'Fechar tudo', 'Fecha todos os nós', () => { open.clear(); draw(); }),
      );
      list = el('div', 'insp-tree-list');
      host.append(bar, el('p', 'lab-muted', 'Clique num nó para selecioná-lo (destacado no jogo), duplo clique para abri-lo no Inspetor; o olho oculta ou mostra (desfazível na lista de edições do Inspetor). Ocultos aparecem esmaecidos.'), list);
      stop = state.onSelect((s) => { for (const [o, r] of shown) r.classList.toggle('selected', o === s?.object); });
      draw();
    },
    unmount() {
      stop?.();
      stop = null;
      list = null;
      filterInput = null;
    },
    focus(params) {
      if (params['filter'] !== undefined) { filter = params['filter']; if (filterInput) filterInput.value = filter; draw(); return; }
      const uuid = params['uuid'];
      if (uuid) {
        const o = ctx.scene.scene.getObjectByProperty('uuid', uuid);
        if (o) reveal(o);
      }
    },
  };
}

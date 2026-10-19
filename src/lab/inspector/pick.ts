import { Box3, Box3Helper, Color, type Object3D } from 'three';
import type { LabContext } from '../labTypes';
import { entitiesAt, entityLabel } from './entity';
import { hitForEntity, hitsAlong, INSPECTOR_OWN, primaryHit, rayAtPixel, selectionBox, solidExact } from './raycast';
import type { InspectorState, Selection } from './state';

/** THE ELEMENT PICKER, FOR THE GAME: while on, what is under the cursor is outlined (its box drawn over everything) with a tooltip, and a click selects it.
 *  The game never sees those clicks: listeners on the window in the capture phase take every pointer event aimed at the game's canvases
 *  (`#game`, `#game-scene`, `#game-overlay`) and stop it (`stopImmediatePropagation`); Esc or a right click leaves, Shift+click selects and stays. */

const POINTER_EVENTS = ['pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'contextmenu', 'auxclick'] as const;
/** At most one hover pick in this many ms: a pick walks the scene. */
const HOVER_MS = 70;

const isGameCanvas = (target: EventTarget | null): target is HTMLCanvasElement =>
  target instanceof HTMLCanvasElement && (target.id === 'game' || target.id === 'game-scene' || target.id === 'game-overlay');

/** The selection under a canvas pixel (CSS px from its corner). */
export function selectionAt(ctx: LabContext, px: number, py: number): Selection {
  const ray = rayAtPixel(ctx, px, py);
  const hits = ray ? hitsAlong(ctx.scene.scene, ray) : [];
  // A solid met by its triangles is what was pointed at; else the game's own pick says which entity, and the object is the one drawing it.
  const exact = solidExact(hits);
  const found = entitiesAt(ctx, px, py, ray, exact);
  const first = exact ?? (found[0] ? hitForEntity(hits, found[0].kind) : null) ?? primaryHit(hits);
  return {
    object: first?.object ?? null, instanceId: first?.instanceId ?? null, batchId: first?.batchId ?? null, point: first?.point ?? null,
    exact: first?.exact ?? false, entity: found[0] ?? null, entities: found, hits, via: 'pick',
  };
}

export interface Highlight {
  /** The box of what is selected, or null to take it away. */
  show(object: Object3D | null, instanceId: number | null, batchId: number | null): void;
  dispose(): void;
}

/** A box drawn over everything (depth test off), in the inspector's colour; never picked itself. */
export function createHighlight(ctx: LabContext, colour: number): Highlight {
  const box = new Box3();
  const helper = new Box3Helper(box, new Color(colour));
  helper.name = 'lab-inspector-highlight';
  helper.userData[INSPECTOR_OWN] = true;
  helper.renderOrder = 1e6;
  helper.frustumCulled = false;
  const material = helper.material as { depthTest: boolean; depthWrite: boolean; transparent: boolean; toneMapped: boolean };
  material.depthTest = false;
  material.depthWrite = false;
  material.transparent = true;
  material.toneMapped = false;
  helper.visible = false;
  let added = false;
  return {
    show(object, instanceId, batchId) {
      const b = object ? selectionBox(object, instanceId, batchId) : null;
      if (!b) { if (helper.visible) { helper.visible = false; ctx.requestDraw(); } return; }
      if (!added) { ctx.scene.scene.add(helper); added = true; }
      box.copy(b);
      helper.visible = true;
      helper.updateMatrixWorld(true);
      ctx.requestDraw();
    },
    dispose() {
      helper.removeFromParent();
      added = false;
      helper.geometry.dispose();
      (helper.material as { dispose(): void }).dispose();
      ctx.requestDraw();
    },
  };
}

export interface Picker {
  readonly active: boolean;
  start(): void;
  stop(): void;
  /** Told when it starts and stops. */
  onChange(listener: (active: boolean) => void): void;
}

export function createPicker(state: InspectorState, selected: (selection: Selection) => void): Picker {
  const ctx = state.ctx;
  const hover = createHighlight(ctx, 0xffc35a);
  const tip = document.createElement('div');
  tip.className = 'insp-tip';
  tip.hidden = true;
  const listeners: ((active: boolean) => void)[] = [];
  let active = false;
  let lastHover = 0;
  let pending: { x: number; y: number; cx: number; cy: number } | null = null;
  let frame = 0;
  let cursorWas = '';

  const local = (e: MouseEvent): { x: number; y: number } => {
    const rect = ctx.scene.gl.domElement.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const hoverNow = (): void => {
    frame = 0;
    if (!pending || !active) return;
    const now = performance.now();
    if (now - lastHover < HOVER_MS) { frame = requestAnimationFrame(hoverNow); return; }
    lastHover = now;
    const at = pending;
    pending = null;
    try {
      const s = selectionAt(ctx, at.x, at.y);
      hover.show(s.object, s.instanceId, s.batchId);
      if (!s.object) { tip.hidden = true; return; }
      const o = s.object;
      tip.replaceChildren();
      const title = document.createElement('strong');
      title.textContent = `${o.type} "${o.name || '—'}"`;
      const sub = document.createElement('span');
      sub.textContent = `${s.entity ? `${entityLabel(s.entity)} · ` : ''}${s.instanceId !== null ? `instância ${s.instanceId} · ` : ''}${s.batchId !== null ? `lote ${s.batchId} · ` : ''}${s.exact ? 'triângulos' : 'pela caixa'} · ${s.hits.length} sob o cursor`;
      tip.append(title, sub);
      tip.style.left = `${Math.min(window.innerWidth - 260, at.cx + 14)}px`;
      tip.style.top = `${Math.min(window.innerHeight - 50, at.cy + 16)}px`;
      tip.hidden = false;
    } catch (error) {
      console.error('lab inspector: hover pick failed', error);
    }
  };

  const take = (e: Event): void => {
    if (!active || !isGameCanvas(e.target)) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const me = e as PointerEvent;
    if (e.type === 'pointermove') {
      const p = local(me);
      pending = { x: p.x, y: p.y, cx: me.clientX, cy: me.clientY };
      if (!frame) frame = requestAnimationFrame(hoverNow);
      return;
    }
    if (e.type !== 'pointerdown') return;
    if (me.button === 2) { picker.stop(); return; }
    if (me.button !== 0) return;
    const p = local(me);
    try {
      const s = selectionAt(ctx, p.x, p.y);
      ctx.emit('inspector.pick', `escolhido: ${s.object ? `${s.object.type} "${s.object.name}"` : 'nada'}${s.entity ? ` · ${entityLabel(s.entity)}` : ''}`);
      selected(s);
    } catch (error) {
      console.error('lab inspector: pick failed', error);
    }
    if (!me.shiftKey) picker.stop();
  };
  const key = (e: KeyboardEvent): void => {
    if (!active || e.key !== 'Escape') return;
    e.stopImmediatePropagation();
    e.preventDefault();
    picker.stop();
  };
  const leave = (): void => { tip.hidden = true; };

  const picker: Picker = {
    get active() { return active; },
    start() {
      if (active) return;
      active = true;
      for (const type of POINTER_EVENTS) window.addEventListener(type, take, { capture: true });
      window.addEventListener('keydown', key, { capture: true });
      document.getElementById('game')?.addEventListener('pointerleave', leave);
      document.body.appendChild(tip);
      const game = document.getElementById('game');
      if (game) { cursorWas = game.style.cursor; game.style.cursor = 'crosshair'; }
      ctx.emit('inspector.pickMode', 'seletor ligado');
      for (const l of listeners) l(true);
    },
    stop() {
      if (!active) return;
      active = false;
      for (const type of POINTER_EVENTS) window.removeEventListener(type, take, { capture: true });
      window.removeEventListener('keydown', key, { capture: true });
      document.getElementById('game')?.removeEventListener('pointerleave', leave);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      pending = null;
      tip.remove();
      hover.show(null, null, null);
      const game = document.getElementById('game');
      if (game) game.style.cursor = cursorWas;
      ctx.emit('inspector.pickMode', 'seletor desligado');
      for (const l of listeners) l(false);
    },
    onChange(listener) { listeners.push(listener); },
  };
  return picker;
}

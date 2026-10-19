import { LAB_REFRESH_MS, type LabContext, type LabSubject, type LabTab } from './labTypes';
import type { UsageMeter, UsageReading } from './usage';
import { icon, tabIcon } from './icons';
import { INVESTIGATE_EVENT, createInvestigator } from './investigate';

/** THE LAB'S WINDOW: docked at either side, centred large, maximised or reduced to its meters; resized from any edge, dragged by its head; tabs at the side when wide; the usage meters on top, each opening what consumes it; a status line at the foot. Its place and size are kept. */

type Mode = 'right' | 'left' | 'center' | 'max' | 'mini' | 'free';

interface Kept {
  mode: Mode;
  /** The free window's box, px. */
  box: { x: number; y: number; w: number; h: number };
  /** The docked width, px. */
  dockWidth: number;
  font: number;
  see: boolean;
}

const KEY = 'roadcraft.lab.window';
const MODES: readonly (readonly [Mode, string, string])[] = [
  ['left', 'left', 'Encaixar à esquerda'],
  ['right', 'right', 'Encaixar à direita'],
  ['center', 'center', 'Centralizar, grande'],
  ['max', 'max', 'Maximizar (duplo clique no título)'],
  ['mini', 'mini', 'Só os medidores'],
];

/** The tabs' groups, in the order shown (a tab of no group goes to the last). */
const GROUPS: readonly (readonly [string, readonly string[]])[] = [
  ['Diagnóstico', ['doctor', 'overview', 'diagnostics']],
  ['Elementos', ['inspector', 'scene', 'console']],
  ['GPU', ['gpu', 'gpu-frame', 'gpu-objects', 'gpu-webgl']],
  ['CPU e memória', ['consumers', 'code', 'coverage']],
  ['Controles', ['switches', 'optimizations']],
  ['Gravar e testar', ['recorder', 'recorder-reports', 'tests-sweep', 'tests-bench', 'probes']],
];

/** Where each meter leads when clicked: the tab and what it is asked to show. */
const METER_TARGET: Readonly<Record<UsageReading['id'], readonly [string, Readonly<Record<string, string>>]>> = {
  cpu: ['consumers', { category: 'CPU-main' }],
  gpu: ['gpu', {}],
  ram: ['consumers', { category: 'RAM' }],
  vram: ['gpu-objects', {}],
  disk: ['consumers', { category: 'Disco' }],
  fps: ['overview', {}],
  draws: ['gpu-frame', {}],
};

function readKept(): Kept {
  const fallback: Kept = { mode: 'right', box: { x: 120, y: 80, w: 900, h: 640 }, dockWidth: 680, font: 12, see: false };
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as Partial<Kept> | null;
    return raw ? { ...fallback, ...raw, box: { ...fallback.box, ...raw.box } } : fallback;
  } catch (error) {
    console.warn('lab window place unreadable', error);
    return fallback;
  }
}

export interface LabWindow {
  readonly isOpen: boolean;
  open(id?: string, params?: Readonly<Record<string, string>>): void;
  close(): boolean;
  readonly current: string | null;
  /** The investigation drawer opened on `subject`, the window opened if closed. */
  investigate(subject: LabSubject): void;
}

export function createLabWindow(ctx: LabContext, tabs: readonly LabTab[], usage: UsageMeter): LabWindow {
  const kept = readKept();
  const save = (): void => {
    try { window.localStorage.setItem(KEY, JSON.stringify(kept)); } catch (error) { console.warn('lab window place not kept', error); }
  };

  const panel = document.createElement('aside');
  panel.className = 'lab-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Laboratório de depuração');
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text) e.textContent = text;
    return e;
  };
  /** A button with an icon, and its text when given; `title` its tooltip and accessible name. */
  const button = (glyph: string, text: string, title: string, onClick: () => void, className = ''): HTMLButtonElement => {
    const b = el('button', className);
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    if (glyph) b.appendChild(icon(glyph));
    if (text) b.appendChild(el('span', '', text));
    b.onclick = onClick;
    return b;
  };

  // ---- the head: title, meters, the window's buttons
  const head = el('header', 'lab-head');
  const title = el('strong', 'lab-title');
  title.append(icon('flask', 16), el('span', '', 'Laboratório'));
  const meters = el('div', 'lab-meters');
  const tools = el('div', 'lab-tools');
  const modeButtons = new Map<Mode, HTMLButtonElement>();
  for (const [mode, glyph, label] of MODES) {
    const b = button(glyph, '', label, () => setMode(kept.mode === mode && mode !== 'right' ? 'right' : mode), 'lab-icon-button');
    modeButtons.set(mode, b);
    tools.appendChild(b);
  }
  const seeThrough = button('eye', '', 'Transparente: ver o jogo atrás', () => { kept.see = !kept.see; save(); place(); }, 'lab-icon-button');
  const smaller = button('minus', '', 'Letra menor', () => { kept.font = Math.max(10, kept.font - 1); save(); place(); }, 'lab-icon-button');
  const larger = button('plus', '', 'Letra maior', () => { kept.font = Math.min(18, kept.font + 1); save(); place(); }, 'lab-icon-button');
  const close = button('close', '', 'Fechar (Esc, F7)', () => { win.close(); }, 'lab-icon-button lab-close');
  tools.append(seeThrough, smaller, larger, close);
  head.append(title, meters, tools);

  // ---- tabs, body, status
  const main = el('div', 'lab-main');
  const tabBar = el('nav', 'lab-tabs');
  tabBar.setAttribute('role', 'tablist');
  const body = el('section', 'lab-body');
  const investigator = createInvestigator(ctx);
  main.append(tabBar, body, investigator.element);
  // Any table row (or anything) sends its subject up: investigated here.
  panel.addEventListener(INVESTIGATE_EVENT, (e) => {
    const subject = (e as CustomEvent<LabSubject>).detail;
    investigator.open(subject.from || !current ? subject : { ...subject, from: current.title });
  });
  const status = el('footer', 'lab-status');
  const statusText = el('span', 'lab-status-text');
  const copyState = button('copy', 'Copiar estado', 'Copiar para a área de transferência o estado completo do laboratório (todas as seções do relatório) em JSON', () => {
    const state = { at: new Date().toISOString(), usage: usage.readings(), settings: ctx.effects.snapshot(), sections: ctx.collectReport(), events: ctx.events().slice(-200) };
    void navigator.clipboard.writeText(JSON.stringify(state, null, 1)).then(() => { statusText.textContent = 'Estado copiado.'; },
      (error: unknown) => console.warn('lab: state not copied', error));
  });
  status.append(statusText, copyState);
  panel.append(head, main, status);

  // ---- edges to resize from
  for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const) {
    const grip = el('div', `lab-grip lab-grip-${edge}`);
    grip.addEventListener('pointerdown', (e) => resizeFrom(edge, e));
    panel.appendChild(grip);
  }
  document.body.appendChild(panel);

  const meterEls = new Map<UsageReading['id'], { root: HTMLButtonElement; value: HTMLElement; fill: HTMLElement; spark: HTMLCanvasElement }>();
  const drawMeters = (): void => {
    for (const r of usage.readings()) {
      let m = meterEls.get(r.id);
      if (!m) {
        const root = el('button', 'lab-meter');
        root.type = 'button';
        const name = el('span', 'lab-meter-name', r.label);
        const value = el('span', 'lab-meter-value');
        const bar = el('span', 'lab-meter-bar');
        const fill = el('span', 'lab-meter-fill');
        bar.appendChild(fill);
        const spark = el('canvas', 'lab-meter-spark');
        spark.width = 60;
        spark.height = 16;
        root.append(name, value, bar, spark);
        const [tab, params] = METER_TARGET[r.id];
        root.onclick = () => ctx.navigate(tab, params);
        meters.appendChild(root);
        m = { root, value, fill, spark };
        meterEls.set(r.id, m);
      }
      const p = r.percent;
      m.value.textContent = p === null ? '–' : `${p.toFixed(0)}%`;
      m.fill.style.width = `${p ?? 0}%`;
      m.root.dataset['level'] = p === null ? 'none' : p >= 85 ? 'bad' : p >= 60 ? 'warn' : 'ok';
      m.root.title = `${r.label}: ${r.detail}\n${r.title}`;
      const g = m.spark.getContext('2d');
      const h = usage.history(r.id);
      if (g) {
        g.clearRect(0, 0, 60, 16);
        g.strokeStyle = getComputedStyle(m.root).getPropertyValue('--meter') || '#2fb3a0';
        g.lineWidth = 1.2;
        g.beginPath();
        h.forEach((v, i) => { const x = (i / Math.max(1, h.length - 1)) * 60, y = 15 - (v / 100) * 14; if (i) g.lineTo(x, y); else g.moveTo(x, y); });
        g.stroke();
      }
    }
  };

  // ---- tabs
  let current: LabTab | null = null;
  const tabButtons = new Map<string, HTMLButtonElement>();
  const groupOf = (id: string): number => { const i = GROUPS.findIndex(([, ids]) => ids.includes(id)); return i < 0 ? GROUPS.length : i; };
  const ordered = [...tabs].sort((a, b) => groupOf(a.id) - groupOf(b.id) || (GROUPS[groupOf(a.id)]?.[1].indexOf(a.id) ?? 0) - (GROUPS[groupOf(b.id)]?.[1].indexOf(b.id) ?? 0));
  let lastGroup = -1;
  ordered.forEach((tab, i) => {
    const g = groupOf(tab.id);
    if (g !== lastGroup) {
      lastGroup = g;
      tabBar.appendChild(el('div', 'lab-tab-group', GROUPS[g]?.[0] ?? 'Outros'));
    }
    const b = button(tabIcon(tab.id), tab.title, `${tab.title}${i < 9 ? ` (Alt+${i + 1})` : ''}`, () => show(tab.id), 'lab-tab');
    b.setAttribute('role', 'tab');
    tabButtons.set(tab.id, b);
    tabBar.appendChild(b);
  });
  function show(id: string, params?: Readonly<Record<string, string>>): void {
    const tab = tabs.find((t) => t.id === id) ?? tabs[0];
    if (!tab) return;
    if (current !== tab) {
      investigator.close();
      current?.unmount?.();
      current = tab;
      for (const [key, b] of tabButtons) { b.classList.toggle('on', key === tab.id); b.setAttribute('aria-selected', String(key === tab.id)); }
      body.replaceChildren();
      body.scrollTop = 0;
      try {
        tab.mount(body);
      } catch (error) {
        console.error(`lab tab ${tab.id} failed to mount`, error);
        body.replaceChildren(el('p', 'lab-bad', `A aba falhou ao abrir: ${String(error)}`));
      }
      tabButtons.get(tab.id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      try { window.localStorage.setItem('roadcraft.lab.tab', tab.id); } catch (error) { console.warn('lab tab not kept', error); }
    }
    if (params && Object.keys(params).length) {
      try { tab.focus?.(params); } catch (error) { console.error(`lab tab ${tab.id} focus failed`, error); }
    }
  }

  // ---- place and size
  function place(): void {
    const s = panel.style;
    s.fontSize = `${kept.font}px`;
    panel.classList.toggle('see-through', kept.see);
    seeThrough.classList.toggle('on', kept.see);
    for (const [mode, b] of modeButtons) b.classList.toggle('on', mode === kept.mode);
    panel.dataset['mode'] = kept.mode;
    const vw = window.innerWidth, vh = window.innerHeight;
    const dock = Math.max(360, Math.min(vw - 40, kept.dockWidth));
    const box = (x: number, y: number, w: number, h: number): void => { s.left = `${x}px`; s.top = `${y}px`; s.width = `${w}px`; s.height = `${h}px`; };
    switch (kept.mode) {
      case 'right': box(vw - dock - 8, 56, dock, vh - 64); break;
      case 'left': box(8, 56, dock, vh - 64); break;
      case 'center': { const w = Math.min(vw - 32, Math.max(720, vw * 0.72)), h = Math.min(vh - 32, Math.max(480, vh * 0.8)); box((vw - w) / 2, (vh - h) / 2, w, h); break; }
      case 'max': box(8, 8, vw - 16, vh - 16); break;
      case 'mini': box(Math.max(8, vw - 760), 56, Math.min(vw - 16, 752), 0); s.height = 'auto'; break;
      case 'free': {
        const w = Math.max(360, Math.min(vw - 16, kept.box.w)), h = Math.max(220, Math.min(vh - 16, kept.box.h));
        box(Math.max(0, Math.min(vw - w, kept.box.x)), Math.max(0, Math.min(vh - 40, kept.box.y)), w, h);
        break;
      }
    }
    panel.classList.toggle('wide', panel.getBoundingClientRect().width >= 700);
  }
  function setMode(mode: Mode): void {
    kept.mode = mode;
    save();
    place();
  }
  const freeFromHere = (): void => {
    const r = panel.getBoundingClientRect();
    kept.box = { x: r.left, y: r.top, w: r.width, h: r.height };
    kept.mode = 'free';
  };
  function resizeFrom(edge: string, e: PointerEvent): void {
    if (kept.mode === 'mini' || e.button !== 0) return;
    e.preventDefault();
    const start = panel.getBoundingClientRect();
    const docked = kept.mode === 'right' || kept.mode === 'left';
    // A docked window keeps its side; only its width follows the inner edge.
    if (docked && !((kept.mode === 'right' && edge === 'w') || (kept.mode === 'left' && edge === 'e'))) freeFromHere();
    const move = (m: PointerEvent): void => {
      const dx = m.clientX - e.clientX, dy = m.clientY - e.clientY;
      if (kept.mode === 'right') kept.dockWidth = start.width - dx;
      else if (kept.mode === 'left') kept.dockWidth = start.width + dx;
      else {
        if (kept.mode !== 'free') freeFromHere();
        let { left: x, top: y, width: w, height: h } = start;
        if (edge.includes('e')) w = start.width + dx;
        if (edge.includes('s')) h = start.height + dy;
        if (edge.includes('w')) { w = start.width - dx; x = start.left + dx; }
        if (edge.includes('n')) { h = start.height - dy; y = start.top + dy; }
        kept.box = { x, y, w: Math.max(360, w), h: Math.max(220, h) };
      }
      place();
    };
    const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); save(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  // Dragged by its head (not by its meters or buttons): the window comes free.
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target !== head && e.target !== title && e.target !== meters)) return;
    if (kept.mode === 'max') return;
    const r = panel.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (m: PointerEvent): void => {
      if (kept.mode !== 'free' && kept.mode !== 'mini') freeFromHere();
      kept.box = { ...kept.box, x: m.clientX - dx, y: m.clientY - dy };
      if (kept.mode === 'mini') { panel.style.left = `${kept.box.x}px`; panel.style.top = `${kept.box.y}px`; } else place();
    };
    const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); save(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  head.addEventListener('dblclick', (e) => { if (e.target === head || e.target === title) setMode(kept.mode === 'max' ? 'right' : 'max'); });
  window.addEventListener('resize', () => { if (!panel.hidden) place(); });
  panel.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey) return;
    const i = Number(e.key) - 1;
    if (Number.isInteger(i) && i >= 0 && i < ordered.length) { e.preventDefault(); show(ordered[i]!.id); }
  });

  // ---- the refresh while open
  let timer: number | null = null;
  const tick = (): void => {
    drawMeters();
    const events = ctx.events();
    const last = events[events.length - 1];
    const recording = (window as unknown as { __labRecorder?: { recording?: boolean } }).__labRecorder?.recording === true;
    statusText.replaceChildren(
      ...(recording ? [el('span', 'lab-rec', '● gravando')] : []),
      el('span', 'lab-muted', `${events.length} eventos`),
      ...(last ? [el('span', '', `último: ${last.detail}`)] : []),
    );
    if (kept.mode === 'mini') return;
    try {
      current?.refresh?.();
    } catch (error) {
      console.error('lab tab refresh failed', error);
    }
  };

  const win: LabWindow = {
    investigate(subject) {
      if (panel.hidden) win.open();
      investigator.open(subject.from || !current ? subject : { ...subject, from: current.title });
    },
    get isOpen() { return !panel.hidden; },
    get current() { return current?.id ?? null; },
    open(id, params) {
      const wasOpen = !panel.hidden;
      panel.hidden = false;
      place();
      let keptTab: string | null = null;
      try { keptTab = window.localStorage.getItem('roadcraft.lab.tab'); } catch (error) { console.warn('lab tab not read', error); }
      if (kept.mode === 'mini' && id) setMode('right');
      show(id ?? current?.id ?? keptTab ?? tabs[0]?.id ?? '', params);
      timer ??= window.setInterval(tick, LAB_REFRESH_MS);
      tick();
      if (!wasOpen) ctx.emit('lab.open', 'laboratório aberto');
    },
    close() {
      if (panel.hidden) return false;
      panel.hidden = true;
      current?.unmount?.();
      current = null;
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      return true;
    },
  };
  return win;
}

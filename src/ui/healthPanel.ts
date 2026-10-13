import type { HealthEntry, HealthLog } from '@core/health';
import { t } from './i18n';

/**
 * The game's health in the interface: a button in the top bar whose dot is
 * green, amber or red (nothing wrong / a long frame / something broke, in the
 * last 30 s), and a panel (the button or F9) with three tabs - what broke or
 * was slow (`core/health.ts`), what changed in the world (`world/changes.ts`)
 * and the game's state (`core/gameState.ts`) - each with the cause. Tabs as
 * WAI-ARIA's pattern: `tablist`/`tab`/`tabpanel`, arrows move between them,
 * activation on focus (the panels are already built).
 *
 * No scroll: each tab shows the latest rows; "copy" puts the whole log on
 * the clipboard for a report.
 */
export interface HealthPanelSources {
  readonly log: HealthLog;
  /** The world's latest changes, newest first, as lines. */
  readonly world: (n: number) => readonly string[];
  /**
   * The game's state now (short lines, in two columns), lines too long for a
   * column (`wide`, the whole width: the GPU's time and name), and its latest
   * changes, newest first.
   */
  readonly state: (n: number) => { readonly now: readonly string[]; readonly wide?: readonly string[]; readonly changes: readonly string[] };
}

const ROWS = 7;
type Tab = 'health' | 'world' | 'state';
const TABS: readonly Tab[] = ['health', 'world', 'state'];

const STYLE = `
.health-btn { position: relative; }
.health-dot { position: absolute; right: 4px; top: 4px; width: 8px; height: 8px; border-radius: 50%; background: var(--v-accent, #4fe0bf); box-shadow: 0 0 0 2px var(--v-bg-solid, #10191b); }
.health-btn[data-status="slow"] .health-dot { background: var(--accent-2, #ffc864); }
.health-btn[data-status="broken"] .health-dot { background: var(--v-danger, #ff6f61); }
.health-pop { position: fixed; z-index: 60; width: min(520px, calc(100vw - 24px)); background: var(--v-bg, rgba(14,22,24,.92)); color: var(--v-text, #eef4f2);
  border: 1px solid var(--v-line, rgba(255,255,255,.1)); border-radius: var(--v-r, 12px); box-shadow: var(--v-shadow); padding: 10px; font: 12px/1.35 Inter, ui-sans-serif, system-ui, sans-serif; backdrop-filter: blur(8px); }
.health-pop[hidden] { display: none; }
.health-head { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; }
.health-tab { background: var(--v-raise, rgba(255,255,255,.05)); color: var(--v-muted, #a3b4b0); border: 1px solid transparent; border-radius: var(--v-r-s, 8px); padding: 5px 10px; font: inherit; cursor: pointer; min-height: 28px; }
.health-tab[aria-selected="true"] { color: var(--v-accent-ink, #062520); background: var(--v-accent, #4fe0bf); }
.health-tab:focus-visible, .health-copy:focus-visible, .health-row:focus-visible { outline: 2px solid var(--v-accent, #4fe0bf); outline-offset: 1px; }
.health-copy { margin-left: auto; background: var(--v-raise, rgba(255,255,255,.05)); color: var(--v-text, #eef4f2); border: 1px solid var(--v-line, rgba(255,255,255,.1)); border-radius: var(--v-r-s, 8px); padding: 5px 10px; font: inherit; cursor: pointer; min-height: 28px; }
.health-summary { color: var(--v-muted, #a3b4b0); margin: 0 0 6px; }
.health-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; }
.health-row { display: grid; grid-template-columns: 10px 58px 1fr auto; gap: 8px; align-items: baseline; padding: 4px 6px; border-radius: 6px; background: var(--v-raise, rgba(255,255,255,.05)); cursor: pointer; text-align: left; color: inherit; border: 0; font: inherit; width: 100%; }
.health-row .sev { width: 8px; height: 8px; border-radius: 50%; align-self: center; background: var(--v-muted, #a3b4b0); }
.health-row[data-severity="broken"] .sev { background: var(--v-danger, #ff6f61); }
.health-row[data-severity="slow"] .sev { background: var(--accent-2, #ffc864); }
.health-row .when { color: var(--v-muted, #a3b4b0); font-variant-numeric: tabular-nums; }
.health-row .what { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.health-row .much { color: var(--v-muted, #a3b4b0); font-variant-numeric: tabular-nums; }
.health-row[data-earlier="true"] { opacity: .6; }
.health-detail { margin: 6px 0 0; padding: 6px 8px; border-radius: 6px; background: rgba(0,0,0,.25); white-space: pre-wrap; word-break: break-word; max-height: 9.5em; overflow: hidden; color: var(--v-text, #eef4f2); }
.health-lines { margin: 0; padding: 0; list-style: none; display: grid; gap: 2px; }
.health-lines.cols { grid-template-columns: 1fr 1fr; }
.health-lines li { padding: 3px 6px; border-radius: 6px; background: var(--v-raise, rgba(255,255,255,.05)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.health-sub { color: var(--v-muted, #a3b4b0); margin: 8px 0 4px; }
`;

const ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2-5 4 10 2-5h6"/></svg>';

/** One formatter for every row (MDN: repeated formatting with the same options should reuse an `Intl.DateTimeFormat`). */
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function clock(entry: HealthEntry): string {
  return CLOCK.format(entry.wall);
}

/** The panel's keys, for the game's keys (`editor/gameKeys.ts`): F9 toggles it, Escape closes it (false: it was closed). */
export function mountHealthPanel(sources: HealthPanelSources): { toggle(): void; close(): boolean } {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'v2-icon health-btn';
  button.innerHTML = `${ICON}<span class="health-dot"></span>`;
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');

  const pop = document.createElement('div');
  pop.className = 'health-pop';
  pop.hidden = true;
  pop.setAttribute('role', 'dialog');

  const head = document.createElement('div');
  head.className = 'health-head';
  const tablist = document.createElement('div');
  tablist.setAttribute('role', 'tablist');
  tablist.style.display = 'flex';
  tablist.style.gap = '6px';
  const tabs = new Map<Tab, HTMLButtonElement>();
  const panels = new Map<Tab, HTMLElement>();
  for (const id of TABS) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'health-tab';
    tab.id = `health-tab-${id}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `health-panel-${id}`);
    tablist.appendChild(tab);
    tabs.set(id, tab);
    const panel = document.createElement('div');
    panel.id = `health-panel-${id}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    panels.set(id, panel);
  }
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'health-copy';
  head.append(tablist, copy);
  pop.append(head, ...panels.values());

  let open: Tab = 'health';
  let picked: number | null = null;

  const label = (): void => {
    button.title = t('health.button');
    button.setAttribute('aria-label', t('health.button'));
    pop.setAttribute('aria-label', t('health.title'));
    tablist.setAttribute('aria-label', t('health.title'));
    for (const [id, tab] of tabs) tab.textContent = t(`health.tab.${id}`);
    copy.textContent = t('health.copy');
  };

  const select = (id: Tab, focus = false): void => {
    open = id;
    for (const [tid, tab] of tabs) {
      const on = tid === id;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      panels.get(tid)!.hidden = !on;
    }
    if (focus) tabs.get(id)!.focus();
    render();
  };
  tablist.addEventListener('keydown', (event) => {
    const at = TABS.indexOf(open);
    let next = -1;
    if (event.key === 'ArrowRight') next = (at + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (at - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    event.preventDefault();
    select(TABS[next]!, true);
  });
  for (const [id, tab] of tabs) tab.addEventListener('click', () => select(id));

  const renderHealth = (panel: HTMLElement): void => {
    const entries = sources.log.latest(ROWS);
    panel.replaceChildren();
    const summary = document.createElement('p');
    summary.className = 'health-summary';
    const status = sources.log.status();
    summary.textContent = t(`health.status.${status}`);
    panel.appendChild(summary);
    if (entries.length === 0) return;
    const list = document.createElement('ul');
    list.className = 'health-list';
    for (const entry of entries) {
      const li = document.createElement('li');
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'health-row';
      row.dataset['severity'] = entry.severity;
      if (entry.earlier) row.dataset['earlier'] = 'true';
      row.setAttribute('aria-expanded', String(picked === entry.serial));
      const much = [entry.ms !== undefined ? `${entry.ms} ms` : '', entry.count > 1 ? `×${entry.count}` : ''].filter(Boolean).join(' ');
      row.innerHTML = '<span class="sev"></span><span class="when"></span><span class="what"></span><span class="much"></span>';
      (row.children[1] as HTMLElement).textContent = entry.earlier ? t('health.earlier') : clock(entry);
      (row.children[2] as HTMLElement).textContent = entry.message;
      (row.children[3] as HTMLElement).textContent = much;
      row.title = entry.message;
      row.addEventListener('click', () => { picked = picked === entry.serial ? null : entry.serial; render(); });
      li.appendChild(row);
      list.appendChild(li);
    }
    panel.appendChild(list);
    const chosen = entries.find((e) => e.serial === picked);
    if (chosen) {
      const detail = document.createElement('pre');
      detail.className = 'health-detail';
      detail.textContent = [
        chosen.context ? `${t('health.context')}: ${chosen.context}` : '',
        chosen.systems?.length ? `${t('health.systems')}: ${chosen.systems.map(([n, ms]) => `${n} ${ms} ms`).join(' · ')}` : '',
        chosen.detail ?? '',
      ].filter(Boolean).join('\n');
      panel.appendChild(detail);
    }
  };

  const renderLines = (panel: HTMLElement, groups: readonly { title?: string; lines: readonly string[]; columns?: boolean }[]): void => {
    panel.replaceChildren();
    for (const group of groups) {
      if (group.title) {
        const sub = document.createElement('p');
        sub.className = 'health-sub';
        sub.textContent = group.title;
        panel.appendChild(sub);
      }
      const list = document.createElement('ul');
      list.className = group.columns ? 'health-lines cols' : 'health-lines';
      if (group.lines.length === 0) {
        const li = document.createElement('li');
        li.textContent = t('health.empty');
        list.appendChild(li);
      }
      for (const line of group.lines) {
        const li = document.createElement('li');
        li.textContent = line;
        li.title = line;
        list.appendChild(li);
      }
      panel.appendChild(list);
    }
  };

  function render(): void {
    if (pop.hidden) return;
    const panel = panels.get(open)!;
    if (open === 'health') renderHealth(panel);
    else if (open === 'world') renderLines(panel, [{ lines: sources.world(ROWS + 2) }]);
    else {
      const state = sources.state(4);
      renderLines(panel, [
        { lines: state.now, columns: true },
        ...(state.wide?.length ? [{ lines: state.wide }] : []),
        { title: t('health.recent'), lines: state.changes },
      ]);
    }
  }

  const place = (): void => {
    const box = button.getBoundingClientRect();
    const width = Math.min(520, window.innerWidth - 24);
    pop.style.top = `${Math.round(box.bottom + 8)}px`;
    pop.style.left = `${Math.round(Math.max(12, Math.min(window.innerWidth - width - 12, box.right - width)))}px`;
  };

  const toggle = (): void => {
    pop.hidden = !pop.hidden;
    button.setAttribute('aria-expanded', String(!pop.hidden));
    if (!pop.hidden) { label(); place(); select(open); }
  };
  button.addEventListener('click', toggle);
  copy.addEventListener('click', () => {
    const text = JSON.stringify({ health: sources.log.latest(256), world: sources.world(60), state: sources.state(40) }, null, 1);
    void navigator.clipboard?.writeText(text).then(() => { copy.textContent = t('health.copied'); setTimeout(label, 1500); }, () => {});
  });
  // F9 and Escape come through the game's keys (`editor/gameKeys.ts`): a
  // listener of its own here closed the panel AND let the same Escape put
  // the tool down.
  const close = (): boolean => {
    if (pop.hidden) return false;
    pop.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    return true;
  };
  window.addEventListener('resize', () => { if (!pop.hidden) place(); });

  // In the top bar, before Help; on its own in the corner without the v2 interface.
  const mount = (): void => {
    const actions = document.querySelector('.v2-actions');
    const help = actions ? [...actions.querySelectorAll('button')].find((b) => /help|ajuda/i.test(b.getAttribute('aria-label') ?? b.title ?? '')) : null;
    if (actions) actions.insertBefore(button, help ?? null);
    else {
      button.style.position = 'fixed';
      button.style.right = '12px';
      button.style.top = '12px';
      button.style.zIndex = '60';
      document.body.appendChild(button);
    }
    document.body.appendChild(pop);
    label();
  };
  // The top bar is put up after the game's own module has run (`mountShell`):
  // wait for it a moment before taking the corner.
  let tries = 0;
  const wait = (): void => {
    if (document.querySelector('.v2-actions') || tries++ > 40) mount();
    else setTimeout(wait, 50);
  };
  wait();

  // The dot and the open panel follow the log, once a second (nothing to do when it did not change).
  let seen = -1;
  let seenStatus = '';
  setInterval(() => {
    const status = sources.log.status();
    if (status !== seenStatus) { seenStatus = status; button.dataset['status'] = status; }
    if (!pop.hidden && (open !== 'health' || sources.log.changes !== seen)) { seen = sources.log.changes; render(); }
  }, 1000);

  return { toggle, close };
}

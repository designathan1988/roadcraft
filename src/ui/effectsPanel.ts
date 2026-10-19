import { onLanguageChange, t } from './i18n';

/** THE EFFECTS PANEL: every effect of the drawing and every heavy system of the frame switched on or off live, with what the GPU, the CPU and the memory spend beside them (`effectsWiring.ts`). Not modal: the game stays in view while it is open. */

export interface EffectsPanelItem {
  readonly key: string;
  readonly label: string;
  readonly on: boolean;
}

export interface EffectsPanelGroup {
  readonly id: string;
  readonly title: string;
  readonly items: readonly EffectsPanelItem[];
}

export interface EffectsPanelDeps {
  groups(): readonly EffectsPanelGroup[];
  toggle(key: string, on: boolean): void;
  /** Every switch of a group on or off at once. */
  setGroup(id: string, on: boolean): void;
  /** Every switch of every group on: the game as it draws. */
  reset(): void;
  /** The share of the whole resolution drawn, 0..1. */
  resolution(): number;
  setResolution(scale: number): void;
  /** What the frame costs now: a name and its value, each line. */
  stats(): readonly (readonly [string, string])[];
}

export interface EffectsPanel {
  toggle(): void;
  open(): void;
  close(): boolean;
}

const RESOLUTIONS = [1, 0.75, 0.5, 0.25] as const;
/** The readings redrawn this often while the panel is open, ms. */
const STATS_MS = 250;

export function createEffectsPanel(deps: EffectsPanelDeps): EffectsPanel {
  const panel = document.createElement('aside');
  panel.className = 'effects-panel glass';
  panel.setAttribute('aria-labelledby', 'effectsTitle');
  panel.hidden = true;
  document.body.appendChild(panel);
  const statsBox = document.createElement('dl');
  statsBox.className = 'effects-stats';
  let timer: number | null = null;

  const button = (text: string, onClick: () => void, className = 'v2-choice'): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = text;
    b.onclick = () => { onClick(); render(); };
    return b;
  };

  function renderStats(): void {
    const rows: HTMLElement[] = [];
    for (const [name, value] of deps.stats()) {
      const dt = document.createElement('dt');
      dt.textContent = name;
      const dd = document.createElement('dd');
      dd.textContent = value;
      rows.push(dt, dd);
    }
    statsBox.replaceChildren(...rows);
  }

  function render(): void {
    const head = document.createElement('header');
    const title = document.createElement('h2');
    title.id = 'effectsTitle';
    title.textContent = t('fx.title');
    head.append(title, button(t('fx.reset'), deps.reset), button('×', () => { panel.hidden = true; stopStats(); }, 'effects-close'));
    const note = document.createElement('p');
    note.className = 'options-note';
    note.textContent = t('fx.note');

    const resolution = document.createElement('div');
    resolution.className = 'options-row';
    const resolutionName = document.createElement('div');
    resolutionName.className = 'options-name';
    resolutionName.textContent = t('fx.resolution');
    const resolutionChoices = document.createElement('div');
    resolutionChoices.className = 'options-choices';
    const scale = deps.resolution();
    for (const r of RESOLUTIONS) {
      const b = button(`${Math.round(r * 100)}%`, () => deps.setResolution(r), `v2-choice${Math.abs(r - scale) < 1e-3 ? ' on' : ''}`);
      b.setAttribute('aria-pressed', String(Math.abs(r - scale) < 1e-3));
      resolutionChoices.appendChild(b);
    }
    resolution.append(resolutionName, resolutionChoices);

    const groups = deps.groups().map((group) => {
      const box = document.createElement('fieldset');
      box.className = 'effects-group';
      const legend = document.createElement('legend');
      legend.append(group.title, button(t('fx.allOn'), () => deps.setGroup(group.id, true)), button(t('fx.allOff'), () => deps.setGroup(group.id, false)));
      box.appendChild(legend);
      for (const item of group.items) {
        const label = document.createElement('label');
        label.className = 'effects-item';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = item.on;
        check.onchange = () => { deps.toggle(item.key, check.checked); render(); };
        label.append(check, item.label);
        box.appendChild(label);
      }
      return box;
    });
    renderStats();
    panel.replaceChildren(head, note, statsBox, resolution, ...groups);
  }

  function startStats(): void {
    // DO NOT keep reading while closed: the panel's own work out of what it measures.
    timer ??= window.setInterval(renderStats, STATS_MS);
  }
  function stopStats(): void {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
  }

  onLanguageChange(() => { if (!panel.hidden) render(); });
  const effectsPanel: EffectsPanel = {
    open() {
      render();
      panel.hidden = false;
      startStats();
    },
    close() {
      if (panel.hidden) return false;
      panel.hidden = true;
      stopStats();
      return true;
    },
    toggle() {
      if (!effectsPanel.close()) effectsPanel.open();
    },
  };
  return effectsPanel;
}

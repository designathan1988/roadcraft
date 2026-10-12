import { builderIconSvg } from '@ui/builder/icons';
import { t } from '@ui/i18n';

/**
 * The floors of a building seen inside, from the game's own interface: shown
 * while a building is open (two clicks on it), with the floor shown, a floor
 * down, a floor up, and closed again. The builder's workspace had these, but
 * out of the builder a building opened on its ground floor with no way to
 * the bedrooms upstairs or the offices above.
 */
export interface InsideBar {
  show(state: { readonly on: boolean; readonly level: number }): void;
}

const CSS = `
.inside-bar { position: fixed; left: 50%; bottom: 84px; transform: translateX(-50%); z-index: 30;
  display: flex; align-items: center; gap: 4px; padding: 4px 6px; border-radius: 12px;
  background: rgba(22, 28, 34, .92); color: #e8eef2; box-shadow: 0 4px 18px rgba(0,0,0,.35);
  font: 600 13px/1 system-ui, sans-serif; }
.inside-bar[hidden] { display: none; }
.inside-bar button { width: 32px; height: 32px; display: grid; place-items: center; border: 0; border-radius: 8px;
  background: transparent; color: inherit; cursor: pointer; }
.inside-bar button:hover { background: rgba(255,255,255,.1); }
.inside-bar .inside-level { min-width: 64px; text-align: center; }
`;

export function createInsideBar(actions: { down(): void; up(): void; close(): void }): InsideBar {
  if (!document.getElementById('inside-bar-css')) {
    const style = document.createElement('style');
    style.id = 'inside-bar-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const bar = document.createElement('div');
  bar.className = 'inside-bar';
  bar.hidden = true;
  const button = (icon: string, title: string, run: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = icon;
    b.dataset['i18nTitle'] = title;
    b.title = t(title);
    b.onclick = run;
    return b;
  };
  const level = document.createElement('span');
  level.className = 'inside-level';
  const close = button('<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    'inside.close', actions.close);
  bar.append(button(builderIconSvg('floorDown', 16), 'inside.down', actions.down), level,
    button(builderIconSvg('floorUp', 16), 'inside.up', actions.up), close);
  document.body.appendChild(bar);
  return {
    show(s) {
      bar.hidden = !s.on;
      level.textContent = s.level === 0 ? t('inside.ground') : t('inside.floor', { n: s.level });
    },
  };
}

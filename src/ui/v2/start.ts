import { LANGUAGES, language, onLanguageChange, setLanguage, t } from '../i18n';

/** THE TITLE SCREEN: what the player sees first - play on (the map saved, or a blank one), open a map, start a new one, the settings */

export interface StartDeps {
  /** A map was saved in this browser and comes back on "Continue". */
  readonly saved: boolean;
  newMap(): void;
  openMap(): void;
  graphicsOptions(): void;
  about(): void;
}

/** The title screen over the game, gone at the first choice (Enter or Escape: play on). */
export function mountStart(host: HTMLElement, deps: StartDeps): void {
  const screen = document.createElement('div');
  screen.className = 'v2-start';
  screen.setAttribute('role', 'dialog');
  screen.setAttribute('aria-modal', 'true');
  const close = (): void => { screen.remove(); window.removeEventListener('keydown', keys, true); };
  const keys = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  const fill = (): void => {
    screen.replaceChildren();
    const card = document.createElement('div');
    card.className = 'v2-start-card';
    const title = document.createElement('h1');
    title.textContent = 'Roadcraft';
    const tag = document.createElement('p');
    tag.className = 'v2-start-tag';
    tag.textContent = t('start.tagline');
    card.append(title, tag);
    const action = (label: string, run: () => void, primary = false): void => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `v2-start-b${primary ? ' primary' : ''}`;
      b.textContent = label;
      b.onclick = () => { close(); run(); };
      card.appendChild(b);
    };
    action(t(deps.saved ? 'start.continue' : 'start.play'), () => {}, true);
    if (deps.saved) action(t('action.newMap'), deps.newMap);
    action(t('action.openMap'), deps.openMap);
    action(t('menu.graphicsOptions'), deps.graphicsOptions);
    const langs = document.createElement('div');
    langs.className = 'v2-start-langs';
    langs.setAttribute('role', 'group');
    langs.setAttribute('aria-label', t('menu.language'));
    for (const l of LANGUAGES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `v2-start-lang${language() === l.code ? ' on' : ''}`;
      b.textContent = l.label;
      b.setAttribute('aria-pressed', String(language() === l.code));
      b.onclick = () => { if (l.code === 'en' || l.code === 'pt-BR') setLanguage(l.code); };
      langs.appendChild(b);
    }
    card.appendChild(langs);
    const about = document.createElement('button');
    about.type = 'button';
    about.className = 'v2-start-about';
    about.textContent = t('action.about');
    about.onclick = () => { close(); deps.about(); };
    card.appendChild(about);
    screen.appendChild(card);
    (card.querySelector('.primary') as HTMLButtonElement | null)?.focus({ preventScroll: true });
  };
  fill();
  onLanguageChange(() => { if (screen.isConnected) fill(); });
  window.addEventListener('keydown', keys, true);
  host.appendChild(screen);
}

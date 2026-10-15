import { ROAD_KEY_ACTIONS, type RoadKeyAction, bindableKey, keyLabel, resetRoadKeys, roadKey, setRoadKey } from './keys';
import { t } from '../i18n';
import './roads.css';

/**
 * THE ROAD TOOL'S KEYS, in a small panel beside the tool's options
 * (docs/source/VIAS.md V3): each action with its key as a chip; a chip clicked
 * waits for the next key pressed and takes it (Esc gives up), a key the
 * game keeps for itself is refused with the reason, and "Restore" puts the
 * defaults back. The keys live in `editor/roads/keys.ts`.
 */
/** The open panel, and what lets go of its key listener when it closes (MDN, addEventListener `signal`). */
let open: { readonly root: HTMLElement; readonly listening: AbortController } | null = null;

export function closeRoadKeys(): void {
  open?.listening.abort();
  open?.root.remove();
  open = null;
}

export const roadKeysOpen = (): boolean => open !== null;

export function openRoadKeys(anchor?: HTMLElement): void {
  closeRoadKeys();
  const root = document.createElement('section');
  root.className = 'rp-keys';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', t('roadKeys.title'));
  let waiting: RoadKeyAction | null = null;
  let note = '';

  const render = (): void => {
    root.replaceChildren();
    const head = document.createElement('div');
    head.className = 'rp-keys-head';
    const title = document.createElement('span');
    title.className = 'rp-title';
    title.textContent = t('roadKeys.title');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'rp-icon';
    close.setAttribute('aria-label', t('profileEditor.close'));
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    close.onclick = closeRoadKeys;
    head.append(title, close);
    root.append(head);
    for (const action of ROAD_KEY_ACTIONS) {
      const row = document.createElement('div');
      row.className = 'rp-keys-row';
      const label = document.createElement('span');
      label.textContent = t(`roadKeys.${action}`);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `rp-key${waiting === action ? ' waiting' : ''}`;
      chip.dataset['action'] = action;
      chip.textContent = waiting === action ? t('roadKeys.press') : keyLabel(roadKey(action));
      chip.onclick = () => { waiting = waiting === action ? null : action; note = ''; render(); };
      row.append(label, chip);
      root.append(row);
    }
    if (note) {
      const n = document.createElement('div');
      n.className = 'rp-note';
      n.setAttribute('role', 'status');
      n.textContent = note;
      root.append(n);
    }
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'rp-btn';
    reset.dataset['action'] = 'reset';
    reset.textContent = t('roadKeys.reset');
    reset.onclick = () => { resetRoadKeys(); waiting = null; note = ''; render(); };
    root.append(reset);
  };

  // While a chip waits, the next key is its, before the game sees it.
  const onKey = (event: KeyboardEvent): void => {
    if (!waiting) {
      if (event.key === 'Escape') { closeRoadKeys(); event.stopPropagation(); }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') { waiting = null; note = ''; render(); return; }
    if (!bindableKey(event.key)) { note = t('roadKeys.reserved', { key: keyLabel(event.key) }); render(); return; }
    setRoadKey(waiting, event.key);
    waiting = null;
    note = '';
    render();
  };
  // own key listener: while this panel is open the next key is the one being bound, before the game sees it.
  // Removed with the panel (`closeRoadKeys`), not on the next key: a panel opened
  // and closed many times left one listener each until a key was pressed.
  const listening = new AbortController();
  window.addEventListener('keydown', onKey, { capture: true, signal: listening.signal });

  if (anchor) {
    const box = anchor.getBoundingClientRect();
    root.style.left = `${Math.round(Math.min(window.innerWidth - 276, box.right + 10))}px`;
    root.style.bottom = `${Math.round(Math.max(12, window.innerHeight - box.bottom))}px`;
  }
  document.body.append(root);
  open = { root, listening };
  render();
}

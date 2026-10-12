/**
 * Where the keyboard focus came from, for the game's own keys: kept out of
 * `main.ts` because it needs nothing but the DOM.
 */

let tabbing = false;

/**
 * Whether focus was last moved with the keyboard (Tab), not the pointer.
 *
 * `:focus-visible` cannot answer this for a key handler: the moment a key is
 * pressed, the browser starts treating the focused element as keyboard
 * focused, so a button merely clicked with the mouse already matches it by
 * the time the keydown arrives.
 */
export function focusCameFromKeyboard(): boolean {
  return tabbing;
}

/** Starts telling a Tab from a click. Call once. */
export function trackFocusModality(): void {
  window.addEventListener('keydown', (e) => { if (e.key === 'Tab') tabbing = true; }, true);
  window.addEventListener('pointerdown', () => { tabbing = false; }, true);
}

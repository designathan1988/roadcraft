/** WHETHER THE DESKTOP WINDOW IS OUT OF SIGHT: minimized or hidden, as the shell tells it (`desktop/main.cjs`, `preload.cjs`). The shell keeps the page "visible" to the Page Visibility API (`backgroundThrottling: false`, Electron WebPreferences), so `document.hidden` never says it (AST-03). In a browser nothing is told: never hidden. */
export interface DesktopShown {
  /** The window minimized or hidden now. */
  readonly hidden: boolean;
}

/** Listens for the shell's word (a window message from the page's own window); `changed` told each time it turns. */
export function watchDesktopShown(changed: (shown: boolean) => void): DesktopShown {
  const state = { hidden: false };
  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { roadcraftShown?: unknown } | null;
    if (event.source !== window || typeof data !== 'object' || data === null || typeof data.roadcraftShown !== 'boolean') return;
    const hidden = !data.roadcraftShown;
    if (hidden === state.hidden) return;
    state.hidden = hidden;
    changed(!hidden);
  });
  return state;
}

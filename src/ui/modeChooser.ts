/**
 * THE GAME'S TWO MODES, AND THE BUTTON BETWEEN THEM: the original flat map,
 * or the spherical planet (the player, 2026-10-11: "deixar escolher entre o
 * modo plano e esférico ... um botão na barra de ferramentas ... pode alterar
 * a qualquer momento"). They are one game built twice - the planet with
 * `--mode planet` (`__PLANET__`) - each with its own maps under its own
 * storage key (`editor/persistence.ts`): switching never touches the other's,
 * and the map in hand is saved as the page is left (`main.ts` pagehide).
 *
 * Where the other one is: beside this one in the combined build
 * (`npm run build:modos`: `/plano/` and `/planeta/` on one origin, Vite's
 * `base`, so `import.meta.env.BASE_URL` says which), else on this
 * repository's development server, 5300 (`VITE_FLAT_URL` / `VITE_PLANET_URL` to
 * point elsewhere). Never the old ports: 5175-5178 hold the player's maps, and
 * a game opened there may migrate and rewrite them (docs/PROBLEMS.md R6).
 */
export type GameMode = 'flat' | 'planet';

export const CURRENT_MODE: GameMode = __PLANET__ ? 'planet' : 'flat';
export const OTHER_MODE: GameMode = CURRENT_MODE === 'planet' ? 'flat' : 'planet';

/** The mode last played, for the combined build's front page (`scripts/build-modes.mjs`). */
const LAST_KEY = 'roadcraft.mode.v1';
/** The mode a switch arrives with (another origin has its own storage); dropped from the address on arrival. */
const ARRIVED_PARAM = 'modo';

/** The address of `mode`'s game. */
export function modeUrl(mode: GameMode): string {
  const base = import.meta.env.BASE_URL;
  const path = mode === 'flat' ? 'plano' : 'planeta';
  if (base.endsWith('/plano/') || base.endsWith('/planeta/')) return `../${path}/?${ARRIVED_PARAM}=${path}`;
  const env = (mode === 'flat' ? import.meta.env['VITE_FLAT_URL'] : import.meta.env['VITE_PLANET_URL']) as string | undefined;
  const url = env || 'http://127.0.0.1:5300/';
  return `${url}${url.includes('?') ? '&' : '?'}${ARRIVED_PARAM}=${path}`;
}

function remember(mode: GameMode): void {
  try { localStorage.setItem(LAST_KEY, mode); } catch { /* the front page opens the planet */ }
}

/** On opening: this mode is the one last played, and a switch's `?modo=` leaves the address. */
export function settleMode(): void {
  remember(CURRENT_MODE);
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has(ARRIVED_PARAM)) return;
    url.searchParams.delete(ARRIVED_PARAM);
    history.replaceState(history.state, '', url.toString());
  } catch { /* no address to tidy */ }
}

/**
 * ONE WORLD, TWO VIEWS (the player, 2026-10-11): in the planet build the flat
 * map is the same world drawn flat (`render/isoViewport.ts` `setFlatView`),
 * switched in place - the same document, the same simulation, nothing
 * reloaded. Wired by the game (`main.ts`); the flat build still goes to the
 * other page until its maps move into the one world.
 */
export interface ViewSwitch {
  flat(): boolean;
  set(flat: boolean): void;
}
let viewSwitch: ViewSwitch | null = null;
export function registerViewSwitch(s: ViewSwitch): void {
  viewSwitch = s;
}
/** The view last chosen in the planet build (`roadcraft.view.v1`). */
const VIEW_KEY = 'roadcraft.view.v1';
export function savedFlatView(): boolean {
  try { return localStorage.getItem(VIEW_KEY) === 'flat'; } catch { return false; }
}
/** The view the button goes to now: the planet's, or the flat one. */
export function nextView(): GameMode {
  return viewSwitch ? (viewSwitch.flat() ? 'planet' : 'flat') : OTHER_MODE;
}

/** Goes to the other mode, now (the map in hand is saved as the page is left), or turns the one world's view. */
export function switchMode(): void {
  if (viewSwitch) {
    const flat = !viewSwitch.flat();
    viewSwitch.set(flat);
    try { localStorage.setItem(VIEW_KEY, flat ? 'flat' : 'planet'); } catch { /* the planet's view next time */ }
    return;
  }
  remember(OTHER_MODE);
  location.href = modeUrl(OTHER_MODE);
}

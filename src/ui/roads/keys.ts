import { CameraMotion } from '@view/cameraMotion';
import { identityMemo } from '@core/identityMemo';

/** THE ROAD TOOL'S KEYS, rebindable (read by `main.ts`) */
export type RoadKeyAction = 'heightUp' | 'heightDown' | 'alignment';
export const ROAD_KEY_ACTIONS: readonly RoadKeyAction[] = ['heightUp', 'heightDown', 'alignment'];

const DEFAULTS: Readonly<Record<RoadKeyAction, string>> = { heightUp: 'PageUp', heightDown: 'PageDown', alignment: 'v' };
const STORAGE_KEY = 'roadcraft.roadKeys';

/** Keys the game keeps for itself: not given to the road tool. */
const RESERVED: ReadonlySet<string> = new Set(['Escape', 'Enter', 'Tab', ' ', 'Delete', 'Backspace', 'Shift', 'Control', 'Alt', 'Meta', 'F7', 'F8', 'F9',
  'u', 'm', 'x', 'b', 'c', 't', 'i', 'p', 'g', 'f', 'z', 'h', 'o', 'Home',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0']);

/** The `KeyboardEvent.code`s that type a key on a US keyboard: the camera's keys are codes */
const CODES_OF_KEY: Readonly<Record<string, readonly string[]>> = {
  '=': ['Equal'], '+': ['Equal', 'NumpadAdd'], '-': ['Minus', 'NumpadSubtract'], '_': ['Minus'],
};
const codesOfKey = (key: string): readonly string[] =>
  CODES_OF_KEY[key] ?? (/^[a-z]$/.test(key) ? [`Key${key.toUpperCase()}`] : /^\d$/.test(key) ? [`Digit${key}`, `Numpad${key}`] : [key]);
/** Page Up and Page Down tilt the camera, and are the road's own raise and lower by default */
const lentByTheCamera = (key: string): boolean => key === 'PageUp' || key === 'PageDown';
/** DO NOT list the camera's keys here by hand. */
function cameraKey(key: string): boolean {
  return !lentByTheCamera(key) && codesOfKey(key).some((code) => CameraMotion.owns(code));
}
const reserved = (key: string): boolean => RESERVED.has(key) || cameraKey(key);

/** A key as stored: letters lower case, everything else as `KeyboardEvent.key` names it. */
function normaliseKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

let bindings: Record<RoadKeyAction, string> = load();
const listeners = new Set<() => void>();

function load(): Record<RoadKeyAction, string> {
  const out = { ...DEFAULTS };
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? 'null') as unknown;
    if (raw && typeof raw === 'object') {
      for (const action of ROAD_KEY_ACTIONS) {
        const key = (raw as Record<string, unknown>)[action];
        if (typeof key === 'string' && key && !reserved(normaliseKey(key))) out[action] = normaliseKey(key);
      }
    }
  } catch { /* a broken or blocked store: the defaults */ }
  // Two actions on one key (a hand-edited store): the defaults.
  return new Set(Object.values(out)).size === ROAD_KEY_ACTIONS.length ? out : { ...DEFAULTS };
}

function save(): void {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(bindings)); } catch { /* kept for this session */ }
  for (const listener of listeners) listener();
}

export function roadKey(action: RoadKeyAction): string {
  return bindings[action];
}

/** Whether `key` may be given to a road action. */
export function bindableKey(key: string): boolean {
  return !reserved(normaliseKey(key));
}

/** Gives `key` to `action`; the action that had it takes `action`'s old key. False for a reserved key. */
export function setRoadKey(action: RoadKeyAction, key: string): boolean {
  const k = normaliseKey(key);
  if (!bindableKey(k)) return false;
  const other = ROAD_KEY_ACTIONS.find((a) => a !== action && bindings[a] === k);
  const next = { ...bindings };
  if (other) next[other] = bindings[action];
  next[action] = k;
  bindings = next;
  save();
  return true;
}

export function resetRoadKeys(): void {
  bindings = { ...DEFAULTS };
  save();
}

/** The road action a key press asks for, or null. */
export function roadKeyAction(key: string): RoadKeyAction | null {
  const k = normaliseKey(key);
  return ROAD_KEY_ACTIONS.find((a) => bindings[a] === k) ?? null;
}

export function onRoadKeysChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A key as the interface writes it: "Page Up", "V", "F2". */
export function keyLabel(key: string, short = false): string {
  const named: Record<string, string> = short
    ? { PageUp: 'PgUp', PageDown: 'PgDn', Insert: 'Ins', End: 'End' }
    : { PageUp: 'Page Up', PageDown: 'Page Down', Insert: 'Insert', End: 'End' };
  return named[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/** The keys as placeholders for the interface's sentences (`{heightUp}`, `{heightDown}`, `{alignmentKey}`). */
export function roadKeyParams(): Record<string, string> {
  // DO NOT make them at each `t()` (each frame a road in hand is drawn): once a set of bindings (replaced whole when one changes).
  return paramsOf(bindings);
}
const paramsOf = identityMemo((b: Record<RoadKeyAction, string>): Record<string, string> =>
  ({ heightUp: keyLabel(b.heightUp), heightDown: keyLabel(b.heightDown), alignmentKey: keyLabel(b.alignment) }));

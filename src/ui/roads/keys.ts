/**
 * THE ROAD TOOL'S KEYS, rebindable (docs/VIAS.md V3; read by `main.ts`): raise and lower the
 * road being drawn, and cycle its plan (straight, curve, freehand). Kept in
 * the browser like the snap choice (`snap.ts`), not in any map. Network
 * Multitool keeps each mode's shortcut in its settings the same way
 * (github.com/MacSergey/NetworkMultitool, `Settings.cs`); a key given to one
 * action is taken from the other that had it, so no key does two things.
 */
export type RoadKeyAction = 'heightUp' | 'heightDown' | 'alignment';
export const ROAD_KEY_ACTIONS: readonly RoadKeyAction[] = ['heightUp', 'heightDown', 'alignment'];

const DEFAULTS: Readonly<Record<RoadKeyAction, string>> = { heightUp: 'PageUp', heightDown: 'PageDown', alignment: 'v' };
const STORAGE_KEY = 'roadcraft.roadKeys';

/** Keys the game keeps for itself: not given to the road tool. */
const RESERVED: ReadonlySet<string> = new Set(['Escape', 'Enter', 'Tab', ' ', 'Delete', 'Backspace', 'Shift', 'Control', 'Alt', 'Meta', 'F8', 'F9',
  'q', 'e', 'u', 'm', 'x', 'b', 'c', 't', 'i', 'p', 'g', 'f', 'z', 'h', 'o', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0']);

/** A key as stored: letters lower case, everything else as `KeyboardEvent.key` names it. */
export function normaliseKey(key: string): string {
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
        if (typeof key === 'string' && key && !RESERVED.has(normaliseKey(key))) out[action] = normaliseKey(key);
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
  return !RESERVED.has(normaliseKey(key));
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
  return { heightUp: keyLabel(bindings.heightUp), heightDown: keyLabel(bindings.heightDown), alignmentKey: keyLabel(bindings.alignment) };
}

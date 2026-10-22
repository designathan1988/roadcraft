import type { Object3D, Vector3 } from 'three';
import type { LabContext } from '../labTypes';

/** THE INSPECTOR'S STATE: what is selected (the 3D object hit, the game's entity under it, everything else the ray met), told to the tabs; and the log of live edits, each undone alone or all together. */

/** The game's own thing under the cursor, by its id in the document or the simulation. */
export type EntityRef =
  | { readonly kind: 'building'; readonly id: number }
  | { readonly kind: 'segment'; readonly id: number; readonly s?: number }
  | { readonly kind: 'node'; readonly id: number }
  | { readonly kind: 'vehicle'; readonly id: number }
  | { readonly kind: 'person'; readonly id: number }
  | { readonly kind: 'terrain'; readonly x: number; readonly y: number };

/** A 3D object the ray met: by its triangles (`exact`), or only by its bounds (its arrays let go to the GPU, or posed in its shader). */
export interface Hit {
  readonly object: Object3D;
  readonly distance: number;
  /** Three's world coordinates (x, height, -y). */
  readonly point: Vector3 | null;
  readonly instanceId: number | null;
  readonly batchId: number | null;
  readonly exact: boolean;
}

export interface Selection {
  readonly object: Object3D | null;
  readonly instanceId: number | null;
  readonly batchId: number | null;
  readonly point: Vector3 | null;
  readonly exact: boolean;
  readonly entity: EntityRef | null;
  /** The other entities found under the same pixel (a building behind a tree, the road under a car). */
  readonly entities: readonly EntityRef[];
  readonly hits: readonly Hit[];
  /** How it was chosen. */
  readonly via: 'pick' | 'scene' | 'console';
}

/** One live edit: undone alone (`undo`), described for the report. */
export interface EditEntry {
  readonly id: number;
  readonly t: number;
  readonly kind: string;
  readonly target: string;
  readonly key: string;
  value: string;
  readonly was: string;
  undo(): void;
}

export interface InspectorState {
  readonly ctx: LabContext;
  readonly selection: Selection | null;
  select(selection: Selection | null): void;
  /** Every selection from now on; the call returned stops it. */
  onSelect(listener: (selection: Selection | null) => void): () => void;
  readonly edits: EditLog;
}

export interface SetOptions {
  /** `edit.<kind>`: object, material, texture, uniform, geometry... */
  readonly kind: string;
  /** The object edited as the log names it. */
  readonly target: string;
  /** After each set and after its undo (a material's `needsUpdate`, a texture's). */
  readonly after?: () => void;
}

export interface EditLog {
  list(): readonly EditEntry[];
  /** `holder[key] = value` (a Color, a Vector copied into the one held), its first value kept for the undo; the same key set again is one entry. */
  set(holder: object, key: string, value: unknown, options: SetOptions): void;
  /** An edit made by hand, with its own undo (isolate, hide). */
  record(kind: string, target: string, key: string, value: string, undo: () => void): void;
  undo(id: number): void;
  undoAll(): void;
  /** Told after every edit and undo. */
  onChange(listener: () => void): () => void;
}

interface Copyable { copy(from: unknown): unknown; clone(): unknown }
/** A value edited in place (a colour, a vector): never a texture or a material, which are swapped whole. */
const copyable = (v: unknown): v is Copyable => {
  if (!v || typeof v !== 'object') return false;
  const o = v as { isColor?: boolean; isVector2?: boolean; isVector3?: boolean; isVector4?: boolean; isEuler?: boolean; isQuaternion?: boolean };
  return !!(o.isColor || o.isVector2 || o.isVector3 || o.isVector4 || o.isEuler || o.isQuaternion);
};

/** A value as the log shows it. */
export function shown(v: unknown): string {
  if (v && typeof v === 'object') {
    const o = v as { isColor?: boolean; getHexString?: () => string; isVector2?: boolean; isVector3?: boolean; isVector4?: boolean; toArray?: () => number[]; isTexture?: boolean; name?: string; uuid?: string };
    if (o.isColor && o.getHexString) return `#${o.getHexString()}`;
    if ((o.isVector2 || o.isVector3 || o.isVector4) && o.toArray) return `(${o.toArray().map((n) => Math.round(n * 1000) / 1000).join(', ')})`;
    if (o.isTexture) return `textura "${o.name ?? ''}" ${o.uuid?.slice(0, 8) ?? ''}`;
  }
  if (typeof v === 'number') return String(Math.round(v * 10000) / 10000);
  return String(v);
}

export function createEditLog(ctx: LabContext): EditLog {
  const entries: EditEntry[] = [];
  const listeners: (() => void)[] = [];
  const ids = new WeakMap<object, number>();
  let nextId = 1;
  let nextObject = 1;
  const told = (): void => { for (const l of listeners) l(); ctx.requestDraw(); };
  const keyOf = (holder: object, key: string): string => {
    if (!ids.has(holder)) ids.set(holder, nextObject++);
    return `${ids.get(holder)}.${key}`;
  };
  const keys = new Map<string, EditEntry>();

  const remove = (entry: EditEntry): void => {
    const i = entries.indexOf(entry);
    if (i >= 0) entries.splice(i, 1);
    for (const [k, e] of keys) if (e === entry) keys.delete(k);
  };
  const log: EditLog = {
    list: () => entries,
    set(holder, key, value, options) {
      const record = holder as Record<string, unknown>;
      const k = keyOf(holder, key);
      const now = record[key];
      if (!keys.has(k)) {
        const original = copyable(now) ? now.clone() : now;
        const entry: EditEntry = {
          id: nextId++, t: performance.now(), kind: options.kind, target: options.target, key, value: '', was: shown(original),
          undo() {
            const held = record[key];
            if (copyable(held) && copyable(original)) held.copy(original);
            else record[key] = original;
            options.after?.();
            ctx.emit(`edit.undo`, `${options.target}.${key} = ${shown(original)} (desfeito)`, { target: options.target, key });
          },
        };
        keys.set(k, entry);
        entries.push(entry);
      }
      if (copyable(now) && copyable(value)) now.copy(value);
      else record[key] = value;
      options.after?.();
      const entry = keys.get(k)!;
      entry.value = shown(value);
      ctx.emit(`edit.${options.kind}`, `${options.target}.${key} = ${entry.value}`, { target: options.target, key, value: entry.value, was: entry.was });
      told();
    },
    record(kind, target, key, value, undo) {
      const entry: EditEntry = { id: nextId++, t: performance.now(), kind, target, key, value, was: '', undo };
      entries.push(entry);
      ctx.emit(`edit.${kind}`, `${target}: ${key} ${value}`, { target, key, value });
      told();
    },
    undo(id) {
      const entry = entries.find((e) => e.id === id);
      if (!entry) return;
      entry.undo();
      remove(entry);
      told();
    },
    undoAll() {
      for (const entry of [...entries].reverse()) {
        try {
          entry.undo();
        } catch (error) {
          console.error('lab inspector: undo failed', entry, error);
        }
      }
      entries.length = 0;
      keys.clear();
      ctx.emit('edit.restore', 'todas as edições do inspetor desfeitas');
      told();
    },
    onChange(listener) {
      listeners.push(listener);
      return () => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1); };
    },
  };
  return log;
}

export function createInspectorState(ctx: LabContext): InspectorState {
  const listeners: ((selection: Selection | null) => void)[] = [];
  let selection: Selection | null = null;
  const edits = createEditLog(ctx);
  return {
    ctx,
    get selection() { return selection; },
    select(next) {
      selection = next;
      const name = next?.object ? `${next.object.type} "${next.object.name}"` : 'nada';
      ctx.emit('inspector.select', `inspetor: ${name}${next?.entity ? ` (${next.entity.kind})` : ''}`);
      for (const l of [...listeners]) {
        try {
          l(next);
        } catch (error) {
          console.error('lab inspector: selection listener failed', error);
        }
      }
    },
    onSelect(listener) {
      listeners.push(listener);
      return () => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1); };
    },
    edits,
  };
}

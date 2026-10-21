import { BUILDING_SWITCHES, LAYER_SWITCHES, LIGHT_SWITCHES, POST_SWITCHES } from '@render/effectSwitches';
import type { LabContext } from '../labTypes';

/** WHAT THE A/B SWEEP CAN FLIP: every switch of the effects panel (`effectsWiring.ts` snapshot, set with `setMany`) and every optimisation
 *  the optimisations' area exposes (`window.__labOpt`, when there). Each item knows its value now, the value it is flipped to and how to set it. */

export interface SweepItem {
  /** `switch.<key>` or `opt.<id>`. */
  readonly id: string;
  readonly label: string;
  readonly group: string;
  get(): unknown;
  /** The value the B window measures, from the value now (a boolean reversed; a choice the next one); null: not flippable. */
  flipped(now: unknown): unknown;
  set(value: unknown): void;
}

/** The optimisations' area's surface (another area's file: read defensively, any shape it gives). */
interface LabOptApi {
  list(): unknown;
  get(id: string): unknown;
  set(id: string, value: unknown): void;
  reset?(): void;
}
interface LabOptEntry { id: string; label?: string; title?: string; group?: string; values?: unknown[]; choices?: unknown[]; options?: unknown[]; value?: unknown }

export const labOpt = (): LabOptApi | null => {
  const api = (window as unknown as { __labOpt?: Partial<LabOptApi> }).__labOpt;
  return api && typeof api.list === 'function' && typeof api.get === 'function' && typeof api.set === 'function' ? (api as LabOptApi) : null;
};

/** The groups of the switches, as the panel shows them (`effectsWiring.ts` GROUPS). */
const SWITCH_GROUPS: readonly (readonly [string, readonly string[]])[] = [
  ['post', POST_SWITCHES], ['light', LIGHT_SWITCHES], ['layers', LAYER_SWITCHES], ['buildings', BUILDING_SWITCHES],
  ['cpu', ['simulation', 'traffic', 'pedestrians', 'growth', 'onDemand']],
];
/** The buildings' settings of several values: B is the cheapest of them (`effectsWiring.ts` BUILDING_CHOICES). */
const CHOICE_B: Readonly<Record<string, { snapshotKey: string; b: string | number; a: string | number }>> = {
  bMaterial: { snapshotKey: 'buildings.material', b: 'basic', a: 'normal' },
  bTriangles: { snapshotKey: 'buildings.triangles', b: 0.25, a: 1 },
  bDetailMemory: { snapshotKey: 'buildings.detailMemoryMB', b: 128, a: -1 },
};
/** Left out: they change what is measured, not what it costs (the loop on demand: a frame every refresh is the measure itself). */
const NOT_SWEPT: readonly string[] = ['onDemand', 'simulation'];

function choiceOf(entry: LabOptEntry): unknown[] | null {
  const list = entry.values ?? entry.choices ?? entry.options;
  if (!Array.isArray(list) || list.length < 2) return null;
  return list.map((v) => (v && typeof v === 'object' && 'value' in v ? (v as { value: unknown }).value : v));
}

export function sweepItems(ctx: LabContext): SweepItem[] {
  const items: SweepItem[] = [];
  const snap = (): Readonly<Record<string, unknown>> => ctx.effects.snapshot();
  for (const [group, keys] of SWITCH_GROUPS) {
    for (const key of keys) {
      if (NOT_SWEPT.includes(key)) continue;
      items.push({
        id: `switch.${key}`, label: key, group: `switch: ${group}`,
        get: () => snap()[key],
        flipped: (now) => (typeof now === 'boolean' ? !now : null),
        set: (value) => { if (typeof value === 'boolean') ctx.effects.setMany({ [key]: value }); },
      });
    }
  }
  for (const [key, c] of Object.entries(CHOICE_B)) {
    items.push({
      id: `switch.${key}`, label: key, group: 'switch: buildings',
      get: () => snap()[c.snapshotKey],
      flipped: (now) => (now === c.b ? c.a : c.b),
      set: (value) => { if (typeof value === 'string' || typeof value === 'number') ctx.effects.setMany({ [key]: value }); },
    });
  }
  items.push({
    id: 'switch.resolution', label: 'resolution', group: 'switch: resolution',
    get: () => snap()['resolution'],
    flipped: (now) => (now === 0.5 ? 1 : 0.5),
    set: (value) => { if (typeof value === 'number') ctx.effects.setMany({ resolution: value }); },
  });
  const opt = labOpt();
  if (opt) {
    let list: unknown = [];
    try { list = opt.list(); } catch (error) { console.warn('lab tests: __labOpt.list failed', error); }
    for (const raw of Array.isArray(list) ? list : []) {
      const entry = (typeof raw === 'string' ? { id: raw } : raw) as LabOptEntry;
      if (!entry || typeof entry.id !== 'string') continue;
      const id = entry.id;
      const choices = choiceOf(entry);
      items.push({
        id: `opt.${id}`, label: entry.label ?? entry.title ?? id, group: `optimization${entry.group ? `: ${entry.group}` : ''}`,
        get: () => opt.get(id),
        flipped: (now) => {
          if (typeof now === 'boolean') return !now;
          if (choices) { const i = choices.findIndex((c) => c === now); return choices[(i + 1) % choices.length]; }
          return null;
        },
        set: (value) => opt.set(id, value),
      });
    }
  }
  return items;
}

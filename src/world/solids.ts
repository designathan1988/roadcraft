import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from './doc';
import { BARRIER_SIZE } from './barriers';
import { elementRing, onGround } from './buildings/elements';
import type { BuildingId, ElementKind } from './buildings/types';
import type { PoleId } from './ids';
import { Derived, type DerivedWork } from './derived';
import type { LandscapeKind } from './landscape';
import { m } from './units';

/** DO NOT build the list again for the whole map on a revision */
export type Solid =
  | { readonly kind: 'capsule'; readonly a: Vec2; readonly b: Vec2; readonly r: number; readonly box: Box }
  | { readonly kind: 'disc'; readonly c: Vec2; readonly r: number; readonly box: Box };
type Box = readonly [number, number, number, number];

/** Parts of a lot that block at their trunk or post. */
const POST_ELEMENTS: Readonly<Partial<Record<ElementKind, number>>> = { tree: m(0.25), lamp: m(0.12) };
/** The street furniture's reach, by kind (none: walked over). */
const FURNITURE: Readonly<Partial<Record<LandscapeKind, number>>> = {
  tree: m(0.3), shrub: m(0.45), bench: m(0.55), bin: m(0.3), lamp: m(0.15), hydrant: m(0.2),
  postbox: m(0.3), phone: m(0.5), sign: m(0.08), streetname: m(0.08),
};
const POLE = m(0.15);
const CELL = m(16);

export interface Solids {
  /** Every solid whose box comes within `reach` of (x, y). */
  near(x: number, y: number, reach: number): Solid[];
  /** What keeping it up has cost (the spine's ledger). */
  readonly work: DerivedWork;
}

/** A source item's key: its store and its id. */
export type SourceKey = `b${number}` | `r${number}` | `p${number}` | `l${number}`;

const disc = (c: Vec2, r: number): Solid => ({ kind: 'disc', c, r, box: [c.x - r, c.y - r, c.x + r, c.y + r] });
const boxOf = (pts: readonly Vec2[], grow = 0): Box => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return [x0 - grow, y0 - grow, x1 + grow, y1 + grow];
};

/** The solids of one source item now; undefined when it is gone or has none. */
function solidsOfItem(doc: RoadDoc, key: SourceKey): Solid[] | undefined {
  const id = Number(key.slice(1));
  const out: Solid[] = [];
  switch (key[0]) {
    case 'b': {
      const b = doc.buildings.get(id as BuildingId);
      for (const e of b?.elements ?? []) {
        const post = POST_ELEMENTS[e.kind];
        if (post === undefined || !onGround(e)) continue;
        const c = boxOf(elementRing(b!, e));
        out.push(disc({ x: (c[0] + c[2]) / 2, y: (c[1] + c[3]) / 2 }, post));
      }
      break;
    }
    case 'r': {
      const bar = doc.barriers.get(id);
      if (!bar) break;
      const r = m(BARRIER_SIZE[bar.kind].thickness) / 2;
      for (let i = 1; i < bar.points.length; i++) {
        const a = bar.points[i - 1]!, b = bar.points[i]!;
        out.push({ kind: 'capsule', a, b, r, box: boxOf([a, b], r) });
      }
      break;
    }
    case 'p': {
      const p = doc.poles.get(id as PoleId);
      if (p) out.push(disc({ x: p.x, y: p.y }, POLE));
      break;
    }
    case 'l': {
      const item = doc.landscape.get(id);
      const r = item ? FURNITURE[item.kind] : undefined;
      if (item && r !== undefined) out.push(disc({ x: item.x, y: item.y }, r));
      break;
    }
  }
  return out.length ? out : undefined;
}

/** Whether two lists hold the same solids, shape for shape */
const sameSolids = (a: readonly Solid[], b: readonly Solid[]): boolean =>
  a.length === b.length && a.every((s, i) => {
    const t = b[i]!;
    if (s.kind !== t.kind || s.r !== t.r) return false;
    if (s.kind === 'disc') return t.kind === 'disc' && s.c.x === t.c.x && s.c.y === t.c.y;
    return t.kind === 'capsule' && s.a.x === t.a.x && s.a.y === t.a.y && s.b.x === t.b.x && s.b.y === t.b.y;
  });

const PREFIX = { buildings: 'b', barriers: 'r', utilities: 'p', landscape: 'l' } as const;

/** A new solids product with its grid (made from nothing at its first refresh). */
export function createSolids(): { solids: Solids; derived: Derived<RoadDoc, SourceKey, Solid[]> } {
  const cells = new Map<number, Set<Solid>>();
  const cellKey = (i: number, j: number): number => i * 65_536 + j;
  const each = (s: Solid, act: (key: number) => void): void => {
    for (let i = Math.floor(s.box[0] / CELL); i <= Math.floor(s.box[2] / CELL); i++) {
      for (let j = Math.floor(s.box[1] / CELL); j <= Math.floor(s.box[3] / CELL); j++) act(cellKey(i, j));
    }
  };
  const derived = new Derived<RoadDoc, SourceKey, Solid[]>({
    name: 'solids',
    kinds: ['buildings', 'barriers', 'utilities', 'landscape'],
    byId: true,
    /** @rebuild Only when everything changed (`Derived.refresh` with the diary unread): the one walk of the map. */
    *allKeys(doc) {
      for (const b of doc.buildings.all()) yield `b${b.id}`;
      for (const id of doc.barriers.keys()) yield `r${id}`;
      for (const id of doc.poles.keys()) yield `p${id}`;
      for (const id of doc.landscape.keys()) yield `l${id}`;
    },
    dirty(change, out) {
      const prefix = PREFIX[change.kind as keyof typeof PREFIX];
      for (const id of change.ids ?? []) out.add(`${prefix}${id}` as SourceKey);
    },
    compute: (key, doc) => solidsOfItem(doc, key),
    equals: sameSolids,
    changed(_key, before, after) {
      for (const s of before ?? []) each(s, (k) => { const set = cells.get(k)!; set.delete(s); if (set.size === 0) cells.delete(k); });
      for (const s of after ?? []) each(s, (k) => { const set = cells.get(k); if (set) set.add(s); else cells.set(k, new Set([s])); });
    },
  });
  const solids: Solids = {
    near(x, y, reach) {
      const out = new Set<Solid>();
      for (let i = Math.floor((x - reach) / CELL); i <= Math.floor((x + reach) / CELL); i++) {
        for (let j = Math.floor((y - reach) / CELL); j <= Math.floor((y + reach) / CELL); j++) {
          for (const s of cells.get(cellKey(i, j)) ?? []) {
            if (s.box[0] - reach <= x && s.box[2] + reach >= x && s.box[1] - reach <= y && s.box[3] + reach >= y) out.add(s);
          }
        }
      }
      return [...out];
    },
    get work() { return derived.work; },
  };
  return { solids, derived };
}

const known = new WeakMap<RoadDoc, ReturnType<typeof createSolids>>();

/** The document's solids, brought up to date with the diary: the items changed since the last ask, nothing else. */
export function solidsOf(doc: RoadDoc): Solids {
  let made = known.get(doc);
  if (!made) known.set(doc, (made = createSolids()));
  made.derived.refresh(doc);
  return made.solids;
}

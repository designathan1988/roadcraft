import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from './doc';
import { BARRIER_SIZE } from './barriers';
import { elementRing, onGround } from './buildings/elements';
import { solidFootprints } from './buildings/geometry';
import type { ElementKind } from './buildings/types';
import type { LandscapeKind } from './landscape';
import { m } from './units';

/**
 * What a body cannot walk through, on the ground plan, from the document:
 * the one list the player's body is pushed out of (`sim/ambient/play.ts`),
 * so that what stands on the map is solid wherever it came from (the player,
 * 2026-10-06: "identificar sólidos e não atravessar eles").
 *
 * - polygons: each building's walls, and the parts of its lot that stand in
 *   the way (a wall, a fence, a hedge, a pillar, a planter, a bench, bins);
 * - capsules: the walls and fences the player draws (`barriers.ts`), as thick
 *   as each kind is built;
 * - discs: poles, tree trunks and the street furniture on the footways.
 *
 * Built again only when the buildings, the drawn barriers or the footways'
 * furniture change (their revisions); looked up through a grid.
 */
export type Solid =
  | { readonly kind: 'ring'; readonly ring: readonly Vec2[]; readonly box: Box }
  | { readonly kind: 'capsule'; readonly a: Vec2; readonly b: Vec2; readonly r: number; readonly box: Box }
  | { readonly kind: 'disc'; readonly c: Vec2; readonly r: number; readonly box: Box };
type Box = readonly [number, number, number, number];

/** The parts of a lot that stand in the way (lot paving, flowers, drains, gates and stairs are walked over or through). */
const BLOCKING_ELEMENTS: ReadonlySet<ElementKind> = new Set<ElementKind>([
  'wall', 'fence', 'hedge', 'pillar', 'planter', 'bench', 'bin', 'bollard', 'railing', 'rocks', 'shrub',
]);
/** Parts that block at their trunk or post only. */
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
}

const known = new WeakMap<RoadDoc, { key: string; solids: Solids }>();

export function solidsOf(doc: RoadDoc): Solids {
  const key = `${doc.buildings.revision}:${doc.barrierRevision}:${doc.utilityRevision}:${doc.buildings.size}:${doc.landscape.size}:${doc.poles.size}`;
  const hit = known.get(doc);
  if (hit && hit.key === key) return hit.solids;
  const all: Solid[] = [];
  const boxOf = (pts: readonly Vec2[], grow = 0): Box => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    return [x0 - grow, y0 - grow, x1 + grow, y1 + grow];
  };
  const disc = (c: Vec2, r: number): void => { all.push({ kind: 'disc', c, r, box: [c.x - r, c.y - r, c.x + r, c.y + r] }); };
  for (const b of doc.buildings.all()) {
    for (const ring of solidFootprints(b)) all.push({ kind: 'ring', ring, box: boxOf(ring) });
    for (const e of b.elements ?? []) {
      if (!onGround(e)) continue;
      if (BLOCKING_ELEMENTS.has(e.kind)) { const ring = elementRing(b, e); all.push({ kind: 'ring', ring, box: boxOf(ring) }); continue; }
      const post = POST_ELEMENTS[e.kind];
      if (post !== undefined) { const ring = elementRing(b, e); const c = boxOf(ring); disc({ x: (c[0] + c[2]) / 2, y: (c[1] + c[3]) / 2 }, post); }
    }
  }
  for (const bar of doc.barriers.values()) {
    const r = m(BARRIER_SIZE[bar.kind].thickness) / 2;
    for (let i = 1; i < bar.points.length; i++) {
      const a = bar.points[i - 1]!, b = bar.points[i]!;
      all.push({ kind: 'capsule', a, b, r, box: boxOf([a, b], r) });
    }
  }
  for (const p of doc.poles.values()) disc({ x: p.x, y: p.y }, POLE);
  for (const item of doc.landscape.values()) {
    const r = FURNITURE[item.kind];
    if (r !== undefined) disc({ x: item.x, y: item.y }, r);
  }
  const cells = new Map<number, Solid[]>();
  const cellKey = (i: number, j: number): number => i * 65_536 + j;
  for (const s of all) {
    for (let i = Math.floor(s.box[0] / CELL); i <= Math.floor(s.box[2] / CELL); i++) {
      for (let j = Math.floor(s.box[1] / CELL); j <= Math.floor(s.box[3] / CELL); j++) {
        const list = cells.get(cellKey(i, j));
        if (list) list.push(s); else cells.set(cellKey(i, j), [s]);
      }
    }
  }
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
  };
  known.set(doc, { key, solids });
  return solids;
}

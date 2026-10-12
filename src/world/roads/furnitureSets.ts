import type { Vec2 } from '@core/vec2';
import type { SegmentId } from '../ids';
import { type LandscapeItem, type LandscapeKind, plantedMedian, snapLandscape } from '../landscape';
import { travelShift } from '../roadTypes';
import type { Network } from '../network';
import { carriesPedestrians } from '../pedestrianAccess';
import type { RoadSide } from '../roadTypes';
import { BENCH_ZONE, sectionOf, zonesOn } from '../section';
import { FURNITURE_CATALOG, furnitureEntry } from './furnitureCatalog';
import { m } from '../units';

/**
 * THE FURNITURE A NEW ROAD IS BUILT WITH (docs/VIAS.md V7; the player's
 * decision: automatic by default on new roads, the set chosen in the road
 * tool; roads already built never change by themselves).
 *
 * The pieces are ordinary placed items (`RoadDoc.landscape`), put where the
 * landscaping tool would put them (`snapLandscape`: the furnishing zone by
 * the kerb, clear of the crossings and of each other), so the player edits
 * or removes each one as any other and nothing regenerates over it.
 *
 * ABNT NBR 9050:2020, 6.12.3: a footway keeps a clear walking strip ("faixa
 * livre") of at least 1,20 m, furniture going in the service strip by the
 * kerb ("faixa de serviço", 0,70 m recommended): a piece that would leave
 * less than 1,20 m beside it is not put (on the game's 2 m footway, lamps
 * and hydrants go, bins and benches do not). Spacing as Brazilian practice lays a
 * street: a lamp column every 30 m on each side, staggered (NBR 5101 urban
 * lighting, spacing about 3 to 4 times the mounting height of 8-10 m), a
 * street tree every 10 m where the footway is wide enough for its pit, a bin
 * near each corner and every 60 m, a bench every 60 m on wide footways, a
 * hydrant every 100 m (NBR 13714 / fire brigade technical rules: 60-120 m
 * between urban hydrants).
 */
export type FurnitureSet = 'complete' | 'basic' | 'none';
export const FURNITURE_SETS: readonly FurnitureSet[] = ['complete', 'basic', 'none'];
export const isFurnitureSet = (v: unknown): v is FurnitureSet => v === 'complete' || v === 'basic' || v === 'none';

/** NBR 9050 6.12.3: the least clear walking strip. */
export const NBR9050_CLEAR_WALK = m(1.2);

interface Pattern {
  readonly kind: LandscapeKind;
  /** Spacing along the side, world units. */
  readonly every: number;
  /** First station past the corner, world units. */
  readonly first: number;
  /** Only on the right side of a -> b (one a street, as hydrants stand). */
  readonly rightOnly?: true;
}


/** Each set's patterns, from the catalogue (`furnitureCatalog.ts`), in its order. */
const SETS: Readonly<Record<Exclude<FurnitureSet, 'none'>, readonly Pattern[]>> = {
  complete: patternsOf('complete'),
  basic: patternsOf('basic'),
};
function patternsOf(set: 'complete' | 'basic'): Pattern[] {
  return FURNITURE_CATALOG.filter((e) => e.sets.includes(set))
    .map((e) => ({ kind: e.kind, every: e.every, first: e.first, ...(e.rightOnly ? { rightOnly: true as const } : {}) }));
}

/** The cell of the nearby-items grid, world units. */
const CELL = m(40);

export interface FurniturePlacement {
  readonly kind: LandscapeKind;
  readonly at: Vec2;
}

/**
 * The pieces of `set` along the given segments, each where the landscaping
 * tool would accept it among `existing` (and the pieces already chosen).
 * Deterministic: the same roads give the same pieces.
 */
export function furnitureFor(net: Network, segments: Iterable<SegmentId>, set: FurnitureSet, existing: Iterable<LandscapeItem>,
  /** The left side carries a power line whose poles hold the street lights (`editor/roads/powerLine.ts`): no lamp columns there. */
  powerLeft = false,
  /** Street trees, on the footways and down a planted median; the rest of the set without them when false. */
  trees = true): FurniturePlacement[] {
  if (set === 'none') return [];
  const out: FurniturePlacement[] = [];
  // The items already standing, in cells: each street asks only those near it
  // (a generated city lays thousands of pieces at once).
  const grid = new Map<string, LandscapeItem[]>();
  const cellOf = (x: number, y: number): string => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
  const file = (item: LandscapeItem): void => {
    const key = cellOf(item.x, item.y);
    let list = grid.get(key);
    if (!list) grid.set(key, list = []);
    list.push(item);
  };
  for (const item of existing) file(item);
  // The utility poles standing count as lamp columns: nothing is put on them.
  let poleId = -1_000_000;
  for (const pole of net.doc.poles.values()) file({ id: poleId--, kind: 'lamp', x: pole.x, y: pole.y });
  let nextId = -1;
  for (const id of [...segments].sort((a, b) => a - b)) {
    const segment = net.doc.segment(id), ribbon = net.ribbons.get(id);
    if (!segment || !ribbon || !carriesPedestrians(ribbon.road) || ribbon.road.sidewalk <= 0) continue;
    const box = ribbon.full.bbox, pad = ribbon.road.width / 2 + ribbon.road.sidewalk + m(4);
    const items: LandscapeItem[] = [];
    for (let cx = Math.floor((box.minX - pad) / CELL); cx <= Math.floor((box.maxX + pad) / CELL); cx++) {
      for (let cy = Math.floor((box.minY - pad) / CELL); cy <= Math.floor((box.maxY + pad) / CELL); cy++) items.push(...(grid.get(`${cx},${cy}`) ?? []));
    }
    const keep = (item: LandscapeItem): void => { items.push(item); file(item); };
    const line = ribbon.full;
    const section = sectionOf(ribbon.road, segment.direction);
    const startS = net.mouthDistance(id, segment.a);
    const endS = line.length - net.mouthDistance(id, segment.b);
    // A planted median takes the street's trees (a boulevard's row down the
    // middle); the footways then keep theirs clear for the walkers.
    const medianTrees = trees && set === 'complete' && segment.direction === 'both' && plantedMedian(ribbon.road);
    if (medianTrees) {
      const shift = travelShift(ribbon.road);
      for (let s = startS + m(8); s <= endS - m(6); s += m(10)) {
        const f = line.sampleAt(s);
        const snap = snapLandscape(net, items, 'tree', { x: f.p.x + f.n.x * shift, y: f.p.y + f.n.y * shift }, m(0.6));
        if (!snap.ok || !snap.median || snap.median.segment !== id) continue;
        out.push({ kind: 'tree', at: snap.at });
        keep({ id: nextId--, kind: 'tree', x: snap.at.x, y: snap.at.y });
      }
    }
    for (const side of ['right', 'left'] as const satisfies readonly RoadSide[]) {
      const zones = zonesOn(section, side);
      // The footway from the kerb face to its outer edge.
      const footway = Math.max(zones.through.outer, zones.frontage.outer) - zones.furnishing.inner;
      const sign = side === 'left' ? 1 : -1;
      // Into the furnishing zone; `snapLandscape` sets each kind's own depth.
      const depth = (zones.furnishing.inner + zones.furnishing.outer) / 2;
      // The left side staggered half a lamp spacing from the right.
      const stagger = side === 'left' ? m(15) : 0;
      for (const pattern of SETS[set]) {
        if (pattern.rightOnly && side !== 'right') continue;
        if (pattern.kind === 'lamp' && powerLeft && side === 'left') continue;
        if (pattern.kind === 'tree' && (medianTrees || !trees)) continue;
        // NBR 9050: the piece leaves a clear walk of 1,20 m beside it, or it is not put.
        if (footway - (furnitureEntry(pattern.kind)?.depth ?? BENCH_ZONE) < NBR9050_CLEAR_WALK - 1e-6) continue;
        for (let s = startS + pattern.first + (pattern.kind === 'lamp' ? stagger : 0); s <= endS - m(4); s += pattern.every) {
          const f = line.sampleAt(s);
          const at = { x: f.p.x + f.n.x * depth * sign, y: f.p.y + f.n.y * depth * sign };
          const snap = snapLandscape(net, items, pattern.kind, at, m(0.6));
          if (!snap.ok || snap.hit?.segment !== id) continue;
          out.push({ kind: pattern.kind, at: snap.at });
          keep({ id: nextId--, kind: pattern.kind, x: snap.at.x, y: snap.at.y });
        }
      }
    }
  }
  return out;
}

import { m } from '../units';
import type { BuildingUse } from './types';

/**
 * WHAT STANDS ON A FLAT ROOF, chosen and packed per building.
 *
 * Every flat roof of 8 x 8 m or more carried the same set - a water tank, a
 * hatch, two condensers, solar panels, a mast, a dish, two skylights - with
 * only the corner changing among four, and nothing kept one piece out of
 * another (the player, 2026-10-09: "placas solares e caixa d'água azul em
 * TODOS"). Here, as a city builder's prop rules do (CityEngine's `scatter`
 * with per-asset probability, Cities: Skylines' building props by service
 * and level):
 *
 * - a CATALOGUE of roof plant, each kind with how likely it is by the
 *   building's use, its size (storeys, roof area) and its age - an old block
 *   has a TV mast and no solar panels, a new one the other way round; a
 *   works hall has vents and skylights in rows, an office a big air
 *   handler, a tall block its lift room and a concrete water tank;
 * - a SEED per building and roof, so the same building always carries the
 *   same plant and its neighbour other plant;
 * - PACKED on an occupancy grid of the roof inside its parapet, with a
 *   clearance round each piece (maintenance access): a piece that finds no
 *   free place is left out, so no two pieces ever cross.
 *
 * Pure: the renderer draws what this returns (`render/buildings/buildingMesh.ts`).
 * Sizes in world units, the roof's local frame (the volume's).
 */

export type RoofPlantKind =
  | 'tank' | 'tankBox' | 'hatch' | 'condenser' | 'airHandler' | 'solar' | 'mast' | 'dish' | 'skylight' | 'vent' | 'liftRoom' | 'chimney';

export interface RoofPlantItem {
  readonly kind: RoofPlantKind;
  /** The piece's footprint on the roof, local units. */
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  /** How tall it stands over the roof. */
  readonly h: number;
  /** A variant of the kind (a colour, a size of array), 0..3. */
  readonly variant: number;
}

export interface RoofSite {
  /** The building's id and the volume's (the seed). */
  readonly building: number;
  readonly volume: number;
  readonly use: BuildingUse;
  /** Storeys to the roof. */
  readonly storeys: number;
  /** The roof's rectangle, local units. */
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  /** How old it looks, 0 new to 1 old. */
  readonly age: number;
  /** A lift core drawn by the building itself (no machine room to add). */
  readonly hasCore: boolean;
}

interface Kind {
  readonly kind: RoofPlantKind;
  /** Size in metres, before the variant scales it. */
  readonly w: number;
  readonly d: number;
  readonly h: number;
  /** How many may stand on one roof, at most. */
  readonly most: number;
  /** Chance of one (and of each further one), by the site. */
  readonly chance: (s: RoofSite, area: number) => number;
}

const USE = (s: RoofSite, r: number, c: number, i: number): number => (s.use === 'residential' ? r : s.use === 'industrial' ? i : c);

const CATALOGUE: readonly Kind[] = [
  // A lift's machine room on a block tall enough for one.
  { kind: 'liftRoom', w: 2.6, d: 2.6, h: 2.5, most: 1, chance: (s) => (s.storeys >= 4 && !s.hasCore ? 1 : 0) },
  // A concrete water tank on a tall block (a "castelo"); a fibreglass tank on low ones.
  { kind: 'tankBox', w: 3.2, d: 2.4, h: 2.2, most: 1, chance: (s) => (s.storeys >= 6 ? USE(s, 0.7, 0.5, 0.2) : 0) },
  { kind: 'tank', w: 1.9, d: 1.9, h: 1.5, most: 2, chance: (s) => (s.storeys < 6 ? USE(s, 0.75, 0.55, 0.35) : USE(s, 0.25, 0.2, 0.2)) },
  { kind: 'hatch', w: 0.9, d: 0.9, h: 0.45, most: 1, chance: () => 0.9 },
  { kind: 'airHandler', w: 3.4, d: 1.8, h: 1.6, most: 2, chance: (s, a) => (a > 150 ? USE(s, 0.05, 0.55, 0.35) : 0) },
  { kind: 'condenser', w: 0.9, d: 0.8, h: 0.85, most: 6, chance: (s) => USE(s, 0.35, 0.6, 0.3) * (0.6 + 0.6 * (1 - s.age)) },
  { kind: 'solar', w: 4.6, d: 3.4, h: 0.4, most: 3, chance: (s) => USE(s, 0.3, 0.2, 0.45) * (1.3 - s.age) },
  { kind: 'mast', w: 0.6, d: 0.6, h: 3.5, most: 1, chance: (s) => USE(s, 0.45, 0.25, 0.1) * (0.4 + s.age) },
  { kind: 'dish', w: 0.9, d: 0.7, h: 1.2, most: 2, chance: (s) => USE(s, 0.35, 0.2, 0.05) },
  { kind: 'skylight', w: 1.2, d: 1.2, h: 0.25, most: 6, chance: (s) => USE(s, 0.15, 0.25, 0.7) },
  { kind: 'vent', w: 0.7, d: 0.7, h: 0.9, most: 5, chance: (s) => USE(s, 0.1, 0.3, 0.75) },
  { kind: 'chimney', w: 0.9, d: 0.9, h: 4.5, most: 1, chance: (s) => USE(s, 0, 0, 0.3) },
];

/** Grid cell of the packing, and the clear way kept round each piece. */
const CELL = m(0.5);
const CLEAR = m(0.6);
/** The parapet's margin: nothing stands against the roof's edge. */
const EDGE = m(0.8);

/** A small seeded stream (mulberry32): the same roof, the same plant. */
function stream(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function planRoofPlant(site: RoofSite): RoofPlantItem[] {
  const W = site.x1 - site.x0, D = site.y1 - site.y0;
  if (W < m(4) || D < m(4)) return [];
  const rnd = stream(Math.imul(site.building, 2_654_435_761) ^ Math.imul(site.volume + 7, 40_503) ^ 0x5f3759df);
  const area = (W * D) / (m(1) * m(1));
  // The occupancy grid inside the parapet.
  const gx0 = site.x0 + EDGE, gy0 = site.y0 + EDGE;
  const nx = Math.max(0, Math.floor((W - 2 * EDGE) / CELL)), ny = Math.max(0, Math.floor((D - 2 * EDGE) / CELL));
  const used = new Uint8Array(nx * ny);
  const free = (i0: number, j0: number, i1: number, j1: number): boolean => {
    if (i0 < 0 || j0 < 0 || i1 > nx || j1 > ny) return false;
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) if (used[j * nx + i]) return false;
    return true;
  };
  const take = (i0: number, j0: number, i1: number, j1: number): void => {
    for (let j = Math.max(0, j0); j < Math.min(ny, j1); j++) for (let i = Math.max(0, i0); i < Math.min(nx, i1); i++) used[j * nx + i] = 1;
  };
  const clear = Math.ceil(CLEAR / CELL);
  const out: RoofPlantItem[] = [];
  for (const k of CATALOGUE) {
    let p = Math.min(1, k.chance(site, area));
    for (let n = 0; n < k.most && rnd() < p; n++) {
      const variant = Math.floor(rnd() * 4);
      // Arrays and air handlers sized by the roof and the variant; turned a quarter at random.
      const scale = k.kind === 'solar' ? 0.7 + variant * 0.25 : 1;
      const turn = rnd() < 0.5;
      const w = m(k.w * scale), d = m(k.d * (k.kind === 'solar' ? 1 : scale));
      const [pw, pd] = turn && k.kind !== 'solar' ? [d, w] : [w, d];
      const ci = Math.ceil(pw / CELL), cj = Math.ceil(pd / CELL);
      if (ci > nx || cj > ny) break;
      // Tries at random places on the roof.
      let at: [number, number] | null = null;
      for (let t = 0; t < 24 && !at; t++) {
        const i = Math.floor(rnd() * (nx - ci + 1)), j = Math.floor(rnd() * (ny - cj + 1));
        // Its own cells free: every piece placed marks its clear way round it as taken.
        if (free(i, j, i + ci, j + cj)) at = [i, j];
      }
      if (!at) break;
      const [i, j] = at;
      take(i - clear, j - clear, i + ci + clear, j + cj + clear);
      out.push({ kind: k.kind, x0: gx0 + i * CELL, y0: gy0 + j * CELL, x1: gx0 + i * CELL + pw, y1: gy0 + j * CELL + pd, h: m(k.h), variant });
      p *= 0.6;
    }
  }
  return out;
}

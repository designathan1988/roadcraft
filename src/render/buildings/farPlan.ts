import { Rng } from '@core/rng';
import { paintsOf, styleFor } from '@world/buildings/architecture';
import { FLAT_ROOFS, type Finish, type MaterialSpec } from '@world/buildings/materials';
import type { BayComponent } from '@world/buildings/types';
import { CLAY, WORKS_ROOFS } from '@world/buildings/procedural';
import { type TileCharacter, type WholeMapOptions, gatesOf, mix, planWholeMap } from '@world/cityGen/wholeMap';
import { LOT_DEPTH } from '@world/lots';
import { TILE, tileIJ, tileKey } from '@world/tiles';
import { m } from '@world/units';
import type { ZoneDensity, ZoneUse } from '@world/zones';
import type { GroundReaders } from '../sharedGround';
import { AGGREGATE, nodeSide } from './farGrid';
import { BURY, GLASS_SHARE, rgbOf } from './massing';

/** THE BUILDINGS OF THE TILES NEVER MADE, FROM THE GENERATOR'S PLAN ALONE (CLAUDE.md "Streaming world"): only the tiles near the camera are generated, the far levels draw the rest of the world from what the plan says stands there (`cityGen/wholeMap.ts` `heatAt`, `zoneAt`, `tile`) */
/** Per square of a level, the share of it built and the height the growth would build there (`world/buildings/procedural.ts` `madeToMeasure`), as the boxes of a level past the plates (`farTiles.ts` `aggregateBoxes`); a pure function of the seed and the place, so baked once per world */

type Tone = Readonly<Record<Finish, readonly [number, number, number]>>;
type StyleKind = Parameters<typeof styleFor>[0];

/** What the growth builds on a lot of a zone's use and density (`procedural.ts` `madeToMeasure`, `editor/lotPlan.ts` `planLot`) */
interface BuildKind {
  /** Storeys, least and most (podium included); `tall` of the towers a landmark of `tallStoreys`. */
  readonly storeys: readonly [number, number];
  readonly tall: number;
  readonly tallStoreys: readonly [number, number];
  /** The ground storey's height and the others', m, least and most (`Model.heights`). */
  readonly ground: readonly [number, number];
  readonly storey: readonly [number, number];
  /** Share of its lot the blocks cover: the front, sides and back `planLot` leaves open. */
  readonly cover: number;
  readonly style: StyleKind;
  /** Its roofs, and half a pitched roof's rise (`emitBoxes` counts half), m. */
  readonly roofs: readonly MaterialSpec[];
  readonly rise: number;
  /** Commerce and industry: offices lit at night (`emitMassing` `office`). */
  readonly office: boolean;
}

const WORKS: readonly MaterialSpec[] = WORKS_ROOFS.map((colour): MaterialSpec => ({ finish: 'panel', colour }));
const NONE: readonly [number, number] = [0, 0];

/** `house`: 1-2 storeys, clay roofs; `flats`: 3-7; `tower`: 8-24 on a podium of 1-2, one in eight 30-44; `shop`: 1-3 low, 2-6 medium; `office`: 8-24; `works`: one hall 6-10 m. */
const KINDS: Readonly<Record<ZoneUse, Readonly<Record<ZoneDensity, BuildKind>>>> = {
  residential: {
    low: { storeys: [1, 2], tall: 0, tallStoreys: NONE, ground: [2.8, 3.3], storey: [2.8, 3.1], cover: 0.35, style: 'house', roofs: CLAY, rise: 1.3, office: false },
    medium: { storeys: [3, 7], tall: 0, tallStoreys: NONE, ground: [3.8, 4.5], storey: [2.9, 3.1], cover: 0.5, style: 'flats', roofs: FLAT_ROOFS, rise: 0, office: false },
    high: { storeys: [9, 26], tall: 0.125, tallStoreys: [31, 46], ground: [3.8, 4.5], storey: [2.9, 3.1], cover: 0.45, style: 'tower', roofs: FLAT_ROOFS, rise: 0, office: false },
  },
  commercial: {
    low: { storeys: [1, 3], tall: 0, tallStoreys: NONE, ground: [4, 4.6], storey: [3.1, 3.1], cover: 0.65, style: 'shop', roofs: FLAT_ROOFS, rise: 0, office: true },
    medium: { storeys: [2, 6], tall: 0, tallStoreys: NONE, ground: [4, 4.6], storey: [3.1, 3.1], cover: 0.65, style: 'shop', roofs: FLAT_ROOFS, rise: 0, office: true },
    high: { storeys: [8, 24], tall: 0, tallStoreys: NONE, ground: [4.5, 5.5], storey: [3.4, 3.9], cover: 0.5, style: 'office', roofs: FLAT_ROOFS, rise: 0, office: true },
  },
  industrial: {
    low: { storeys: [1, 1], tall: 0, tallStoreys: NONE, ground: [6, 7.5], storey: [3.4, 3.4], cover: 0.55, style: 'works', roofs: WORKS, rise: 1, office: true },
    medium: { storeys: [1, 1], tall: 0, tallStoreys: NONE, ground: [7, 9], storey: [3.4, 3.4], cover: 0.55, style: 'works', roofs: WORKS, rise: 1, office: true },
    high: { storeys: [1, 1], tall: 0, tallStoreys: NONE, ground: [8, 10], storey: [3.4, 3.4], cover: 0.55, style: 'works', roofs: WORKS, rise: 1, office: true },
  },
};

/** Share of a town's land in lots: the rest its streets and footways (blocks of 80-170 m, `cityGen/tile.ts` `GRID_GAPS`). */
const LOT_SHARE = 0.65;
/** The countryside's lots: a strip `LOT_DEPTH` deep each side of its avenues (`tile.ts`: the border avenues and the avenue gates' streets only), past half a road. */
const ROAD_HALF = m(9);
/** A square this wide or wider is read at 2 x 2 points: one point would stand for a square kilometre. */
const SAMPLE_SPLIT = m(256);
/** The place a building's draws are seeded by: about a lot, so every level draws the same building at a place. */
const LOT_CELL = m(32);

const FLAT: GroundReaders = { groundAt: () => 0, naturalAt: () => 0 };

/** A colour from afar as the masses have it (`massing.ts` `emitBoxes`): its tint, the building's shade, its finish's tone. */
function tinted(spec: MaterialSpec, shade: number, tone: Tone | undefined): readonly [number, number, number] {
  const c = rgbOf(spec.colour, shade), t = tone?.[spec.finish];
  return t ? [c[0] * t[0], c[1] * t[1], c[2] * t[2]] : c;
}

/** The share of a sub-square the strips along lines at `lines` cover, one axis: either side of a road, `LOT_DEPTH` deep. */
function covered(lines: readonly number[], lo: number, hi: number): number {
  let sum = 0;
  const overlap = (a: number, b: number): number => Math.max(0, Math.min(hi, b) - Math.max(lo, a));
  for (const at of lines) sum += overlap(at + ROAD_HALF, at + ROAD_HALF + LOT_DEPTH) + overlap(at - ROAD_HALF - LOT_DEPTH, at - ROAD_HALF);
  return Math.min(1, sum / (hi - lo));
}

/** A countryside tile's roads (`tile.ts` `gridInterior`, rural): its border avenues and its avenue gates' streets, across x and across y. */
interface RuralLines { readonly xs: readonly number[]; readonly ys: readonly number[] }
function ruralLines(seed: number, i: number, j: number): RuralLines {
  const avenues = (axis: 0 | 1, k: number): number[] => gatesOf(seed, axis, k).filter((g) => g.level === 0).map((g) => g.at);
  return { xs: [i * TILE, (i + 1) * TILE, ...avenues(1, i)], ys: [j * TILE, (j + 1) * TILE, ...avenues(0, j)] };
}

/** THE PLAN'S BOXES OF A QUADTREE NODE (`farTiles.ts`): level `level`, column `i`, row `j`, one per square of level `squares` (its own by default) and as fine; merged by the reader (`farTiles.ts` `aggregateBoxes`) */
export function planBoxes(options: WholeMapOptions, i: number, j: number, level: number, reads: GroundReaders = FLAT, tone?: Tone, squares = level): Float32Array {
  const plan = planWholeMap(options);
  const side = nodeSide(level), square = nodeSide(squares) / AGGREGATE;
  const per = square >= SAMPLE_SPLIT ? 2 : 1, cell = square / per, n = Math.round(side / cell);
  const x0 = i * side, y0 = j * side;
  // What each tile is, read once per tile (a node of the top level holds 16,384 of them).
  const characters = new Map<number, TileCharacter>();
  const rural = new Map<number, RuralLines>();
  const out: number[] = [];
  for (let b = 0; b < n; b++) {
    for (let a = 0; a < n; a++) {
      const cx = x0 + a * cell, cy = y0 + b * cell, x = cx + cell / 2, y = cy + cell / 2;
      const zone = plan.zoneAt({ x, y }, false);
      if (zone === 'park') continue;
      const t = tileIJ(x, y), key = tileKey(t.i, t.j);
      let character = characters.get(key);
      if (!character) characters.set(key, character = plan.tile(t.i, t.j));
      let share = LOT_SHARE;
      if (character.style === 'rural') {
        let lines = rural.get(key);
        if (!lines) rural.set(key, lines = ruralLines(options.seed, t.i, t.j));
        const fx = covered(lines.xs, cx, cx + cell), fy = covered(lines.ys, cy, cy + cell);
        share = fx + fy - fx * fy;
      }
      const kind = KINDS[zone.use][zone.density];
      share *= kind.cover;
      if (!(share > 0)) continue;
      // The building at this place: the same draws whatever the level reading it.
      const rng = new Rng(mix(options.seed, 0xfa71, Math.floor(x / LOT_CELL), Math.floor(y / LOT_CELL)));
      const [s0, s1] = rng.float() < kind.tall ? kind.tallStoreys : kind.storeys;
      const storeys = rng.int(s0, s1);
      const ground = m(rng.range(kind.ground[0], kind.ground[1])), storey = m(rng.range(kind.storey[0], kind.storey[1]));
      const style = styleFor(kind.style, rng);
      const wall = paintsOf(style, rng).wall;
      const roof = rng.pick(kind.roofs);
      const shade = 0.93 + rng.float() * 0.12;
      const w = tinted(wall, shade, tone), r = tinted(roof, shade, tone);
      const rhythm: readonly BayComponent[] = style.rhythms[0] ?? [];
      const glass = wall.finish === 'glass' ? 1 : rhythm.reduce((s, c) => s + (GLASS_SHARE[c] ?? 0), 0) / Math.max(1, rhythm.length);
      const floor = reads.naturalAt(x, y);
      const area = cell * cell * share, half = Math.sqrt(area) / 2;
      out.push(
        x, y, half, half, 0, floor - BURY, floor + ground + (storeys - 1) * storey + m(kind.rise), floor,
        w[0], w[1], w[2], r[0], r[1], r[2], m(style.module), storey, glass, rng.float() + (kind.office ? 2 : 0), area,
      );
    }
  }
  return new Float32Array(out);
}

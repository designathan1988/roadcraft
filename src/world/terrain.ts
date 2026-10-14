import { clamp } from '@core/scalar';
import { TUNED_UNIT, m } from './units';

export type TerrainMode = 'raise' | 'lower' | 'flatten' | 'river';

export interface TerrainStamp {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly strength: number;
  readonly mode: TerrainMode;
  /**
   * Height a `flatten` stamp levels towards. Absent means sea level, which is
   * what every stamp written before this field existed meant, so a saved map
   * loads unchanged.
   *
   * Levelling towards a TARGET is the difference between a tool that flattens
   * and a tool that levels. The old rule scaled the ground towards zero, so
   * "flatten" on a hillside pulled a plateau down to the datum instead of
   * making the ground under the cursor level with itself — which is what a
   * player levelling a site for a junction is actually asking for.
   */
  readonly level?: number;
  /**
   * The brush stroke this dab belongs to. Within one stroke the dabs of a
   * raise, lower or river do NOT add up: the stroke moves the ground by the
   * strongest dab over each point and no more - a brush's OPACITY, not its
   * flow (Photoshop and Krita draw the same line: opacity caps what one
   * stroke can do however often it passes; lift the pen and paint again to
   * build up). Summed, a held brush stacked a hundred dabs on one spot,
   * the ground hit the height ceiling and came out a flat-topped cylinder
   * with vertical walls; as a union, a stroke lays a ridge, a valley or a
   * channel of even height along its path, and a mountain is built stroke
   * by stroke, with slopes the falloff sets.
   *
   * Absent (the town's own landform, maps saved before this field) means a
   * dab of its own, added as before.
   */
  readonly stroke?: number;
  /**
   * Where a rough dab's noise is measured from (`rough`): the first dab of
   * its stroke, written in the same coordinates as the dab itself. Measured
   * from the point itself, the noise was the map's own (Unity Terrain Tools'
   * "World" coordinate space), and every plate's own coordinates give the
   * same ground other numbers (`render/flatAtlas.ts`): the two plates either
   * side of a border raised the same stroke into two different hills, a step
   * of up to 4 m along it (2026-10-11). From a point both plates carry with
   * the dab, they agree; every dab of a stroke still shares it, so the
   * stroke's lobes stay one. Absent (dabs before this field, the town's own
   * landform): the point.
   */
  readonly ox?: number;
  readonly oy?: number;
  /**
   * A natural brush (raise and lower dabs the player paints): the reach
   * wanders between ROUGH_REACH_MIN and the full radius with a world-space
   * noise, so a dab is not a circle, and the height is carved by a ridged
   * noise into crests and gullies (Unity Terrain Tools' noise brush: a noise
   * type over the falloff). Ten smooth domes on one spot made a perfect cone.
   *
   * Absent (the town's landform, maps saved before this field) means the
   * smooth dome, so saved ground is unchanged. The reach only ever SHRINKS,
   * so the spatial index's buckets, built on `radius`, stay right.
   */
  readonly rough?: boolean;
  /**
   * How hard the brush's edge is, 0..1, for raise and lower: 0 (absent) the
   * smooth dome; towards 1 the full height holds over the dab and drops in
   * the outer rim only - a mesa's flat top and its cliff, a canyon's floor
   * and walls (a terrain brush's falloff curve, Unity's Brush "Falloff",
   * from smooth fades to sharp edges).
   */
  readonly hardness?: number;
  /**
   * A raise's SHAPE other than the dome of its falloff. 'dome': a granite
   * sugarloaf (a bornhardt - Rio's Pão de Açúcar, Quixadá's monoliths): a
   * rounded crown on sides that steepen to a wall at the foot, its outline
   * wandering if the dab is rough but its crown smooth. Absent: the falloff.
   */
  readonly profile?: TerrainProfile;
}

/** The raise shapes besides the falloff's dome (`TerrainStamp.profile`). */
export type TerrainProfile = 'dome';
export const isTerrainProfile = (value: unknown): value is TerrainProfile => value === 'dome';

/**
 * A sugarloaf's section, 1 at its centre to 0 at its foot, over `d` = the
 * share of the reach out from the centre: a crown that stays round over the
 * inner half, then sides steepening to a near wall (a bornhardt's).
 */
const sugarloafProfile = (d: number): number => Math.pow(Math.max(0, 1 - Math.pow(Math.min(1, Math.max(0, d)), 2.4)), 0.6);

/**
 * How many brush dabs one map may hold.
 *
 * It was 512, and a river painted across the map is several hundred on its own:
 * the oldest dabs were silently dropped off the front of the list and the start
 * of the player's own river disappeared while they were still drawing the end
 * of it. The spatial index makes the sampling cost depend on local density
 * rather than on this number, so the cap can be generous.
 */
export const MAX_TERRAIN_STAMPS = 4_096;
/**
 * The vertical extent of the land, in world units: how deep a pit and how high
 * a mountain the brush may ever make.
 *
 * They were -26 and +34 — ten metres down, fourteen up — which is a garden
 * terrace: a sustained stroke stopped moving the ground and the terrain simply
 * planed off into a plateau at the ceiling. A map wanted mountains, valleys and
 * cuttings, and none of them fit.
 *
 * The map is 4 800 units (1 920 m) across, so the range is set against it: a
 * 560-unit mountain is 224 m over a plate two kilometres wide — a real
 * landform — and a 360-unit pit is 144 m, deeper than anything a player is
 * likely to dig on purpose. Deliberately NOT symmetric, because a town sits on
 * the land at 0 and the interesting relief (ridges, hillsides, lookouts) is
 * almost all above it.
 *
 * These are absolute bounds of the height FIELD, not a brush strength: a dab
 * still moves the ground by its own `strength`, and only the accumulated
 * result is clamped.
 */
export const TERRAIN_MIN_HEIGHT = m(-144);
export const TERRAIN_MAX_HEIGHT = m(224);
export const TERRAIN_WATER_HEIGHT = m(0.048);
/** The extra factor a river stamp carves with, over a raise of the same strength. */
export const RIVER_CARVE = 1.45;

/**
 * How much a stamp of strength 1 bends the ground `unit` of the way out, where
 * `unit` runs from 1 at its centre to 0 at its edge (the smoothstep). Monotone,
 * so it can be inverted to find where a carve is a given depth — which is where
 * a shoreline sits.
 */
export const terrainInfluence = (unit: number): number => unit * unit * (3 - 2 * unit);

/** The narrowest share of its radius a hard dab's edge falls over (`TerrainStamp.hardness`). */
const MIN_HARD_RIM = 0.08;
/** The narrowest a hard dab's wall is: two cells of the drawn terrain grid (6.4 m). */
const MIN_HARD_WALL = m(12.8);

/** A natural river dab carves this share of the old canyon's depth. */
const RIVER_BED_DEPTH = 0.42;
/** The share of a natural river dab's reach, from its edge, that is bank; inside it the bed is flat. */
export const RIVER_BED_FLOOR = 0.72;

/** The smallest share of its radius a rough dab reaches (`TerrainStamp.rough`). */
export const ROUGH_REACH_MIN = 0.78;

// --------------------------------------------------------------- base relief

/**
 * The land the map starts with, before the player touches it.
 *
 * A perfectly flat plane is the single biggest reason a 3D scene reads as a
 * drawing: with no relief there is nothing for the sun to shade, so the ground
 * is one flat colour from horizon to horizon whatever the lighting does.
 *
 * Four octaves of smooth, deterministic noise give the eye slopes to read. The
 * amplitudes were set by MEASURING the result rather than by taste: at a broad
 * wavelength alone the field's median slope came out at 2 degrees and its
 * steepest at 7, which changes how much sun a face takes by about a tenth —
 * under the eye's threshold for reading shape, and the reason the ground still
 * looked painted after the lighting was fixed. Shortening the wavelengths and
 * splitting the amplitude across four octaves brings the median to roughly 7
 * degrees and the steepest to around 20, which the sun models clearly, while
 * the largest landforms stay gentle enough for a road at grade to climb.
 *
 * Deterministic and analytic: no array, no seeding step, identical in the
 * renderer, the simulation and a headless test.
 */
const BASE_AMPLITUDE = 32;

function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 374_761_393) ^ Math.imul(y | 0, 668_265_263);
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  return ((h ^ (h >>> 16)) >>> 0) / 2_147_483_648 - 1;
}

/** Smooth deterministic value noise, -1..1 (the land's and the ecosystem's). */
export function valueNoise(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0);
  const b = hash2(x0 + 1, y0);
  const c = hash2(x0, y0 + 1);
  const d = hash2(x0 + 1, y0 + 1);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

/**
 * Which land a map starts from (`RoadDoc.terrainRelief`): 1 the gentle
 * four-octave field every map saved before this existed was built on, 2 the
 * natural landform (`naturalRelief`), 3 a level plain (height 0 everywhere,
 * the player's flat map). A map keeps the one it was made on, so its roads
 * never find the ground moved under them.
 */
export type ReliefVersion = 1 | 2 | 3;
export const RELIEF_LEGACY: ReliefVersion = 1;
export const RELIEF_NATURAL: ReliefVersion = 2;
export const RELIEF_FLAT: ReliefVersion = 3;
/**
 * A saved map's relief as the document reads it, or null when the value is
 * none. 4 was the planet's Earth (continents and oceans), gone with the
 * planet (the player, 2026-10-13): such a map opens on the level plain.
 */
export const readRelief = (value: unknown): ReliefVersion | null =>
  value === 1 || value === 2 || value === 3 ? value : value === 4 ? RELIEF_FLAT : null;

/**
 * Where a map's own relief (1, 2) stands: the plate of the map of before,
 * 1.92 km about the origin, where the maps made then and their roads lie,
 * eased into the level plain over `RELIEF_BLEND` past it. Spread over the
 * whole map of 10 km, the old field's value noise lit by a low sun read as
 * dark blotches in steps over all the land (the player, 2026-10-13: "os
 * gráficos estão péssimos"); before, the Earth's land took over there.
 */
const RELIEF_HALF = m(960);
const RELIEF_BLEND = m(480);

/** The map's own land at a point, before any stamp: its relief's field. */
export function reliefHeight(relief: ReliefVersion, x: number, y: number): number {
  if (relief === RELIEF_FLAT) return 0;
  const out = Math.max(Math.abs(x), Math.abs(y)) - RELIEF_HALF;
  if (out >= RELIEF_BLEND) return 0;
  const h = relief === RELIEF_NATURAL ? naturalRelief(x, y) : baseRelief(x, y);
  return out <= 0 ? h : h * (1 - smooth01(out / RELIEF_BLEND));
}

/** 0..1 smoothstep of `t`, clamped. */
const smooth01 = (t: number): number => {
  const k = Math.min(1, Math.max(0, t));
  return k * k * (3 - 2 * k);
};

/**
 * The natural landform: country, not a plate.
 *
 * - DOMAIN-WARPED (Inigo Quilez, "warp"): every octave is read at a position
 *   bent by a slow noise, so ridges curve and valleys meander instead of the
 *   isotropic blobs plain fbm gives.
 * - REGIONS: a slow mask decides where the land is hilly and where it is a
 *   plain, so a map has flat ground to build a town on and hills to look at,
 *   not one even roughness everywhere.
 * - RIDGED octaves (1 - |n|, squared) in the hills: crests and spurs with
 *   gullies between, the shape erosion leaves, not round domes.
 * - Rolling swells and a metre-scale micro-relief over everything, so a
 *   slope catches the light in more than one plane.
 *
 * Amplitudes in world units (2.5 to the metre): a plain within a few metres,
 * hills to some 75 m over it - enough to read from the map camera.
 */
export function naturalRelief(x: number, y: number): number {
  return naturalReliefTuned(x / TUNED_UNIT, y / TUNED_UNIT) * TUNED_UNIT;
}

/** `naturalRelief` in the unit its figures were tuned in (`TUNED_UNIT`). */
function naturalReliefTuned(x: number, y: number): number {
  const wx = valueNoise(x / 1400 + 3.1, y / 1400 - 7.4) * 420;
  const wy = valueNoise(x / 1400 - 11.2, y / 1400 + 2.6) * 420;
  const px = x + wx;
  const py = y + wy;
  const continent = valueNoise(px / 1900, py / 1900);
  const hilly = smooth01((valueNoise(px / 1300 + 17.3, py / 1300 - 5.9) + 0.1) / 0.85);
  let ridge = 0;
  let weight = 0;
  let amplitude = 1;
  let frequency = 1 / 640;
  for (let octave = 0; octave < 4; octave++) {
    const n = 1 - Math.abs(valueNoise(px * frequency + octave * 13.7, py * frequency - octave * 9.1));
    ridge += n * n * amplitude;
    weight += amplitude;
    amplitude *= 0.5;
    frequency *= 2.07;
  }
  ridge /= weight;
  const rolling = valueNoise(px / 260 + 2.2, py / 260 - 8.8) * 0.65 + valueNoise(px / 110 + 4.4, py / 110 + 1.3) * 0.35;
  const micro = valueNoise(x / 38 - 6.6, y / 38 + 3.3) * 0.6 + valueNoise(x / 17 + 9.9, y / 17 - 2.7) * 0.4;
  return 55 * continent + hilly * (190 * ridge - 60) + 22 * rolling * (0.35 + 0.65 * hilly) + 1.6 * micro;
}

/** The procedural land under every map, in world units. */
export function baseRelief(x: number, y: number): number {
  return baseReliefTuned(x / TUNED_UNIT, y / TUNED_UNIT) * TUNED_UNIT;
}

/** `baseRelief` in the unit its figures were tuned in (`TUNED_UNIT`). */
function baseReliefTuned(x: number, y: number): number {
  const broad = valueNoise(x / 620, y / 620);
  const middle = valueNoise(x / 210 + 13.7, y / 210 - 4.1);
  const fine = valueNoise(x / 88 - 7.3, y / 88 + 19.2);
  const grain = valueNoise(x / 48 + 31.5, y / 48 - 12.8);
  return BASE_AMPLITUDE * (broad * 0.42 + middle * 0.29 + fine * 0.2 + grain * 0.09);
}

// -------------------------------------------------------------- stamp lookup

/**
 * A uniform grid over the stamps, so a height query touches only nearby ones.
 *
 * `sampleTerrainHeight` runs once per terrain vertex on every terrain edit, and
 * again for every road profile station and every mesh vertex of every road. With
 * a linear scan and the stamp cap at 512 that was over fifty million distance
 * tests per brush stroke, which is precisely the stall felt while painting.
 */
export class TerrainIndex {
  private readonly cell: number;
  private readonly buckets = new Map<number, TerrainStamp[]>();
  readonly stamps: readonly TerrainStamp[];
  /** Incremented whenever the index is rebuilt, for cache invalidation. */
  readonly revision: number;
  /** The land under the stamps (`ReliefVersion`). */
  readonly relief: ReliefVersion;

  /**
   * The land under the stamps when it is read otherwise than from the relief
   * at the point itself: a plate's, in its own coordinates, from the corners
   * read off the page (`render/flatAtlas.ts`). Undefined: the relief's field.
   */
  readonly ground: ((x: number, y: number) => number) | undefined;

  constructor(stamps: readonly TerrainStamp[], revision: number, relief: ReliefVersion = RELIEF_LEGACY, ground?: (x: number, y: number) => number) {
    this.relief = relief;
    this.ground = ground;
    // COPIED, not aliased. The document's stamp list is mutated in place, so
    // holding the live array made every index look identical to the next one and
    // the renderer could never tell what had just changed.
    this.stamps = stamps.slice();
    this.revision = revision;
    let widest = m(25.6);
    for (const stamp of stamps) widest = Math.max(widest, stamp.radius);
    this.cell = widest;
    for (const stamp of stamps) {
      const x0 = Math.floor((stamp.x - stamp.radius) / this.cell);
      const x1 = Math.floor((stamp.x + stamp.radius) / this.cell);
      const y0 = Math.floor((stamp.y - stamp.radius) / this.cell);
      const y1 = Math.floor((stamp.y + stamp.radius) / this.cell);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const key = x * 73_856_093 + y * 19_349_663;
          const bucket = this.buckets.get(key);
          if (bucket) bucket.push(stamp);
          else this.buckets.set(key, [stamp]);
        }
      }
    }
  }

  /**
   * The stamps that can affect a point, in authoring order.
   *
   * Order matters: `flatten` scales whatever the stamps before it produced, so
   * applying them out of order gives a different surface.
   */
  near(x: number, y: number): readonly TerrainStamp[] {
    const key = Math.floor(x / this.cell) * 73_856_093 + Math.floor(y / this.cell) * 19_349_663;
    return this.buckets.get(key) ?? EMPTY;
  }
}

const EMPTY: readonly TerrainStamp[] = [];

/**
 * The height of the land at a point: base relief plus every stamp over it.
 *
 * Pass a `TerrainIndex` whenever the same stamp list is sampled more than a
 * handful of times; the plain array overload is kept for one-off queries and
 * for tests.
 */
export function sampleTerrainHeight(
  stamps: readonly TerrainStamp[] | TerrainIndex,
  x: number,
  y: number,
): number {
  const list = stamps instanceof TerrainIndex ? stamps.near(x, y) : stamps;
  const relief = stamps instanceof TerrainIndex ? stamps.relief : RELIEF_LEGACY;
  const ground = stamps instanceof TerrainIndex ? stamps.ground : undefined;
  let height = ground ? ground(x, y) : reliefHeight(relief, x, y);
  // The stroke being gathered (see `TerrainStamp.stroke`): its id, its mode,
  // and the strongest signed move any of its dabs makes here so far.
  let stroke: number | undefined;
  let strokeMode: TerrainMode | undefined;
  let strokeMove = 0;
  const settle = (): void => {
    height += strokeMove;
    stroke = undefined;
    strokeMove = 0;
  };
  for (const stamp of list) {
    if (stroke !== undefined && (stamp.stroke !== stroke || stamp.mode !== strokeMode)) settle();
    const dx = x - stamp.x;
    const dy = y - stamp.y;
    const distanceSquared = dx * dx + dy * dy;
    if (distanceSquared >= stamp.radius * stamp.radius) continue;
    const distance = Math.sqrt(distanceSquared);
    let reach = stamp.radius;
    let carve = 1;
    let bedProfile = false;
    // The noise's own coordinates (see `TerrainStamp.ox`).
    const nx = stamp.ox === undefined ? x : x - stamp.ox;
    const ny = stamp.oy === undefined ? y : y - stamp.oy;
    if (stamp.rough && stamp.mode === 'river') {
      // A river with a BED: a wide flat floor and ramped banks that wander
      // in and out along its length, at a depth a river has (some 6 m at
      // full strength) - not the smooth-walled canyon the dome profile cut.
      const lobe = stamp.radius * 0.6;
      reach *= ROUGH_REACH_MIN + (1 - ROUGH_REACH_MIN) * (0.5 + 0.5 * valueNoise(nx / lobe + 23.9, ny / lobe + 31.4));
      if (distance >= reach) continue;
      carve = RIVER_BED_DEPTH;
      bedProfile = true;
    } else if (stamp.rough && (stamp.mode === 'raise' || stamp.mode === 'lower')) {
      // World-space noise scaled by the brush, so every dab of a stroke (one
      // radius) agrees on the same lobes and crests.
      const lobe = stamp.radius * 0.45;
      reach *= ROUGH_REACH_MIN + (1 - ROUGH_REACH_MIN) * (0.5 + 0.5 * valueNoise(nx / lobe + 41.3, ny / lobe - 17.9));
      if (distance >= reach) continue;
      // A sugarloaf's crown is smooth rock: its outline wanders, its top does not.
      if (stamp.profile !== 'dome') {
        const crest = stamp.radius * 0.55;
        const ridge = 1 - Math.abs(valueNoise(nx / crest - 5.1, ny / crest + 8.6));
        // Gentle: dabs stack, and a strong carve stacked ten times drew spires.
        // A hard dab (a mesa, a canyon) keeps a flatter top and floor.
        carve = 1 + (0.36 * ridge * ridge - 0.18) * (1 - 0.75 * (stamp.hardness ?? 0));
      }
    }
    const unit = 1 - distance / reach;
    // A hard edge: the falloff squeezed into the dab's outer rim.
    // Never narrower than MIN_HARD_WALL: a wall thinner than a few cells of the drawn grid
    // came out a zigzag of teeth along its rim.
    const rim = stamp.hardness && (stamp.mode === 'raise' || stamp.mode === 'lower') ? Math.min(1, Math.max(MIN_HARD_RIM, 1 - stamp.hardness, MIN_HARD_WALL / reach)) : 1;
    const influence = (bedProfile ? terrainInfluence(Math.min(1, unit / RIVER_BED_FLOOR))
      : stamp.profile === 'dome' && stamp.mode === 'raise' ? sugarloafProfile(1 - unit)
        : terrainInfluence(Math.min(1, unit / rim))) * carve;
    const move = stamp.mode === 'raise' ? stamp.strength * influence
      : stamp.mode === 'lower' ? -stamp.strength * influence
        : stamp.mode === 'river' ? -stamp.strength * RIVER_CARVE * influence
          : 0;
    if (stamp.mode !== 'flatten' && stamp.stroke !== undefined) {
      stroke = stamp.stroke;
      strokeMode = stamp.mode;
      if (Math.abs(move) > Math.abs(strokeMove)) strokeMove = move;
    } else if (stamp.mode !== 'flatten') height += move;
    else {
      // Level towards the stamp's own target. With `level` absent this is
      // `height * (1 - k)` — algebraically the rule it replaced, so old maps
      // are bit-for-bit unaffected.
      const target = stamp.level ?? 0;
      height += (target - height) * Math.min(1, stamp.strength / m(4)) * influence;
    }
  }
  settle();
  return clamp(height, TERRAIN_MIN_HEIGHT, TERRAIN_MAX_HEIGHT);
}

export const isTerrainMode = (value: unknown): value is TerrainMode =>
  value === 'raise' || value === 'lower' || value === 'flatten' || value === 'river';

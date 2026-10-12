/**
 * THE ECOSYSTEM: what grows where, read from the land.
 *
 * As Horizon Zero Dawn's procedural placement does (Jaap van Muijden, "GPU
 * Based Procedural Placement in Horizon Zero Dawn", GDC 2017): the plants are
 * not authored one by one but derived from maps of the world - the relief,
 * the distance to water, the rock, the biome painted - by rules per plant
 * community, so painting a biome or moving a river changes the whole
 * ecosystem there at once. The communities are Brazil's own (IBGE's six
 * biomes and their fitofisionomias): the cerrado's gallery forest, veredas,
 * cerrado and cerradão and its rocky fields; the Atlantic forest and its
 * high grasslands; the Amazon's terra firme forest and várzea; the caatinga's
 * thorn scrub and cacti; the pampa's grasslands and gallery woods; the
 * pantanal's flooded fields and forest islands.
 *
 * Pure and deterministic: arrays in, arrays out, no `three`, no
 * `Math.random` (the noise is seeded by the map). The renderer gives it the
 * ground it draws and the water it fills, and plants and paints from the
 * answer (`render/terrain.ts`, `render/nature/`).
 */
import { BIOME_KINDS, type BiomeKind } from './terrainPaint';
import { valueNoise } from './terrain';
import { m } from './units';

/** The biome a map belongs to (`RoadDoc.nature`); a biome painted overrides it locally. */
export type RegionId = BiomeKind;
export const REGIONS: readonly RegionId[] = BIOME_KINDS;
export const DEFAULT_REGION: RegionId = 'cerrado';
export const isRegionId = (value: unknown): value is RegionId =>
  typeof value === 'string' && (BIOME_KINDS as readonly string[]).includes(value);

/** A map's ecosystem: its biome and the seed its patches are laid with. Absent on maps made before it. */
export interface NatureSettings {
  readonly region: RegionId;
  readonly seed: number;
}
export const isNatureSettings = (value: unknown): value is NatureSettings =>
  typeof value === 'object' && value !== null &&
  isRegionId((value as { region?: unknown }).region) &&
  Number.isFinite((value as { seed?: unknown }).seed);

export interface EcologyInput {
  /** Corners per side of the grid, and world units between corners. */
  readonly side: number;
  readonly cell: number;
  /** The ground's height at each corner, rows from the north (+y) edge. */
  readonly heights: ArrayLike<number>;
  /** 1 where a corner is under (or at) water, 0 elsewhere. */
  readonly water: ArrayLike<number>;
  /** The painted rock at each corner: how much is sandstone, how much basalt (the rest granite). */
  readonly sandstone: ArrayLike<number>;
  readonly basalt: ArrayLike<number>;
  /**
   * The biomes painted: `REGIONS.length` weights per corner, corner-major;
   * what they leave is the map's own region. Null when none was painted.
   */
  readonly painted: ArrayLike<number> | null;
  readonly settings: NatureSettings;
}

/** What grows at each corner, every value 0..1. */
export interface EcologyField {
  readonly side: number;
  /** Closed canopy: forest. */
  readonly canopy: Float32Array;
  /** Scattered trees of open country: the cerrado's twisted ones, the caatinga's. */
  readonly trees: Float32Array;
  /** Giants over the canopy (Amazon, Atlantic forest). */
  readonly emergent: Float32Array;
  readonly shrub: Float32Array;
  /** Palms: buriti in the veredas, açaí in the várzea, carnaúba in the caatinga, carandá in the pantanal. */
  readonly palm: Float32Array;
  readonly cactus: Float32Array;
  /** Herbs over the ground: 1 grass everywhere, 0 bare soil. */
  readonly grass: Float32Array;
  /** How dry and golden the herbs are in the dry season. */
  readonly dry: Float32Array;
  /** Waterlogged ground: vereda, brejo, várzea, flooded field. */
  readonly wet: Float32Array;
  /** Plants of the rocky fields: bromeliads, canela-de-ema, cacti on stone. */
  readonly rocky: Float32Array;
  /** The biome that holds most of each corner, as an index in `REGIONS` (which species grow). */
  readonly region: Uint8Array;
  /** What a later update reuses: the distance to water per corner and the lowest ground (`computeEcology`). */
  readonly waterDistance: Float32Array;
  readonly lowest: number;
}

/**
 * A field brought up to date over a region (Etapa 5g): the corners whose
 * ground changed, inclusive, in grid indices, read again from `previous`
 * with the same water. A terrain stroke re-read the whole map, 82 ms, and
 * every tree of the countryside could change under a stroke far away.
 */
export interface EcologyUpdate {
  readonly previous: EcologyField;
  readonly ix0: number; readonly ix1: number; readonly iy0: number; readonly iy1: number;
}

/** How far a corner's answer reaches: the local mean's radius, and a corner either side for the slope. */
const MEAN_RADIUS = 8;
const REACH = MEAN_RADIUS + 1;

/** One plant community: the densities of its strata. */
interface Community {
  canopy: number;
  trees: number;
  emergent: number;
  shrub: number;
  palm: number;
  cactus: number;
  grass: number;
  dry: number;
  wet: number;
  rocky: number;
}

const community = (c: Partial<Community>): Community => ({
  canopy: 0, trees: 0, emergent: 0, shrub: 0, palm: 0, cactus: 0, grass: 0, dry: 0, wet: 0, rocky: 0, ...c,
});

/** The fitofisionomias, as densities (IBGE; the field descriptions of each biome). */
const FORMATIONS = {
  // Cerrado
  galleryForest: community({ canopy: 0.95, emergent: 0.08, shrub: 0.5, palm: 0.06, grass: 0.25, dry: 0.1 }),
  vereda: community({ canopy: 0.04, shrub: 0.12, palm: 0.6, grass: 1, dry: 0.1, wet: 0.9 }),
  cerradao: community({ canopy: 0.55, trees: 0.35, shrub: 0.5, grass: 0.55, dry: 0.45 }),
  cerrado: community({ trees: 0.24, shrub: 0.38, grass: 0.95, dry: 0.78 }),
  campoRupestre: community({ trees: 0.03, shrub: 0.14, grass: 0.8, dry: 0.85, rocky: 0.5 }),
  // Atlantic forest
  ombrophilous: community({ canopy: 0.96, emergent: 0.14, shrub: 0.62, palm: 0.12, grass: 0.2, dry: 0.04 }),
  highGrassland: community({ canopy: 0.04, trees: 0.06, shrub: 0.26, grass: 1, dry: 0.35, rocky: 0.32 }),
  // Amazon
  terraFirme: community({ canopy: 1, emergent: 0.3, shrub: 0.66, palm: 0.24, grass: 0.1 }),
  varzea: community({ canopy: 0.72, emergent: 0.06, shrub: 0.4, palm: 0.6, grass: 0.45, wet: 0.75 }),
  // Caatinga
  thornScrub: community({ trees: 0.2, shrub: 0.56, cactus: 0.3, grass: 0.38, dry: 0.95 }),
  caatingaRiver: community({ canopy: 0.42, trees: 0.3, shrub: 0.35, palm: 0.42, grass: 0.7, dry: 0.5 }),
  // Pampa
  campos: community({ trees: 0.01, shrub: 0.06, grass: 1, dry: 0.3, rocky: 0.04 }),
  capao: community({ canopy: 0.65, shrub: 0.45, grass: 0.45, dry: 0.15 }),
  // Pantanal
  floodedField: community({ shrub: 0.05, palm: 0.08, grass: 1, dry: 0.15, wet: 0.82 }),
  cordilheira: community({ canopy: 0.72, palm: 0.26, shrub: 0.5, grass: 0.4, dry: 0.2 }),
  // Every biome
  outcrop: community({ shrub: 0.06, grass: 0.5, dry: 0.5, rocky: 0.45 }),
} as const;

/** Per corner, what the land is like there. */
interface Site {
  /** Distance to the nearest water, world units. */
  waterDist: number;
  /** 0..1: how far below its surroundings (a valley floor) or above them (a ridge). */
  valley: number;
  ridge: number;
  /** 0..1: level ground, and a cliff (nothing roots on a wall). */
  flat: number;
  steep: number;
  /** Height over the plate's lowest ground, world units. */
  altitude: number;
  sandstone: number;
  basalt: number;
  /** Two seeded noises, 0..1: wide patches and their ragged edges. */
  patch: number;
  fray: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * A community's fields, listed once: read anew for every corner they were an
 * array made per call, a large part of the planet's opening (864 plates of
 * 1 849 corners, each blended once or twice) and of its garbage.
 */
let communityKeys: readonly (keyof Community)[] | null = null;

/** Mixes communities by weight into `out` (the weights need not sum to one). */
function blend(out: Community, parts: readonly (readonly [number, Community])[]): void {
  let total = 0;
  for (let i = 0; i < parts.length; i++) total += Math.max(0, parts[i]![0]);
  const keys = communityKeys ??= Object.keys(out) as (keyof Community)[];
  for (let j = 0; j < keys.length; j++) out[keys[j]!] = 0;
  if (total <= 1e-6) return;
  for (let i = 0; i < parts.length; i++) {
    const [w, c] = parts[i]!;
    if (w <= 0) continue;
    const k = w / total;
    for (let j = 0; j < keys.length; j++) { const key = keys[j]!; out[key] += c[key] * k; }
  }
}

/** One region's communities over one site. */
function regionCommunity(region: RegionId, s: Site, out: Community): void {
  const F = FORMATIONS;
  // Along every river and lake a strip of forest, wider where the patch says.
  const riparian = 1 - smooth(m(10) + m(18) * s.patch, m(44) + m(28) * s.patch, s.waterDist);
  const cliff = s.steep;
  const open = 1 - cliff;
  switch (region) {
    case 'cerrado': {
      // Veredas: wet palm swamps in the level floors of valleys near water.
      const vereda = s.flat * smooth(0.15, 0.55, s.valley) * (1 - smooth(m(24), m(128), s.waterDist)) * smooth(0.3, 0.6, s.patch);
      // Cerradão where the ground holds water (lower slopes), and in patches.
      const dense = clamp01(smooth(0.1, 0.5, s.valley) * 0.8 + smooth(0.62, 0.85, s.patch) * 0.6);
      // Rocky fields on the ridges and the chapadas' sandstone tops.
      const rupestre = clamp01(s.ridge * 0.9 + s.sandstone * 0.45 * s.flat) * (1 - riparian);
      blend(out, [
        [riparian * open, F.galleryForest],
        [vereda * (1 - riparian) * open, F.vereda],
        [dense * (1 - riparian) * (1 - vereda) * open, F.cerradao],
        [rupestre * open, F.campoRupestre],
        [Math.max(0, 1 - riparian - vereda - dense - rupestre) * open + 0.05, F.cerrado],
        [cliff, F.outcrop],
      ]);
      break;
    }
    case 'atlantic': {
      // The high grasslands over the forest line, on the exposed tops.
      const high = smooth(m(68), m(104), s.altitude + s.ridge * m(24) + (s.patch - 0.5) * m(20));
      blend(out, [
        [(1 - high) * open + riparian, F.ombrophilous],
        [high * open * (1 - riparian), F.highGrassland],
        [cliff, F.outcrop],
      ]);
      break;
    }
    case 'amazon': {
      // Várzea and igapó: the flooded forest of the low ground by the rivers.
      const varzea = (1 - smooth(m(16), m(88), s.waterDist)) * clamp01(0.4 + s.valley);
      blend(out, [
        [(1 - varzea) * open, F.terraFirme],
        [varzea * open, F.varzea],
        [cliff, F.outcrop],
      ]);
      break;
    }
    case 'caatinga': {
      blend(out, [
        [riparian * open, F.caatingaRiver],
        [(1 - riparian) * open, F.thornScrub],
        [cliff + s.ridge * 0.35, F.outcrop],
      ]);
      break;
    }
    case 'pampa': {
      // Capões: islands of wood in the hollows, where the patch rises.
      const capao = smooth(0.62, 0.8, s.patch) * smooth(0.05, 0.4, s.valley);
      blend(out, [
        [riparian * open * 0.9, F.capao],
        [capao * (1 - riparian) * open, F.capao],
        [(1 - capao) * (1 - riparian) * open, F.campos],
        [cliff + s.ridge * 0.2 + s.basalt * 0.15, F.outcrop],
      ]);
      break;
    }
    case 'pantanal': {
      // The flooded fields on the low flats; cordilheiras, forest on the
      // slightly higher ground the floods leave dry.
      // The floods reach the level ground and everything near the rivers.
      const low = Math.max(s.flat * clamp01(0.35 + s.valley * 1.2) * (1 - smooth(0.25, 0.6, s.ridge)), 1 - smooth(m(8), m(88), s.waterDist));
      const cordilheira = smooth(0.55, 0.75, s.patch) * (1 - low * 0.7);
      blend(out, [
        [riparian * open * 0.35, F.cordilheira],
        [low * (1 - cordilheira) * open, F.floodedField],
        [cordilheira * open, F.cordilheira],
        [Math.max(0, 1 - low - cordilheira) * open * 0.6, F.cerrado],
        [cliff, F.outcrop],
      ]);
      break;
    }
  }
  // Ragged edges: every stratum a little more or less from place to place.
  const jitter = 0.8 + 0.4 * s.fray;
  out.canopy = clamp01(out.canopy * jitter);
  out.trees = clamp01(out.trees * jitter);
  out.shrub = clamp01(out.shrub * (1.2 - 0.4 * s.fray));
}

/**
 * Distance to the nearest wet corner, in world units: a two-pass chamfer
 * transform (3-4 weights), linear in the corners.
 */
function waterDistance(water: ArrayLike<number>, side: number, cell: number): Float32Array {
  const far = 1e9;
  const d = new Float32Array(side * side);
  for (let i = 0; i < d.length; i++) d[i] = (water[i] as number) > 0.5 ? 0 : far;
  const a = 3, b = 4;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const i = y * side + x;
      let v = d[i] as number;
      if (x > 0) v = Math.min(v, (d[i - 1] as number) + a);
      if (y > 0) {
        v = Math.min(v, (d[i - side] as number) + a);
        if (x > 0) v = Math.min(v, (d[i - side - 1] as number) + b);
        if (x + 1 < side) v = Math.min(v, (d[i - side + 1] as number) + b);
      }
      d[i] = v;
    }
  }
  for (let y = side - 1; y >= 0; y--) {
    for (let x = side - 1; x >= 0; x--) {
      const i = y * side + x;
      let v = d[i] as number;
      if (x + 1 < side) v = Math.min(v, (d[i + 1] as number) + a);
      if (y + 1 < side) {
        v = Math.min(v, (d[i + side] as number) + a);
        if (x + 1 < side) v = Math.min(v, (d[i + side + 1] as number) + b);
        if (x > 0) v = Math.min(v, (d[i + side - 1] as number) + b);
      }
      d[i] = v;
    }
  }
  for (let i = 0; i < d.length; i++) d[i] = (d[i] as number) * (cell / a);
  return d;
}

/** The mean of the heights round each corner over a square of `radius` corners: a separable box blur. */
/**
 * `localMean` over the corners x0..x1, y0..y1 only (the rest 0): read from a
 * crop `radius` wider, which gives the same means inside it - the box at the
 * crop's inner edges is cut only where the grid's own edge cuts it.
 */
function localMeanIn(heights: ArrayLike<number>, side: number, radius: number, x0: number, x1: number, y0: number, y1: number): Float32Array {
  const cx0 = Math.max(0, x0 - radius), cx1 = Math.min(side - 1, x1 + radius);
  const cy0 = Math.max(0, y0 - radius), cy1 = Math.min(side - 1, y1 + radius);
  const out = new Float32Array(side * side);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let sum = 0, n = 0;
      for (let yy = Math.max(cy0, y - radius); yy <= Math.min(cy1, y + radius); yy++) {
        for (let xx = Math.max(cx0, x - radius); xx <= Math.min(cx1, x + radius); xx++) { sum += heights[yy * side + xx] as number; n++; }
      }
      out[y * side + x] = sum / n;
    }
  }
  return out;
}

function localMean(heights: ArrayLike<number>, side: number, radius: number): Float32Array {
  const rows = new Float32Array(side * side);
  const out = new Float32Array(side * side);
  for (let y = 0; y < side; y++) {
    let sum = 0, n = 0;
    for (let x = 0; x <= Math.min(side - 1, radius); x++) { sum += heights[y * side + x] as number; n++; }
    for (let x = 0; x < side; x++) {
      rows[y * side + x] = sum / n;
      const add = x + radius + 1, drop = x - radius;
      if (add < side) { sum += heights[y * side + add] as number; n++; }
      if (drop >= 0) { sum -= heights[y * side + drop] as number; n--; }
    }
  }
  for (let x = 0; x < side; x++) {
    let sum = 0, n = 0;
    for (let y = 0; y <= Math.min(side - 1, radius); y++) { sum += rows[y * side + x] as number; n++; }
    for (let y = 0; y < side; y++) {
      out[y * side + x] = sum / n;
      const add = y + radius + 1, drop = y - radius;
      if (add < side) { sum += rows[add * side + x] as number; n++; }
      if (drop >= 0) { sum -= rows[drop * side + x] as number; n--; }
    }
  }
  return out;
}

/** Reads the land and answers what grows at every corner. */
export function computeEcology(input: EcologyInput, update?: EcologyUpdate): EcologyField {
  const { side, cell, heights } = input;
  const count = side * side;
  let lowest = Infinity;
  for (let i = 0; i < count; i++) lowest = Math.min(lowest, heights[i] as number);
  // Over a region only when that is the same answer: the lowest ground (every
  // corner's altitude is read from it) and the field's size unchanged.
  const prev = update && update.previous.side === side && update.previous.lowest === lowest ? update.previous : null;
  const x0 = prev ? Math.max(0, update!.ix0 - REACH) : 0, x1 = prev ? Math.min(side - 1, update!.ix1 + REACH) : side - 1;
  const y0 = prev ? Math.max(0, update!.iy0 - REACH) : 0, y1 = prev ? Math.min(side - 1, update!.iy1 + REACH) : side - 1;
  const field: EcologyField = prev ?? {
    side,
    canopy: new Float32Array(count), trees: new Float32Array(count), emergent: new Float32Array(count),
    shrub: new Float32Array(count), palm: new Float32Array(count), cactus: new Float32Array(count),
    grass: new Float32Array(count), dry: new Float32Array(count), wet: new Float32Array(count),
    rocky: new Float32Array(count), region: new Uint8Array(count),
    waterDistance: waterDistance(input.water, side, cell), lowest,
  };
  const distance = field.waterDistance;
  // A valley floor or a ridge against the ground some 130 m round it: over
  // the region, from a crop a mean's radius wider still (exact inside it).
  const mean = prev ? localMeanIn(heights, side, MEAN_RADIUS, x0, x1, y0, y1) : localMean(heights, side, MEAN_RADIUS);
  const seedX = (input.settings.seed % 997) * 1.731;
  const seedY = (Math.floor(input.settings.seed / 997) % 997) * 2.113;
  const half = ((side - 1) * cell) / 2;
  const own = REGIONS.indexOf(input.settings.region);
  const site: Site = { waterDist: 0, valley: 0, ridge: 0, flat: 0, steep: 0, altitude: 0, sandstone: 0, basalt: 0, patch: 0, fray: 0 };
  const part = community({});
  const total = community({});
  const keys = Object.keys(total) as (keyof Community)[];
  const weights = new Float32Array(REGIONS.length);
  for (let iy = y0; iy <= y1; iy++) {
    for (let ix = x0; ix <= x1; ix++) {
      const i = iy * side + ix;
      const x = -half + ix * cell, y = half - iy * cell;
      const h = heights[i] as number;
      // Slope from the corners either side.
      const hx = ((heights[iy * side + Math.min(side - 1, ix + 1)] as number) - (heights[iy * side + Math.max(0, ix - 1)] as number)) / (2 * cell);
      const hy = ((heights[Math.min(side - 1, iy + 1) * side + ix] as number) - (heights[Math.max(0, iy - 1) * side + ix] as number)) / (2 * cell);
      const slope = Math.atan(Math.hypot(hx, hy)) * (180 / Math.PI);
      const relative = h - (mean[i] as number);
      site.waterDist = distance[i] as number;
      site.valley = smooth(m(0.8), m(8.8), -relative);
      site.ridge = smooth(m(0.8), m(8.8), relative);
      site.flat = 1 - smooth(5, 15, slope);
      site.steep = smooth(40, 56, slope);
      site.altitude = h - lowest;
      site.sandstone = input.sandstone[i] as number;
      site.basalt = input.basalt[i] as number;
      site.patch = 0.5 + 0.5 * valueNoise(x / m(92) + seedX, y / m(92) + seedY);
      site.fray = 0.5 + 0.5 * valueNoise(x / m(22) + seedY, y / m(22) - seedX);
      // The biomes over this corner: the painted ones, the map's own the rest.
      let painted = 0;
      for (let r = 0; r < REGIONS.length; r++) {
        const w = input.painted ? (input.painted[i * REGIONS.length + r] as number) : 0;
        weights[r] = w;
        painted += w;
      }
      weights[own] = (weights[own] as number) + Math.max(0, 1 - painted);
      for (const key of keys) total[key] = 0;
      let best = own, bestW = -1, sum = 0;
      for (let r = 0; r < REGIONS.length; r++) {
        const w = weights[r] as number;
        if (w > bestW) { bestW = w; best = r; }
        if (w < 0.01) continue;
        regionCommunity(REGIONS[r]!, site, part);
        for (const key of keys) total[key] += part[key] * w;
        sum += w;
      }
      const k = sum > 0 ? 1 / sum : 0;
      field.canopy[i] = clamp01(total.canopy * k);
      field.trees[i] = clamp01(total.trees * k);
      field.emergent[i] = clamp01(total.emergent * k);
      field.shrub[i] = clamp01(total.shrub * k);
      field.palm[i] = clamp01(total.palm * k);
      field.cactus[i] = clamp01(total.cactus * k);
      field.grass[i] = clamp01(total.grass * k);
      field.dry[i] = clamp01(total.dry * k);
      field.wet[i] = clamp01(total.wet * k);
      field.rocky[i] = clamp01(total.rocky * k);
      field.region[i] = best;
    }
  }
  // Nothing grows in the water itself.
  for (let iy = y0; iy <= y1; iy++) for (let i = iy * side + x0; i <= iy * side + x1; i++) {
    if ((input.water[i] as number) <= 0.5) continue;
    field.canopy[i] = 0; field.trees[i] = 0; field.emergent[i] = 0; field.shrub[i] = 0;
    field.palm[i] = 0; field.cactus[i] = 0; field.rocky[i] = 0;
  }
  return field;
}

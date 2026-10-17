/** THE ECOSYSTEM: what grows where, read from the land. */
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
  /** The biomes painted: `REGIONS.length` weights per corner, corner-major; what they leave is the map's own region. */
  readonly painted: ArrayLike<number> | null;
  readonly settings: NatureSettings;
  /** Where the grid's centre lies in the world (a plate's centre). */
  readonly centre?: { readonly x: number; readonly y: number };
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

/** A field brought up to date over a region (Etapa 5g) */
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

/** A community's fields, listed once */
let communityKeys: readonly (keyof Community)[] | null = null;

/** The communities a corner mixes and their weights (`weigh`), as many as `blend` is told: DO NOT make an array of pairs a corner (a plate's ecology made seven arrays at each of its corners, region by region). */
const partWeights = new Float64Array(8);
const partCommunities: Community[] = [];
const weigh = (i: number, w: number, c: Community): void => { partWeights[i] = w; partCommunities[i] = c; };

/** Mixes the first `count` communities weighed (`weigh`) into `out` (the weights need not sum to one). */
function blend(out: Community, count: number): void {
  let total = 0;
  for (let i = 0; i < count; i++) total += Math.max(0, partWeights[i]!);
  const keys = communityKeys ??= Object.keys(out) as (keyof Community)[];
  for (let j = 0; j < keys.length; j++) out[keys[j]!] = 0;
  if (total <= 1e-6) return;
  for (let i = 0; i < count; i++) {
    const w = partWeights[i]!, c = partCommunities[i]!;
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
      weigh(0, riparian * open, F.galleryForest);
      weigh(1, vereda * (1 - riparian) * open, F.vereda);
      weigh(2, dense * (1 - riparian) * (1 - vereda) * open, F.cerradao);
      weigh(3, rupestre * open, F.campoRupestre);
      weigh(4, Math.max(0, 1 - riparian - vereda - dense - rupestre) * open + 0.05, F.cerrado);
      weigh(5, cliff, F.outcrop);
      blend(out, 6);
      break;
    }
    case 'atlantic': {
      // The high grasslands over the forest line, on the exposed tops.
      const high = smooth(m(68), m(104), s.altitude + s.ridge * m(24) + (s.patch - 0.5) * m(20));
      weigh(0, (1 - high) * open + riparian, F.ombrophilous);
      weigh(1, high * open * (1 - riparian), F.highGrassland);
      weigh(2, cliff, F.outcrop);
      blend(out, 3);
      break;
    }
    case 'amazon': {
      // Várzea and igapó: the flooded forest of the low ground by the rivers.
      const varzea = (1 - smooth(m(16), m(88), s.waterDist)) * clamp01(0.4 + s.valley);
      weigh(0, (1 - varzea) * open, F.terraFirme);
      weigh(1, varzea * open, F.varzea);
      weigh(2, cliff, F.outcrop);
      blend(out, 3);
      break;
    }
    case 'caatinga': {
      weigh(0, riparian * open, F.caatingaRiver);
      weigh(1, (1 - riparian) * open, F.thornScrub);
      weigh(2, cliff + s.ridge * 0.35, F.outcrop);
      blend(out, 3);
      break;
    }
    case 'pampa': {
      // Capões: islands of wood in the hollows, where the patch rises.
      const capao = smooth(0.62, 0.8, s.patch) * smooth(0.05, 0.4, s.valley);
      weigh(0, riparian * open * 0.9, F.capao);
      weigh(1, capao * (1 - riparian) * open, F.capao);
      weigh(2, (1 - capao) * (1 - riparian) * open, F.campos);
      weigh(3, cliff + s.ridge * 0.2 + s.basalt * 0.15, F.outcrop);
      blend(out, 4);
      break;
    }
    case 'pantanal': {
      // The flooded fields on the low flats; cordilheiras, forest on the slightly higher ground the floods leave dry.
      const low = Math.max(s.flat * clamp01(0.35 + s.valley * 1.2) * (1 - smooth(0.25, 0.6, s.ridge)), 1 - smooth(m(8), m(88), s.waterDist));
      const cordilheira = smooth(0.55, 0.75, s.patch) * (1 - low * 0.7);
      weigh(0, riparian * open * 0.35, F.cordilheira);
      weigh(1, low * (1 - cordilheira) * open, F.floodedField);
      weigh(2, cordilheira * open, F.cordilheira);
      weigh(3, Math.max(0, 1 - low - cordilheira) * open * 0.6, F.cerrado);
      weigh(4, cliff, F.outcrop);
      blend(out, 5);
      break;
    }
  }
  // Ragged edges: every stratum a little more or less from place to place.
  const jitter = 0.8 + 0.4 * s.fray;
  out.canopy = clamp01(out.canopy * jitter);
  out.trees = clamp01(out.trees * jitter);
  out.shrub = clamp01(out.shrub * (1.2 - 0.4 * s.fray));
}

/** Distance to the nearest wet corner, in world units: a two-pass chamfer transform (3-4 weights), linear in the corners. */
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

/** `localMean` over the corners x0..x1, y0..y1 only (the rest 0) */
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

/** The mean of the heights round each corner over a square of `radius` corners: a separable box blur. */
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
  // Over a region only when that is the same answer: the lowest ground
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
  // A valley floor or a ridge against the ground some 130 m round it
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
      // The world position, for the noise only (the rest reads the grid).
      const wx = x + (input.centre?.x ?? 0), wy = y + (input.centre?.y ?? 0);
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
      site.patch = 0.5 + 0.5 * valueNoise(wx / m(92) + seedX, wy / m(92) + seedY);
      site.fray = 0.5 + 0.5 * valueNoise(wx / m(22) + seedY, wy / m(22) - seedX);
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

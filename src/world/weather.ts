/**
 * THE MAP'S WEATHER (Paisagem > Terreno > Clima): how hard it rains, how
 * strong the wind blows and which way, how often lightning strikes and how
 * loud the thunder. Kept in the document, so it saves, loads and undoes; the
 * renderer draws it - the rain (`render/rain.ts`), the wind carrying the
 * clouds and swaying the trees, the lightning (`render/lightning.ts`) - and
 * the interface plays the thunder.
 */

export interface Weather {
  /** 0 dry .. 1 a downpour. */
  readonly rain: number;
  /** Wind speed, metres a second (0 still .. 30 a gale). */
  readonly wind: number;
  /** The way the wind blows TOWARDS, degrees: 0 east (+x), 90 north (+y). */
  readonly windDirection: number;
  /** Lightning strikes a minute (0 none). */
  readonly lightning: number;
  /** Thunder's loudness, 0..1. */
  readonly thunder: number;
  /** The rivers' and lakes' waves, 0 glassy .. 1 a rough sea. */
  readonly waves: number;
  /** How much foam on the water, 0..1. */
  readonly foam: number;
  /** How fast the rivers run, metres a second (0 still .. 4 a torrent). */
  readonly current: number;
}

export const DEFAULT_WEATHER: Weather = { rain: 0, wind: 0, windDirection: 30, lightning: 0, thunder: 0.6, waves: 0.3, foam: 0.4, current: 1.2 };

export const WEATHER_LIMITS = {
  rain: [0, 1],
  wind: [0, 30],
  windDirection: [0, 360],
  lightning: [0, 30],
  thunder: [0, 1],
  waves: [0, 1],
  foam: [0, 1],
  current: [0, 4],
} as const;

const clamp = (v: number, [lo, hi]: readonly [number, number]): number => Math.min(hi, Math.max(lo, v));

/** The weather read from a saved map (or a partial change merged over one), kept in range. */
export function readWeather(data: unknown, base: Weather = DEFAULT_WEATHER): Weather {
  const d = (data ?? {}) as Partial<Record<keyof Weather, unknown>>;
  const pick = (key: keyof Weather): number => {
    const v = d[key];
    return clamp(typeof v === 'number' && Number.isFinite(v) ? v : base[key], WEATHER_LIMITS[key]);
  };
  return {
    rain: pick('rain'), wind: pick('wind'), windDirection: pick('windDirection') % 360, lightning: pick('lightning'), thunder: pick('thunder'),
    waves: pick('waves'), foam: pick('foam'), current: pick('current'),
  };
}

/** The wind on the map, world units a second along x and y. */
export function windVector(weather: Weather, unitsPerMetre: number): { x: number; y: number } {
  const a = (weather.windDirection * Math.PI) / 180;
  return { x: Math.cos(a) * weather.wind * unitsPerMetre, y: Math.sin(a) * weather.wind * unitsPerMetre };
}

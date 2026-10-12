import { m } from './units';
/**
 * PAINTED FOG: banks of mist the player lays where they want them - over a
 * valley, along a river, round a hill - and takes away again with the
 * eraser. Like the painted ground (`terrainPaint.ts`) the document keeps the
 * DABS, so a fogged map saves, loads and undoes as any other edit; the
 * renderer rasterises them into a map over the land and marches the view's
 * rays through it (`render/fogLayer.ts`, `render/postprocess.ts`), as
 * engines draw local fog volumes over an exponential height fog (Unreal's
 * Local Fog Volumes: a density falling off with height above the ground,
 * soft at its edges).
 *
 * Each dab carries the BRUSH's settings at the time it was laid - how thick,
 * how high the bank rises, how fast the wind carries it - so one valley can
 * hold a low, still mist and the next a tall bank streaming past (the
 * player, 2026-10-07: "as configurações têm que ser do pincel"). The map
 * adds one setting of its own over all of them (`FogSettings`).
 */

export interface FogDab {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  /** 0..1: how far one dab takes the fog towards full (or, erasing, towards none) at its centre. */
  readonly strength: number;
  /** How high this fog stands over the ground before it thins out, world units. */
  readonly height: number;
  /** How fast the wind carries this fog through, world units a second. */
  readonly speed: number;
  /** Takes fog away instead of laying it. */
  readonly erase?: boolean;
}

/** The map's own fog setting, over every bank painted. */
export interface FogSettings {
  /** 0..2: every painted fog's thickness times this. */
  readonly density: number;
}

export const DEFAULT_FOG: FogSettings = { density: 1 };
/** A fog dab's height and speed when a saved one carries none. */
export const DEFAULT_FOG_HEIGHT = m(24);
export const DEFAULT_FOG_SPEED = m(6);

/** A map keeps at most this many fog dabs; the oldest go first. */
export const MAX_FOG_DABS = 20_000;

export const FOG_LIMITS = {
  density: [0, 2],
  height: [m(2), m(160)],
  speed: [0, m(24)],
} as const;

const clamp = (v: number, [lo, hi]: readonly [number, number]): number => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** The settings read from a saved map, kept in range; absent ones take the defaults. */
export function readFogSettings(data: unknown): FogSettings {
  const d = (data ?? {}) as Partial<Record<keyof FogSettings, unknown>>;
  return { density: clamp(num(d.density, DEFAULT_FOG.density), FOG_LIMITS.density) };
}

/** A fog dab read from a saved map, or null if it is not one. */
export function readFogDab(data: unknown): FogDab | null {
  const d = data as Partial<Record<keyof FogDab, unknown>> | null;
  if (!d || ![d.x, d.y, d.radius, d.strength].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  return {
    x: d.x as number, y: d.y as number, radius: Math.max(1, d.radius as number), strength: clamp(d.strength as number, [0, 1]),
    height: clamp(num(d.height, DEFAULT_FOG_HEIGHT), FOG_LIMITS.height),
    speed: clamp(num(d.speed, DEFAULT_FOG_SPEED), FOG_LIMITS.speed),
    ...(d.erase === true ? { erase: true } : {}),
  };
}

export interface FogSample {
  /** 0..1. */
  density: number;
  /** The fog's height and speed there: the dabs that laid it, weighted by what each laid. */
  height: number;
  speed: number;
}

/**
 * The fog the dabs leave at a point: each dab in turn, a smooth falloff from
 * its centre to its rim, adding towards one or (erasing) taking away towards
 * none; its height and speed those of the dabs that laid it, each by what it
 * added. The renderer rasterises this per texel.
 */
export function fogAt(dabs: readonly FogDab[], x: number, y: number, out: FogSample = { density: 0, height: 0, speed: 0 }): FogSample {
  let d = 0, weight = 0, height = 0, speed = 0;
  for (const dab of dabs) {
    const r = Math.hypot(x - dab.x, y - dab.y) / dab.radius;
    if (r >= 1) continue;
    const s = 1 - r * r;
    const w = s * s * dab.strength;
    if (dab.erase) {
      d *= 1 - w;
      continue;
    }
    d += (1 - d) * w;
    // Repainting over a bank with new settings moves it towards them, as
    // far as the dab is strong there.
    if (weight === 0) { height = dab.height; speed = dab.speed; } else { height += (dab.height - height) * w; speed += (dab.speed - speed) * w; }
    weight += w;
  }
  out.density = d;
  out.height = weight > 0 ? height : DEFAULT_FOG_HEIGHT;
  out.speed = weight > 0 ? speed : DEFAULT_FOG_SPEED;
  return out;
}

/**
 * GULLIES where the player wants them. Gullies are cut where runoff gathers
 * on a steep slope with little to hold the soil - their heads lie where the
 * slope and the area draining to a point pass a threshold, and ground cover
 * prevents them (Dewitte et al., "Predicting the susceptibility to gully
 * initiation in data-poor regions", Geomorphology 2015) - so on a grassed,
 * wooded country they are the exception, not every hillside (the player,
 * 2026-10-07: "pontualmente e não em toda elevação"). The land's own gullies
 * (`render/terrainRelief.ts`) stand only on steep ground in scattered
 * patches, as many as the map's setting asks; this brush lays more where the
 * player wants them, or wipes them away. The document keeps the dabs.
 */

export interface GullyDab {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  /** 0..1 at the centre. */
  readonly strength: number;
  /** Wipes gullies away (the land's own too) instead of cutting them. */
  readonly erase?: boolean;
}

/** A map keeps at most this many gully dabs; the oldest go first. */
export const MAX_GULLY_DABS = 20_000;
/** How much of the steep land carries gullies of itself, 0..1, when the map says nothing. */
export const DEFAULT_GULLY_AUTO = 0.25;

export function readGullyDab(data: unknown): GullyDab | null {
  const d = data as Partial<Record<keyof GullyDab, unknown>> | null;
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!d || !finite(d.x) || !finite(d.y) || !finite(d.radius) || !finite(d.strength)) return null;
  return { x: d.x, y: d.y, radius: Math.max(1, d.radius), strength: Math.min(1, Math.max(0, d.strength)), ...(d.erase === true ? { erase: true } : {}) };
}

/**
 * The dabs at a point: how much they cut (0..1) and how much they wipe away
 * (0..1), each dab in turn with a smooth falloff to its rim - cutting lifts
 * the first and lowers the second, erasing the other way round.
 */
export function gulliesAt(dabs: readonly GullyDab[], x: number, y: number): { cut: number; wipe: number } {
  let cut = 0, wipe = 0;
  for (const dab of dabs) {
    const r = Math.hypot(x - dab.x, y - dab.y) / dab.radius;
    if (r >= 1) continue;
    const s = 1 - r * r;
    const w = s * s * dab.strength;
    if (dab.erase) { wipe += (1 - wipe) * w; cut *= 1 - w; } else { cut += (1 - cut) * w; wipe *= 1 - w; }
  }
  return { cut, wipe };
}

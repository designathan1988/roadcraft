/** GULLIES where the player wants them. */

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

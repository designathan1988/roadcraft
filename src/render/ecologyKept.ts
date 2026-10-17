import { Digest } from '@core/digest';
import { derivedCacheOpen, keepDerivedQueued, readDerived } from './derivedCache';
import { computeEcology, type EcologyField, type EcologyInput } from '@world/ecology';
import { type FarWoods, type FarWoodsAsk, type FarWoodsWork, farWoods } from './farWoods';

/** A PLATE'S ECOSYSTEM AND ITS FAR WOODS KEPT IN THE PLAYER'S BROWSER (`core/derivedCache.ts`), read back before they are worked out: DO NOT work out on every load what the same land, water, rock and paint gave last time (~5.6 s of a worker at a reload) */

declare const __ECOLOGY_HASH__: string | undefined;
declare const __FAR_WOODS_HASH__: string | undefined;
/** The fingerprints of the code they are worked out by (`cook-plugin.ts`): kept under them; none (tests): nothing kept. */
export const ECOLOGY_HASH = typeof __ECOLOGY_HASH__ !== 'undefined' && __ECOLOGY_HASH__ ? __ECOLOGY_HASH__ : null;
export const WOODS_HASH = typeof __FAR_WOODS_HASH__ !== 'undefined' && __FAR_WOODS_HASH__ ? __FAR_WOODS_HASH__ : null;
export const ECOLOGY_PREFIX = ECOLOGY_HASH ? `ecology:${ECOLOGY_HASH}:` : null;
export const WOODS_PREFIX = WOODS_HASH ? `farWoods:${WOODS_HASH}:` : null;

/** Where they are kept: one entry a plate (by its centre), its land's digest beside it, written over when the land changes (the store never grows with the edits). */
export interface EcologyCache {
  ready(): Promise<boolean>;
  get(key: string): Promise<unknown>;
  /** Resolved once the store took its copy (the arrays may be transferred after). */
  put(key: string, value: unknown): Promise<void>;
}

export const derivedEcologyCache: EcologyCache = {
  ready: derivedCacheOpen,
  get: (key) => readDerived(key),
  // IndexedDB copies the value when `put` is called (W3C IndexedDB, "clone a value"): queued is enough before the arrays go to the page.
  put: (key, value) => keepDerivedQueued(key, value),
};

interface Kept<T> { readonly digest: number; readonly value: T }

/** Everything a plate's field is read from: the grid, its place, the settings, the land, the water, the rock and the paint. */
export function ecologyDigest(input: EcologyInput): number {
  const d = new Digest().add(input.side).add(input.cell).add(input.centre?.x ?? NaN).add(input.centre?.y ?? NaN).addPlain(input.settings);
  d.addAll(input.heights).addAll(input.water).addAll(input.sandstone).addAll(input.basalt);
  if (input.painted) d.addAll(input.painted); else d.add(-1);
  return d.value();
}

/** A plate's field: the one kept for the same land when there is one, else worked out and kept. */
export async function keptEcology(input: EcologyInput, cache: EcologyCache = derivedEcologyCache, prefix: string | null = ECOLOGY_PREFIX): Promise<EcologyField> {
  if (prefix === null || !input.centre || !(await cache.ready())) return computeEcology(input);
  const key = `${prefix}${input.centre.x},${input.centre.y}`;
  const digest = ecologyDigest(input);
  const kept = await cache.get(key) as Kept<EcologyField> | undefined;
  if (kept?.digest === digest) return kept.value;
  const field = computeEcology(input);
  await cache.put(key, { digest, value: field } satisfies Kept<EcologyField>);
  return field;
}

/** A far plate's woods: the ones kept for the same ask (its land is the relief's, its ecosystem the settings') when there are some, else worked out and kept. */
export async function keptWoods(ask: FarWoodsAsk, work: FarWoodsWork, cache: EcologyCache = derivedEcologyCache, prefix: string | null = WOODS_PREFIX): Promise<FarWoods> {
  if (prefix === null || !(await cache.ready())) return farWoods(ask, work);
  const key = `${prefix}${ask.cx},${ask.cy}`;
  const digest = new Digest().addPlain(ask).value();
  const kept = await cache.get(key) as Kept<FarWoods> | undefined;
  if (kept?.digest === digest) return kept.value;
  const woods = farWoods(ask, work);
  await cache.put(key, { digest, value: woods } satisfies Kept<FarWoods>);
  return woods;
}

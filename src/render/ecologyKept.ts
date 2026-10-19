import { Digest } from '@core/digest';
import { WriteBudget, derivedCacheOpen, keepDerivedQueuedMany, readDerived } from './derivedCache';
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

/** Bytes of plates' fields this thread may have handed IndexedDB and not seen committed (a near plate ~5 MB): the writes past it wait (`WriteBudget`, the V8 cage). */
const ECOLOGY_WRITES_MOST = 32 * 2 ** 20;

/** The derived cache under a write budget of its own: one a thread that works the plates out (`ecology.worker.ts`). */
export function derivedEcologyCache(budget = new WriteBudget(ECOLOGY_WRITES_MOST)): EcologyCache {
  return {
    ready: derivedCacheOpen,
    get: (key) => readDerived(key),
    // IndexedDB copies the value when `put` is called (W3C IndexedDB, "clone a value"): queued is enough before the arrays go to the page.
    put: (key, value) => keepDerivedQueuedMany([[key, value]], budget),
  };
}

interface Kept<T> { readonly digest: number; readonly value: T }

/** Where an entry's digest is kept beside it, a few bytes: read first, so a plate whose land changed is not read whole (~5 MB) only to be found out of date (VEG-13). */
const digestKey = (key: string): string => `${key}:d`;

/** The entry kept for `digest`, or undefined: the whole entry read only when its digest beside it is the same, or when there is none beside it (an entry kept before the digests were). */
async function keptFor<T>(cache: EcologyCache, key: string, digest: number): Promise<T | undefined> {
  const beside = await cache.get(digestKey(key));
  if (typeof beside === 'number' && beside !== digest) return undefined;
  const kept = await cache.get(key) as Kept<T> | undefined;
  return kept?.digest === digest ? kept.value : undefined;
}

/** Keeps an entry and its digest beside it. */
async function keep<T>(cache: EcologyCache, key: string, digest: number, value: T): Promise<void> {
  await cache.put(key, { digest, value } satisfies Kept<T>);
  await cache.put(digestKey(key), digest);
}

/** Everything a plate's field is read from: the grid, its place, the settings, the land, the water, the rock and the paint. */
export function ecologyDigest(input: EcologyInput): number {
  const d = new Digest().add(input.side).add(input.cell).add(input.centre?.x ?? NaN).add(input.centre?.y ?? NaN).addPlain(input.settings);
  d.addAll(input.heights).addAll(input.water).addAll(input.sandstone).addAll(input.basalt);
  if (input.painted) d.addAll(input.painted); else d.add(-1);
  return d.value();
}

/** A plate's field: the one kept for the same land when there is one, else worked out and kept. */
export async function keptEcology(input: EcologyInput, cache: EcologyCache, prefix: string | null = ECOLOGY_PREFIX): Promise<EcologyField> {
  if (prefix === null || !input.centre || !(await cache.ready())) return computeEcology(input);
  const key = `${prefix}${input.centre.x},${input.centre.y}`;
  const digest = ecologyDigest(input);
  const kept = await keptFor<EcologyField>(cache, key, digest);
  if (kept !== undefined) return kept;
  const field = computeEcology(input);
  await keep(cache, key, digest, field);
  return field;
}

/** A far plate's woods: the ones kept for the same ask (its land is the relief's, its ecosystem the settings') when there are some, else worked out and kept. */
export async function keptWoods(ask: FarWoodsAsk, work: FarWoodsWork, cache: EcologyCache, prefix: string | null = WOODS_PREFIX): Promise<FarWoods> {
  if (prefix === null || !(await cache.ready())) return farWoods(ask, work);
  const key = `${prefix}${ask.cx},${ask.cy}`;
  const digest = new Digest().addPlain(ask).value();
  const kept = await keptFor<FarWoods>(cache, key, digest);
  if (kept !== undefined) return kept;
  const woods = farWoods(ask, work);
  await keep(cache, key, digest, woods);
  return woods;
}

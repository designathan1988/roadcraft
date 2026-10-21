import { afterEach, describe, expect, it, vi } from 'vitest';
import { COOKED_CITY_SEEDS, readCookedCity } from '@editor/cookedCities';

describe('the cities shipped with the game', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  it('is read only for its own seed, by the generator that grew it', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ hash: 'abc', cities: { large: { seed: COOKED_CITY_SEEDS.large, data: 'd', table: 't' } } })));
    vi.stubGlobal('fetch', fetch);
    // Another seed: nothing asked of the disk.
    expect(await readCookedCity('/', 'abc', 'large', COOKED_CITY_SEEDS.large + 1)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    // Another generator: the manifest read, the city not.
    const { readCookedCity: fresh } = await import('@editor/cookedCities');
    expect(await fresh('/', 'other', 'large', COOKED_CITY_SEEDS.large)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('is never read without the generator\'s fingerprint', async () => {
    expect(await readCookedCity('/', null, 'small', COOKED_CITY_SEEDS.small)).toBeNull();
  });
});

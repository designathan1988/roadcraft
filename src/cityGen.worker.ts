import type { SerializedDoc } from '@world/doc';
import { buildLargeCityMap, buildSmallCityMap } from './editor/smallCityMap';
import { prepareCity } from './editor/preparedCity';
import type { JobScope } from './jobs/jobScope';

/** THE CITY MADE OFF THE PAGE (`main.ts` `cityData`): the game's own generator (`buildCityMap`) building a whole finite city in a job worker, so the page is not frozen for its seconds. */

export interface CityGenAsk {
  readonly id: number;
  /** The small city, or the same city made larger (`largeCity.ts`). */
  readonly kind: 'small' | 'large';
  readonly seed?: number;
}

/** `buildings`: the city's buildings as one shared table (`prepareCity`), its `data` holding none: the page reads them from it (`preparedCity`). */
export type CityGenReply = { readonly id: number; readonly data?: SerializedDoc; readonly buildings?: ArrayBufferLike; readonly error?: string };

export function serve(scope: JobScope): void {
  scope.onmessage = (event: MessageEvent<CityGenAsk>) => {
    const ask = event.data;
    try {
      const { data, buildings } = prepareCity(ask.kind === 'large' ? buildLargeCityMap(ask.seed ?? 7) : buildSmallCityMap(ask.seed ?? 7));
      scope.postMessage({ id: ask.id, data, buildings } satisfies CityGenReply);
    } catch (error) {
      scope.postMessage({ id: ask.id, error: String((error as Error)?.stack ?? error) } satisfies CityGenReply);
    }
  };
}

import { type CityOptions, DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import type { SerializedDoc } from '@world/doc';
import { buildCityMap, buildSmallCityMap } from './editor/smallCityMap';
import type { JobScope } from './jobs/jobScope';

/** THE CITY MADE OFF THE PAGE (`main.ts` `cityData`): the game's own generator (`buildCityMap`) building a whole finite city in a job worker, so the page is not frozen for its seconds — and, later, for the city to be built in sectors. */

export interface CityGenAsk {
  readonly id: number;
  readonly kind: 'small' | 'planned';
  readonly seed?: number;
  readonly options?: Partial<CityOptions>;
}

export type CityGenReply = { readonly id: number; readonly data?: SerializedDoc; readonly error?: string };

export function serve(scope: JobScope): void {
  scope.onmessage = (event: MessageEvent<CityGenAsk>) => {
    const ask = event.data;
    try {
      const data = ask.kind === 'small'
        ? buildSmallCityMap(ask.seed ?? 7)
        : buildCityMap(planCity({ ...DEFAULT_CITY, ...ask.options }));
      scope.postMessage({ id: ask.id, data } satisfies CityGenReply);
    } catch (error) {
      scope.postMessage({ id: ask.id, error: String((error as Error)?.stack ?? error) } satisfies CityGenReply);
    }
  };
}

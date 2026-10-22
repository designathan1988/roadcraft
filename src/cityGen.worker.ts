import type { SerializedDoc } from '@world/doc';
import { buildCityTableOf } from './editor/smallCityMap';
import type { JobScope } from './jobs/jobScope';

/** THE CITY MADE OFF THE PAGE (`main.ts` `cityData`): the game's own generator (`buildCityTable`) building a whole finite city in a job worker, so the page is not frozen for its seconds. */

export interface CityGenAsk {
  readonly id: number;
  /** The small city, or the same city made larger (`largeCity.ts`). */
  readonly kind: 'small' | 'large';
  readonly seed?: number;
  /** The large city over another radius, world units (the scale steps); absent, the large city's own. */
  readonly radius?: number;
}

/** `buildings`: the city's buildings as one table (`buildCityTable`, as `prepareCity` makes it), its `data` holding none: the page reads them from it (`preparedCity`). */
export type CityGenReply = { readonly id: number; readonly data?: SerializedDoc; readonly buildings?: ArrayBufferLike; readonly error?: string };

export function serve(scope: JobScope): void {
  scope.onmessage = (event: MessageEvent<CityGenAsk>) => {
    const ask = event.data;
    try {
      // DO NOT grow the whole city as objects and prepare it after (`prepareCity`): `buildCityTable` spills its buildings into tables as they grow.
      const { data, buildings } = buildCityTableOf(ask.kind, ask.seed ?? 7, ask.radius);
      // The table moved, not copied, where it is a plain buffer (in shared memory it is posted as a handle, MDN "SharedArrayBuffer").
      scope.postMessage({ id: ask.id, data, buildings } satisfies CityGenReply, buildings instanceof ArrayBuffer ? [buildings] : []);
    } catch (error) {
      scope.postMessage({ id: ask.id, error: String((error as Error)?.stack ?? error) } satisfies CityGenReply);
    }
  };
}

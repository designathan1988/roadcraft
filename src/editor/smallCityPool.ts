import type { SerializedDoc } from '@world/doc';
import { jobPort } from '../jobs/jobPool';
import { buildSmallCityMap } from './smallCityMap';

/** THE SMALL CITY ASKED OF A JOB WORKER (`smallCity.worker.ts`); made on the page only where no worker can run (the tests, a page without workers). */

/** A city made: its document, and whether its buildings came ready to be filed as they are (`BuildingStore.loadPrepared`). */
export interface MadeCity {
  readonly data: SerializedDoc;
  readonly prepared: boolean;
}

export interface SmallCityMaker {
  /** The document of the small city of `seed`, made off the page's thread when a worker can. */
  make(seed: number): Promise<MadeCity>;
}

/** A maker with its own lane, made on the first city asked for and kept: the module it loads is the city generator, loaded once. */
export function createSmallCityMaker(): SmallCityMaker {
  let lane: Worker | null = null;
  let next = 1;
  const waiting = new Map<number, (made: MadeCity | null) => void>();
  const onPage = (seed: number): MadeCity => ({ data: buildSmallCityMap(seed), prepared: false });
  return {
    make(seed) {
      if (typeof Worker === 'undefined') return Promise.resolve(onPage(seed));
      if (!lane) {
        lane = jobPort('smallCity');
        lane.onmessage = (event: MessageEvent<{ readonly id: number; readonly data?: SerializedDoc; readonly prepared?: boolean; readonly error?: string }>) => {
          const answer = waiting.get(event.data.id);
          waiting.delete(event.data.id);
          if (event.data.error) console.error('[smallCity] the worker could not make the city; made on the page', event.data.error);
          answer?.(event.data.data ? { data: event.data.data, prepared: event.data.prepared === true } : null);
        };
      }
      const id = next++;
      return new Promise<MadeCity | null>((done) => {
        waiting.set(id, done);
        lane!.postMessage({ id, seed });
      }).then((made) => made ?? onPage(seed));
    },
  };
}

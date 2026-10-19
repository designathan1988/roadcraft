import type { SerializedDoc } from '@world/doc';
import { jobPort } from '../jobs/jobPool';
import { buildSmallCityMap } from './smallCityMap';

/** THE SMALL CITY ASKED OF A JOB WORKER (`smallCity.worker.ts`); made on the page only where no worker can run (the tests, a page without workers). */
export interface SmallCityMaker {
  /** The document of the small city of `seed`, made off the page's thread when a worker can. */
  make(seed: number): Promise<SerializedDoc>;
}

/** A maker with its own lane, made on the first city asked for and kept: the module it loads is the city generator, loaded once. */
export function createSmallCityMaker(): SmallCityMaker {
  let lane: Worker | null = null;
  let next = 1;
  const waiting = new Map<number, (data: SerializedDoc | null) => void>();
  return {
    make(seed) {
      if (typeof Worker === 'undefined') return Promise.resolve(buildSmallCityMap(seed));
      if (!lane) {
        lane = jobPort('smallCity');
        lane.onmessage = (event: MessageEvent<{ readonly id: number; readonly data?: SerializedDoc; readonly error?: string }>) => {
          const answer = waiting.get(event.data.id);
          waiting.delete(event.data.id);
          if (event.data.error) console.error('[smallCity] the worker could not make the city; made on the page', event.data.error);
          answer?.(event.data.data ?? null);
        };
      }
      const id = next++;
      return new Promise<SerializedDoc | null>((done) => {
        waiting.set(id, done);
        lane!.postMessage({ id, seed });
      }).then((data) => data ?? buildSmallCityMap(seed));
    },
  };
}

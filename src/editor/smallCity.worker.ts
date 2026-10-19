import type { JobScope } from '../jobs/jobScope';
import { preparedSmallCity } from './smallCityMap';

/** THE SMALL CITY MADE OFF THE PAGE (`smallCityPool.ts`): a service of the job system (`job.worker.ts`). The city's plan, its document, its lots,
 *  green, zones and every building grown were one task of 1.6 s on the page's thread at every new city (the probe, 2026-10-19); here they are
 *  the worker's, and the page only takes the document. */
export function serve(self: JobScope): void {
  self.onmessage = (event: MessageEvent<{ readonly id: number; readonly seed: number }>) => {
    const { id, seed } = event.data;
    try {
      const data = preparedSmallCity(seed);
      self.postMessage({ id, data, prepared: true });
    } catch (error) {
      // Said here and on the page, which makes the city itself then (`smallCityPool.ts`).
      console.error('[smallCity] the city could not be made in the worker', error);
      self.postMessage({ id, error: String(error) });
    }
  };
}

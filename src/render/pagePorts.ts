import type { JobService } from '../jobs/jobScope';

/** The job system's lanes as the people's pools ask them (`bakePool.ts`, `people/garmentPaddingPool.ts`): handed in by the page that draws people (`agents.ts`); none given, the work runs where it is asked */
/** DO NOT import the job system where a cooked body is read: the people's cook fingerprint (`cook-plugin.ts` importClosure of `riggedCitizens.ts`) read every worker of the pool through it, a bake's code changed by code no cooked body is made with. */

const providers = new Map<JobService, () => Worker>();

/** The page's lanes of `service` (`jobPort`), given once. */
export function provideLanes(service: JobService, port: () => Worker): void {
  providers.set(service, port);
}

/** A new lane of `service` where the page gave them; null: none (tests, a page that draws no one). */
export function laneOf(service: JobService): Worker | null {
  const port = providers.get(service);
  return port ? port() : null;
}

/** Whether the page gave lanes of `service`. */
export const hasLanes = (service: JobService): boolean => providers.has(service);

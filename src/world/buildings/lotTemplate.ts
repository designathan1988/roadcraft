import type { Building } from './types';
import type { ZoneDensity, ZoneUse } from '../zones';

/**
 * A lot kept in the lot lab's library (`?lab=lots`, `editor/lotLab.ts`,
 * `lot-library-plugin.ts`): the building record in its lot's frame (origin at
 * the front middle, the street ahead), with the zone it was grown for.
 */
export interface LotTemplate {
  readonly name: string;
  readonly use: ZoneUse;
  readonly density: ZoneDensity;
  readonly savedAt: string;
  readonly body: Omit<Building, 'id' | 'x' | 'y' | 'rotation' | 'builtAt' | 'decay'>;
}

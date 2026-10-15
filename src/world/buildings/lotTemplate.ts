import type { Building } from './types';
import type { ZoneDensity, ZoneUse } from '../zones';

/** A lot kept in the lot lab's library (`?lab=lots`, `editor/lotLab.ts`, `lot-library-plugin.ts`) */
export interface LotTemplate {
  readonly name: string;
  readonly use: ZoneUse;
  readonly density: ZoneDensity;
  readonly savedAt: string;
  readonly body: Omit<Building, 'id' | 'x' | 'y' | 'rotation' | 'builtAt' | 'decay'>;
}

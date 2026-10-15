import type { RoadType } from '@world/roadTypes';
import { plural, t } from './i18n';

/** Turns model values into text for the interface. */

export const roadTypeName = (type: RoadType): string => t(type.nameKey);

/** The one-line description under a class name, with its lane count filled in. */
export function roadTypeDescription(type: RoadType): string {
  if (type.subLanes === null) return t(type.subKey);
  return t(type.subKey, {
    count: type.subLanes,
    way: t(type.subOneWay ? 'road.way.one' : 'road.way.two'),
  });
}

export const roadCountLabel = (count: number): string => plural('status.roads', count);
export const nodeCountLabel = (count: number): string => plural('status.nodes', count);
export const vehicleCountLabel = (count: number): string => plural('status.vehicles', count);
export const peopleCountLabel = (count: number): string => plural('status.people', count);

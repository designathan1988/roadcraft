import type { SegmentParking } from '@world/parking';

/**
 * The parking a new road is drawn with, chosen in the road tool's options as
 * Cities: Skylines II offers road variants: none, or bays along the kerb on
 * both sides or on one. Left and right are of the drawing direction. Kept for
 * the session, like the snapping.
 */
export const ROAD_PARKING_PRESETS = ['none', 'parallel', 'parallelRight', 'parallelLeft', 'cycle', 'cycleParking'] as const;
export type RoadParkingPreset = (typeof ROAD_PARKING_PRESETS)[number];

const KEY = 'roadcraft.roadParking';
let preset: RoadParkingPreset = 'none';
try {
  const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
  if (raw && (ROAD_PARKING_PRESETS as readonly string[]).includes(raw)) preset = raw as RoadParkingPreset;
} catch {
  // Not kept: the default stands.
}

export function roadParkingPreset(): RoadParkingPreset {
  return preset;
}

export function setRoadParkingPreset(next: RoadParkingPreset): void {
  preset = next;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, next);
  } catch {
    // Not kept between sessions; it still applies now.
  }
}

/** The parking of a road drawn with the current preset, or undefined for none. */
export function roadParking(): SegmentParking | undefined {
  switch (preset) {
    case 'parallel': return { left: 'parallel', right: 'parallel' };
    case 'parallelRight': return { left: 'none', right: 'parallel' };
    case 'parallelLeft': return { left: 'parallel', right: 'none' };
    // Cycle lanes both sides; or one side cycling, the other parking.
    case 'cycle': return { left: 'cycle', right: 'cycle' };
    case 'cycleParking': return { left: 'parallel', right: 'cycle' };
    default: return undefined;
  }
}

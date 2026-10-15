import type { RoadProfileSpec } from '@world/roads/profile';

/** The profile the road tool lays new roads with, chosen in the profile editor */
export interface DrawProfile {
  readonly name: string;
  readonly type: number;
  readonly profile: RoadProfileSpec;
}

let chosen: DrawProfile | null = null;

export function drawProfile(): DrawProfile | null {
  return chosen;
}

export function setDrawProfile(next: DrawProfile | null): void {
  chosen = next;
}

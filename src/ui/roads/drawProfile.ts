import type { RoadProfileSpec } from '@world/roads/profile';

/**
 * The profile the road tool lays new roads with (docs/VIAS.md V2), chosen in
 * the profile editor ("Draw with this profile"), or null for the class's own
 * with the tool's lanes, width and parking. A choice of the tool, like its
 * width (`toolChoices.ts`), not part of any map.
 */
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

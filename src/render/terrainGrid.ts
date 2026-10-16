import { PLATE_SIZE } from '@world/bounds';

/** THE TERRAIN PLATE'S GRID: its numbers alone, for the workers (`buildings/buildingMesh.ts`) that must not load the page's terrain (`terrain.ts`) and its pools */

/** Side of one terrain plate, in world units: the map is laid in square plates */
export const TERRAIN_SIZE = PLATE_SIZE;
/** Cells per side: 320 cells of 6.4 m (`world/bounds.ts` PLATE_SIZE), fine enough for a brush. */
export const TERRAIN_SEGMENTS = 320;
/** World size of one terrain quad. */
export const TERRAIN_CELL = TERRAIN_SIZE / TERRAIN_SEGMENTS;
/** Half the terrain plate's extent. */
export const TERRAIN_HALF = TERRAIN_SIZE / 2;

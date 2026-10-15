import type { RoadDoc } from '@world/doc';
import type { GroundAt, PavedAt } from '@world/buildings/foundation';
import type { Building, BuildingId } from '@world/buildings/types';
import type { BuildingChunk } from './buildingMesh';
import type { BuildingKit } from './kit';
import type { Group } from 'three';

/** DO NOT put the detail of every cell together again, and DO NOT hold a far cell's detail for a while */
export interface BuildingPreviewInput {
  readonly building: Building;
  readonly valid: boolean;
  readonly hides: BuildingId | null;
  readonly serial: number;
  /** Drawn in the building's own materials, not as a ghost (the interior view). */
  readonly solid?: boolean;
}

export interface BuildingLayer {
  readonly group: Group;
  readonly triangles: number;
  /** Bumped whenever the stored buildings are rebuilt. */
  readonly version: number;
  /** A change is still being made: masses or near cells asked of the workers and not come. */
  readonly pending: boolean;
  /** Nothing is being shown (a map loading behind its curtain, `SceneHandle.opening`). */
  hidden: boolean;
  /** Rebuilds what is stale. */
  update(doc: RoadDoc, groundAt: GroundAt, groundKey: string, pavedAt?: PavedAt, naturalAt?: GroundAt,
    groundTouched?: (b: Building, sinceKey: string) => boolean,
    /** The buildings a change of the ground since `sinceKey` reached (found by place); null when that cannot be said */
    groundMovedUnder?: (sinceKey: string) => readonly Building[] | null): boolean;
  setPreview(preview: BuildingPreviewInput | null): void;
  /** "See inside": every building within `radius` of (x, y) is drawn cut open at `level`, its rooms and furniture showing */
  setCutaway(spec: CutawaySpec | null): void;
  /** Windows lit from inside at night, as many as are awake at `hour` (see `BuildingKit.setNight`). */
  setNight(dark: number, hour?: number): void;
  /** From afar (true) the frames and railings are drawn by their street faces only. */
  setFar(far: boolean): void;
  /** Thin facade parts stop casting shadows when their shadow width is subpixel. */
  setShadowFar(far: boolean): void;
  /** The frames, railings and louvres of each cell: drawn while its buildings are */
  cullDetails(eyeX: number, eyeY: number, eyeZ: number, pxAtMetre: number, orthoPx: number | null): void;
  /** Each cell of buildings drawn near (in detail) or far (its buildings' masses, `massCells.ts`) by the error on the screen */
  levelOfDetail(eyeX: number, eyeY: number, eyeZ: number, pxAtMetre: number, orthoPx: number | null, reach?: number): void;
  /** "Ocultar outros": undefined draws every building solid, null fades them all */
  setDimmed(except: BuildingId | null | undefined): void;
  /** Buildings drawn by someone else (a ruin being knocked down, `destruction.ts`): left out here. */
  setRuined(ids: ReadonlySet<number>): void;
  /** A building's meshes as drawn (world space), with the kit they are drawn with: what a ruin is cut from. */
  chunkOf(b: Building): { chunk: BuildingChunk; kit: BuildingKit } | null;
  /** The kit its buildings are drawn with (for warming the shaders broken buildings use). */
  readonly kit: BuildingKit;
  /** Whether a world point is under a building (for the scenery's plant cull). */
  covers(x: number, y: number): boolean;
  /** Bumped when what `covers` answers changes (a footprint or a lot moved, came or went). */
  readonly coversVersion: number;
  /** Height of a building's lot or parking bay as drawn at a world point, NaN off them */
  lotHeightAt(building: BuildingId, x: number, y: number): number;
  /** The drawn height of whichever building's lot is at a point, NaN off every lot. */
  anyLotHeightAt(x: number, y: number): number;
  /** A WebGL context restored (`mesh/gpuOnly.ts`): every cell made again, its arrays having been let go. */
  refill(): void;
  dispose(): void;
}

export interface CutawaySpec {
  readonly level: number;
  /** The way the camera looks, world and horizontal: the walls facing it come down. */
  readonly view: { readonly x: number; readonly y: number };
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  /** Only this building is cut open (the one the player clicked); the rest stand whole. */
  readonly only?: BuildingId;
}

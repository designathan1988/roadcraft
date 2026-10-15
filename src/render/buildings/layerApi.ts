import type { RoadDoc } from '@world/doc';
import type { GroundAt, PavedAt } from '@world/buildings/foundation';
import type { Building, BuildingId } from '@world/buildings/types';
import type { BuildingChunk } from './buildingMesh';
import type { BuildingKit } from './kit';
import type { Group } from 'three';

/**
 * The buildings layer: the stored buildings and the editor's preview, each rebuilt only when what it
 * depends on moves (CLAUDE.md (Execution flow)). The stored buildings depend on their changes in the
 * diary (`townIndex.ts`), on the ground (`groundKey`, `render/groundChanges.ts`) and on which one the
 * preview stands in for; a building samples its ground again only when `groundTouched` says a change
 * reached it. The preview depends on its own serial.
 *
 * HLOD WITH STREAMING: a cell's detail (`BATCH_CELL`) exists only while the cell is drawn near by the
 * error on the screen (`massCells.ts`); far, only its masses stand. A cell coming near is asked of the
 * cell workers (`cellRequests.ts`), sent to the GPU when it lands and only then shown, whole; drawn far,
 * its meshes go at once, its chunks as the workers' cache allows (the far level's own margin,
 * `massCells.ts` HYSTERESIS, keeps a cell at the edge from going and coming; Cesium unloads the tiles
 * not selected the frame before, `trimLoadedTiles`). Unreal's World Partition HLOD, 3D Tiles' REPLACE
 * refinement. DO NOT put the detail of every cell together again, and DO NOT hold a far cell's detail
 * for a while (it was ten seconds, `RELEASE_FRAMES`): every view the camera passed through stayed on
 * the GPU with the one it looked at (two close views of a street, GL_OUT_OF_MEMORY, 2026-10-14).
 *
 * THE CELLS ARE MADE IN WORKERS (`cellWork.ts`): the page sends each building's record and ground and gets
 * the cell's batches back as arrays. DO NOT emit or join buildings here: it was most of a big city's lost
 * frames (11.6 of 114 s in the 2,560 m city, frames of up to 1.4 s, 2026-10-14). A building asked for at
 * once (`chunkOf`, a ruin) and the preview are the only ones emitted on the page.
 */
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
  /**
   * Nothing is being shown (a map loading behind its curtain, `SceneHandle.opening`). Read by
   * nothing here any more: the layer makes nothing a slice a frame (the cells and their masses come
   * from the workers).
   */
  hidden: boolean;
  /**
   * Rebuilds what is stale. Returns true if the stored buildings were rebuilt.
   * `pavedAt` is the paving (footways, carriageways) entrances open onto.
   */
  update(doc: RoadDoc, groundAt: GroundAt, groundKey: string, pavedAt?: PavedAt, naturalAt?: GroundAt,
    groundTouched?: (b: Building, sinceKey: string) => boolean,
    /**
     * The buildings a change of the ground since `sinceKey` reached (found by
     * place); null when that cannot be said (the whole town then). Absent: any
     * new ground key puts the town together again.
     */
    groundMovedUnder?: (sinceKey: string) => readonly Building[] | null): boolean;
  setPreview(preview: BuildingPreviewInput | null): void;
  /**
   * "See inside": every building within `radius` of (x, y) is drawn cut open
   * at `level`, its rooms and furniture showing; null draws them whole.
   */
  setCutaway(spec: CutawaySpec | null): void;
  /** Windows lit from inside at night, as many as are awake at `hour` (see `BuildingKit.setNight`). */
  setNight(dark: number, hour?: number): void;
  /** From afar (true) the frames and railings are drawn by their street faces only. */
  setFar(far: boolean): void;
  /** Thin facade parts stop casting shadows when their shadow width is subpixel. */
  setShadowFar(far: boolean): void;
  /**
   * The frames, railings and louvres of each cell: drawn while its buildings
   * are (their far level decides, `levelOfDetail`, by the error on the
   * screen), whole where a frame's side spans enough pixels and by their
   * street faces beyond. The eye and the screen as `levelOfDetail` takes them.
   */
  cullDetails(eyeX: number, eyeY: number, eyeZ: number, pxAtMetre: number, orthoPx: number | null): void;
  /**
   * Each cell of buildings drawn near (in detail) or far (its buildings'
   * masses, `massCells.ts`) by the error on the screen: from the eye (map
   * x/y and height), `pxAtMetre` the pixels a metre spans a metre away in a
   * perspective view, or `orthoPx` the pixels a metre spans in an
   * orthographic one (null in perspective); `reach` how far from the eye,
   * on the map, a cell may still be near (the ground the screen takes in,
   * with a margin; Infinity for no limit). Before `cullDetails`.
   */
  levelOfDetail(eyeX: number, eyeY: number, eyeZ: number, pxAtMetre: number, orthoPx: number | null, reach?: number): void;
  /**
   * "Ocultar outros": undefined draws every building solid, null fades them
   * all, and an id fades every building but that one.
   */
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
  /**
   * Height of a building's lot or parking bay as drawn at a world point, NaN
   * off them: what a resident's parked car stands on (`render/agents.ts`).
   */
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

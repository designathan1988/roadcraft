import type { RoadDoc } from '@world/doc';
import type { GroundAt, PavedAt } from '@world/buildings/foundation';
import type { Building, BuildingId } from '@world/buildings/types';
import type { BuildingChunk } from './buildingMesh';
import type { FrameScale } from './frameBudget';
import type { BuildingKit } from './kit';
import type { Frustum, Group, Object3D } from 'three';

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
  /** The highest point of any building drawn, world height (-Infinity with none): kept as cells land, never a walk of the meshes. */
  readonly top: number;
  /** A change is still being made: masses or near cells asked of the workers and not come. */
  readonly pending: boolean;
  /** The coarse levels still to come: masses and far levels asked of the workers (never the near cells' detail: the opening shows the town with its masses, the detail lands after, `renderer.ts` reveal). */
  readonly coarsePending: boolean;
  /** The near cells the view wants in detail and that have not landed (in its frustum): what the opening waits for besides the coarse levels (CLAUDE.md "abrir"). */
  readonly viewPending: boolean;
  /** Nothing is being shown (a map loading behind its curtain, `SceneHandle.opening`). */
  hidden: boolean;
  /** Rebuilds what is stale. */
  update(doc: RoadDoc, groundAt: GroundAt, groundKey: string, pavedAt?: PavedAt, naturalAt?: GroundAt,
    /** The buildings a change of the ground since `sinceKey` reached (found by place, once a key: `digestFor`); null when that cannot be said */
    groundMovedUnder?: (sinceKey: string) => readonly Building[] | null): boolean;
  setPreview(preview: BuildingPreviewInput | null): void;
  /** "See inside": every building within `radius` of (x, y) is drawn cut open at `level`, its rooms and furniture showing */
  setCutaway(spec: CutawaySpec | null): void;
  /** Windows lit from inside at night, as many as are awake at `hour` (see `BuildingKit.setNight`). */
  setNight(dark: number, hour?: number): void;
  /** The parts of each cell drawn in detail, each kind at the coarsest level whose error is under a pixel, none under a pixel, its shadow only over `shadowTexel` (m; Infinity without shadows) */
  cullDetails(eyeX: number, eyeY: number, eyeZ: number, pxAtMetre: number, orthoPx: number | null, shadowTexel: number): void;
  /** Before a sun cascade is drawn: the parts shown cast into it only where wider than its texel, m (`sunCascades.ts` `setCasters`); `coarse` (a far cascade): every cell in detail casts by its masses, its detail, facade level and parts left out of the pass. null: the passes are done, all drawn as it was. */
  castInto(texel: number | null, coarse?: boolean): void;
  /** Each cell of buildings drawn near (in detail) or far (its buildings' masses, `massCells.ts`) by the error on the screen */
  levelOfDetail(eyeX: number, eyeY: number, eyeZ: number, pxAtMetre: number, orthoPx: number | null, reach?: number, view?: Frustum | null): void;
  /** The most the cells' detail may hold on the GPU, bytes: past it the cells drawn far go first (their masses stand for them). */
  setDetailBudget(bytes: number): void;
  /** What the layer keeps, by book (cells, levels, measures, held back): bounded by the view, never by the road walked (tested walking 2 and 20 tiles). */
  books(): Readonly<Record<string, number>>;
  /** The frame's scale (`frameBudget.ts`): the view's budget of triangles (`core/perfBudget.ts` `VIEW_BUDGETS`), the error scale that fits it (1 draws for 2 px of error, 2 for 4 px...; the roads' reach follows it, `renderer.ts`). */
  readonly frame: FrameScale;
  /** The layer's parts by what they draw, for the effects panel (`effectSwitches.ts`): each hidden on its own to measure it. */
  roots(): Readonly<Record<BuildingRoot, Object3D | null>>;
  /** What the cells' detail holds on the GPU now, bytes. */
  readonly residentBytes: number;
  /** The town's cells by the level chosen and the level shown, those held back by the triangles' budget, and the budgets: asked by the measures (`scripts/lib/measureCity.mjs`), never each frame. */
  levels(): Readonly<Record<string, number>>;
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

/** What the layer draws, part by part: the masses and their far levels, the facade level, the cells in detail, their parts, the signature buildings, the flags. */
export type BuildingRoot = 'masses' | 'facades' | 'cells' | 'parts' | 'signatures' | 'flags';

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

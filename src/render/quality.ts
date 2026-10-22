/** THE GRAPHICS TIERS, and the governor that moves `auto` between them in play (`graphicsWiring.ts`). */

import { m, perM } from '@world/units';

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

/** What every tier above the weak one draws people and vehicles with, as before tiers chose them (`vehicleLevels.ts`, `agents.ts`, `proceduralCrowd.ts`). */
export const VEHICLE_ERROR_PIXELS = 0.5;
export const VEHICLE_WHOLE_CAP = 200;
export const HAIR_STRAND_PEOPLE = 8;

export interface QualitySettings {
  /** Cap on the device pixel ratio the canvas is rendered at. */
  readonly pixelRatio: number;
  readonly shadows: boolean;
  readonly shadowMapSize: number;
  readonly postProcessing: boolean;
  readonly ambientOcclusion: boolean;
  readonly smaa: boolean;
  /** Samples of the scene's multisampled target (MSAA), as many as the GPU has at most. */
  readonly msaa: number;
  /** Ground-truth ambient occlusion at the scene's full resolution, its denoise too; false: at half, scaled up. */
  readonly aoFull: boolean;
  /** AMD FidelityFX Contrast Adaptive Sharpening on the final image, 0 (off) to 1 (strongest). */
  readonly sharpen: number;
  /** Maximum anisotropic filtering taps requested for ground textures. */
  readonly anisotropy: number;
  /** Draw street furniture, kerb detail, parapets and roadside props. */
  readonly detailProps: boolean;
  /** Scatter vegetation over the terrain. */
  readonly vegetation: number;
  /** Blades in the GPU grass field round the camera (`grass.ts`); 0 draws none. */
  readonly grassBlades: number;
  /** The close-zoom texture detail layer (`mesh/detailLayer.ts`). */
  readonly surfaceDetail: boolean;
  /** Zoom below which markings, props and agents stop being drawn. */
  readonly detailCutoffZoom: number;
  /** Crowd detail ceiling: silhouette, wardrobe, or full facial animation. */
  readonly pedestrianDetail: 0 | 1 | 2;
  /** Zoom from which the people inside vehicles are drawn. */
  readonly occupantZoom: number;
  /** A vehicle part's level: the coarsest whose error on the screen stays under this many pixels drawn (`vehicleLevels.ts` ERROR_PIXELS on every tier but the weak one). */
  readonly vehicleErrorPixels: number;
  /** Vehicles drawn whole (body, cabin, wheels apart) at most: the biggest on the screen (`agents.ts`). */
  readonly vehicleWholeCap: number;
  /** People nearest the camera drawn with their hair's strands (`proceduralCrowd.ts`). */
  readonly hairStrandPeople: number;
  /** Soft shadows of drifting clouds over the land (`postprocess.ts`, needs post-processing). */
  readonly cloudShadows: boolean;
  /** The ecosystem's vegetation (`render/nature/`) */
  readonly vegetationDistance: number;
  /** Far plants as impostors - billboards baked from each species. */
  readonly impostors: boolean;
  /** Most birds in the air at once; 0 draws none. */
  readonly birds: number;
  /** Raindrops in the air (the wet ground is drawn on every tier). */
  readonly rain: boolean;
  /** The cloud layer of the play sky. */
  readonly skyClouds: boolean;
  /** Morning mist in the valleys and over the water. */
  readonly mist: boolean;
  /** The spray and mist at the foot of waterfalls (their falling water is drawn on every tier). */
  readonly waterfalls: boolean;
  /** Share of the view's budget of triangles the buildings' levels may add up to (`core/perfBudget.ts` VIEW_BUDGETS, `buildings/frameBudget.ts`): past it their error scale rises. */
  readonly triangleScale: number;
  /** The most the buildings' cells' detail may hold on the GPU, MB (`BuildingLayer.setDetailBudget`). */
  readonly detailMemoryMB: number;
}

/**
 * THE GEOMETRY EACH TIER MAY HOLD ON THE GPU (vertex and index buffers, `memoryCounters.ts` geometryBytes; textures and render targets
 * apart), for cards of 4 to 12 GB: the whole under `totalMB`, the buildings' masses (cells, 1 km tiles, 2 km plates, and the base
 * kept for good, `massCells.ts`) under `massesMB`, the roads' blocks at their full level under `roadsNearMB` and at their far level under
 * `roadsFarMB` (`mesh/roadResidency.ts`: past it a cell's blocks go and the network's far level, `networkFarRoads.ts`, draws it), the far props' and poles' blocks (`viewCells.ts` gpuBudget, 192 MB and 128 MB at ultra) at `viewCellsShare` of their
 * own. What is out of the view goes first, the least recently seen first (Cesium's `cacheBytes` LRU, 3DTilesRendererJS `lruCache`); the
 * buildings' detail (`detailMemoryMB`) gives way to its facade level and masses only when that is not enough (`renderer.ts` governGeometry).
 *
 * | tier   | total | masses | view cells | roads near | roads far | detail at most |
 * |--------|-------|--------|------------|------------|-----------|----------------|
 * | ultra  | 1200  | 320    | 1          | 192        | 160       | 1024           |
 * | high   | 900   | 240    | 0.75       | 128        | 128       | 768            |
 * | medium | 600   | 160    | 0.5        | 96         | 96        | 448            |
 * | low    | 448   | 96     | 0.25       | 48         | 48        | 256            |
 *
 * LOW AT 448: the governor's whole is every holder of the scene (`countMemory` over the scene, what `__roadcraft.memory()` reports:
 * the people, vehicles, props and roads with the buildings). The tiles and plates IN the view that their children draw are let go for
 * the masses' budget too (`massCells.ts` evictLevels): they stood beside them, 125 MB of the 244 MB of masses of the city of 25,000
 * buildings' district view on low. With them gone the game's district view at 1920x1080 holds 425 MB (506 before), the street 404, the
 * map 343 (step-25k on low, 2026-10-21), the Node tour at 1280x720 199 to 311 (`tests/perf/geometryBudget.spec.ts` BUDGET_TIER=low,
 * none chosen coarser). What is left at the district is the view's own need with the detail at its least (21 MB): the cells' masses of
 * the 1.4 km the player keeps every facade in (`DETAIL_REACH`, 132 MB, the triangle budget holding most of them far), the roads (89),
 * the people (23), the far gardens (22). 400 could only be met by drawing that reach in tiles: the budget is set to the need, with room.
 * The whole GPU on low adds the textures (~400 MB in the game) and no render target of its own (no post chain): some 0.85 GB of the
 * 1.4 GB the device's cap gives the weak machine (`gpuLedger.ts` deviceGpuCap: an UHD 770 sharing 8 GB, at 1080p).
 *
 * THE ROADS' WHOLE (`roadBudgetMB`): their near and far levels' budgets, and the network's far level kept for good for the whole map.
 * That last one grows with the map, not with the view: 10 MB for the city of 25,000 buildings (`tests/perf/noHoles.spec.ts`, 21 bytes a
 * vertex), some 80 MB for one of 200,000 by its area; the blocks' far levels it stands for took 264 MB for the 25,000 (2.1 GB for the
 * 200,000), every block of the map kept.
 */
export interface GeometryBudget {
  readonly totalMB: number;
  readonly massesMB: number;
  readonly viewCellsShare: number;
  /** The roads' blocks at their full level (`mesh/roadResidency.ts`): only in the view and under this. */
  readonly roadsNearMB: number;
  /** The roads' blocks at their far level (`mesh/roadResidency.ts`): the cells nearest the view in it, past it the network's far level. */
  readonly roadsFarMB: number;
}
export const GEOMETRY_BUDGETS: Readonly<Record<QualityLevel, GeometryBudget>> = {
  ultra: { totalMB: 1200, massesMB: 320, viewCellsShare: 1, roadsNearMB: 192, roadsFarMB: 160 },
  high: { totalMB: 900, massesMB: 240, viewCellsShare: 0.75, roadsNearMB: 128, roadsFarMB: 128 },
  medium: { totalMB: 600, massesMB: 160, viewCellsShare: 0.5, roadsNearMB: 96, roadsFarMB: 96 },
  low: { totalMB: 448, massesMB: 96, viewCellsShare: 0.25, roadsNearMB: 48, roadsFarMB: 48 },
};

/** The network's far level a city of 25,000 buildings keeps for good (`networkFarRoads.ts`), MB, with room: what `ROAD_BUDGET_MB` counts it at. */
export const NETWORK_FAR_MB = 16;
/** The roads' surfaces' whole on each tier, MB: their near and far levels' budgets and the network's far level (see `GEOMETRY_BUDGETS`). */
export const roadBudgetMB = (budget: GeometryBudget): number => budget.roadsNearMB + budget.roadsFarMB + NETWORK_FAR_MB;

export const QUALITY: Readonly<Record<QualityLevel, QualitySettings>> = {
  low: {
    pixelRatio: 1,
    shadows: false,
    shadowMapSize: 1024,
    postProcessing: false,
    ambientOcclusion: false,
    smaa: false,
    msaa: 0,
    aoFull: false,
    sharpen: 0,
    anisotropy: 2,
    detailProps: false,
    vegetation: 0,
    grassBlades: 0,
    surfaceDetail: false,
    detailCutoffZoom: perM(1.25),
    pedestrianDetail: 0,
    occupantZoom: perM(7.5),
    // The weak machine's integrated GPU: parts a pixel off, fewer whole vehicles, strands on the two nearest (the other tiers draw as they always did).
    vehicleErrorPixels: 1,
    vehicleWholeCap: 60,
    hairStrandPeople: 2,
    cloudShadows: false,
    vegetationDistance: m(180),
    impostors: true,
    birds: 0,
    rain: false,
    skyClouds: false,
    mist: false,
    waterfalls: false,
    triangleScale: 0.35,
    detailMemoryMB: 256,
  },
  medium: {
    pixelRatio: 1.25,
    shadows: true,
    shadowMapSize: 1024,
    postProcessing: false,
    ambientOcclusion: false,
    smaa: false,
    msaa: 0,
    aoFull: false,
    sharpen: 0,
    anisotropy: 4,
    detailProps: true,
    vegetation: 600,
    grassBlades: 30_000,
    surfaceDetail: true,
    detailCutoffZoom: perM(0.85),
    pedestrianDetail: 1,
    occupantZoom: perM(5.5),
    vehicleErrorPixels: VEHICLE_ERROR_PIXELS,
    vehicleWholeCap: VEHICLE_WHOLE_CAP,
    hairStrandPeople: HAIR_STRAND_PEOPLE,
    cloudShadows: false,
    vegetationDistance: m(300),
    impostors: true,
    birds: 150,
    rain: true,
    skyClouds: true,
    mist: false,
    waterfalls: true,
    triangleScale: 0.6,
    detailMemoryMB: 448,
  },
  high: {
    pixelRatio: 1.5,
    shadows: true,
    // Three cascades of 2048: the nearest a few centimetres a texel round the street looked at
    shadowMapSize: 2048,
    postProcessing: true,
    ambientOcclusion: true,
    smaa: true,
    // SMAA smooths every edge on its own: the scene's MSAA samples cost 2.2 ms of the 2560-wide frame for edges SMAA draws as well.
    msaa: 0,
    aoFull: false,
    sharpen: 0.35,
    anisotropy: 8,
    detailProps: true,
    vegetation: 1_400,
    grassBlades: 60_000,
    surfaceDetail: true,
    detailCutoffZoom: perM(0.65),
    pedestrianDetail: 2,
    occupantZoom: perM(4),
    vehicleErrorPixels: VEHICLE_ERROR_PIXELS,
    vehicleWholeCap: VEHICLE_WHOLE_CAP,
    hairStrandPeople: HAIR_STRAND_PEOPLE,
    cloudShadows: true,
    vegetationDistance: m(440),
    impostors: true,
    birds: 400,
    rain: true,
    skyClouds: true,
    mist: true,
    waterfalls: true,
    triangleScale: 1,
    detailMemoryMB: 768,
  },
  ultra: {
    pixelRatio: 2,
    shadows: true,
    // The near cascade at 3072 (2.25x the texels of high's), the far two at 1536 (`sunCascades.ts` setEnabled halves them): roof and kerb shadows sharper where the street is looked at.
    shadowMapSize: 3072,
    postProcessing: true,
    ambientOcclusion: true,
    // Kept over the MSAA: it smooths what multisampling cannot (the shading's own edges - window grids, specular glints, cut-out leaves).
    smaa: true,
    // Four samples on the one HDR scene target, resolved before every pass (`postprocess.ts`): the roofs' and walls' geometric edges SMAA alone leaves stepped.
    msaa: 4,
    // The occlusion at the scene's full resolution: at half, scaled up, it bled across every roof edge it lies along.
    aoFull: true,
    sharpen: 0.45,
    anisotropy: 16,
    detailProps: true,
    vegetation: 2_600,
    grassBlades: 90_000,
    surfaceDetail: true,
    detailCutoffZoom: perM(0.5),
    pedestrianDetail: 2,
    occupantZoom: perM(3.25),
    vehicleErrorPixels: VEHICLE_ERROR_PIXELS,
    vehicleWholeCap: VEHICLE_WHOLE_CAP,
    hairStrandPeople: HAIR_STRAND_PEOPLE,
    cloudShadows: true,
    vegetationDistance: m(640),
    impostors: true,
    birds: 600,
    rain: true,
    skyClouds: true,
    mist: true,
    waterfalls: true,
    triangleScale: 1,
    detailMemoryMB: 1024,
  },
};

export const QUALITY_LEVELS: readonly QualityLevel[] = ['low', 'medium', 'high', 'ultra'];

export const isQualityLevel = (value: unknown): value is QualityLevel =>
  value === 'low' || value === 'medium' || value === 'high' || value === 'ultra';

/** Frames read per window: a p90 over a second and a half at 60 Hz. */
const WINDOW = 90;
/** Frames left out after a tier changes: its programs are built and its targets made, and the GPU's timings come back a few frames late. */
const SETTLE = 60;
/** A tier is dropped after this many windows in a row whose p90 missed the frame's budget (one slow window is a road built, a city opened). */
const DOWN_WINDOWS = 2;
/** A tier is raised after this many windows in a row whose p90 stayed under `UP_SHARE` of the budget: rising wants more room than falling (the hysteresis). */
const UP_WINDOWS = 4;
const UP_SHARE = 0.6;
/** A raise undone within this long, s: the machine cannot hold that tier; none tried again for `HOLD` s, twice as long each time it happens again. */
const UNDONE_WITHIN = 30;
const HOLD = 90;
/** A frame longer than this is a stall (a rebuild, the tab hidden), not a frame rate, s. */
const STALL = 0.4;

/** THE AUTOMATIC TIER: the 90th percentile of each window's frame cost (the GPU's time, or the frame's own where no timer answers) against the frame's budget; down after `DOWN_WINDOWS` missed windows, up after `UP_WINDOWS` roomy ones, never above the tier the hardware was given (`core/gpuTier.ts`), and a tier the machine could not hold not tried again for a while. */
export class QualityGovernor {
  private readonly costs = new Float32Array(WINDOW);
  private readonly sorted = new Float32Array(WINDOW);
  private count = 0;
  private skip = SETTLE;
  private missed = 0;
  private roomy = 0;
  private clock = 0;
  private lastRaise = -Infinity;
  private holdUntil = 0;
  private hold = HOLD;
  private readonly ceiling: number;

  constructor(private level: QualityLevel, ceiling: QualityLevel = level) {
    this.ceiling = QUALITY_LEVELS.indexOf(ceiling);
  }

  get current(): QualityLevel {
    return this.level;
  }

  /** The tier changed (by this governor or by the player): the windows start again once it has settled. */
  set(level: QualityLevel): void {
    this.level = level;
    this.count = 0;
    this.missed = 0;
    this.roomy = 0;
    this.skip = SETTLE;
  }

  /** One frame: `deltaSeconds` since the last, `costMs` what it cost, `budgetMs` the frame it must fit (the refresh, or the player's cap). The tier to switch to, or null to stay. */
  sample(deltaSeconds: number, costMs: number, budgetMs: number): QualityLevel | null {
    this.clock += deltaSeconds;
    if (deltaSeconds > STALL || !(costMs > 0) || !(budgetMs > 0)) return null;
    if (this.skip > 0) { this.skip--; return null; }
    this.costs[this.count++] = costMs;
    if (this.count < WINDOW) return null;
    this.count = 0;
    this.sorted.set(this.costs);
    this.sorted.sort();
    const p90 = this.sorted[Math.floor(WINDOW * 0.9)]!;
    const index = QUALITY_LEVELS.indexOf(this.level);
    if (p90 > budgetMs) { this.missed++; this.roomy = 0; } else { this.missed = 0; this.roomy = p90 < budgetMs * UP_SHARE ? this.roomy + 1 : 0; }
    if (this.missed >= DOWN_WINDOWS && index > 0) {
      if (this.clock - this.lastRaise < UNDONE_WITHIN) {
        this.holdUntil = this.clock + this.hold;
        this.hold *= 2;
      }
      return QUALITY_LEVELS[index - 1]!;
    }
    if (this.roomy >= UP_WINDOWS && index < this.ceiling && this.clock >= this.holdUntil) {
      this.lastRaise = this.clock;
      return QUALITY_LEVELS[index + 1]!;
    }
    return null;
  }
}

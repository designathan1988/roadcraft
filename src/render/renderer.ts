import type { FarTiles } from './buildings/farLevels';
import { jobPort } from '../jobs/jobPool';
import { onEcologyRead } from './ecologyPool';
import { GRID_CELL } from '@world/grid';
import type { BodyPart, Severable } from '@sim/people/view';
import type { Archetype } from '@sim/vehicles/archetypes';
import { workUntil } from '@core/frameWork';
import { pointInPolygon } from '@core/polygon';
import type { Occupant, RagdollProbe } from './ragdoll';
import type { PlayEffects } from './playEffects';
import { createLotOverlay, type LotOverlayInput } from './lotOverlay';
import { onCarriageway } from '@world/carriageway';
import {
  BufferGeometry,
  ShaderMaterial,
  AdditiveBlending,
  DoubleSide,
  Float32BufferAttribute,
  Color,
  ACESFilmicToneMapping,
  PointLight,
  Group,
  Frustum,
  Matrix4,
  type Material,
  Mesh,
  MeshDepthMaterial,
  type Object3D,
  RGBADepthPacking,
  Sphere,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';

import { Digest } from '@core/digest';
import type { ChangeJournal, ChangeKind, ChangeRect, DerivedChangeKind } from '@world/changes';
import type { Vec2 } from '@core/vec2';
import type { SegmentId } from '@world/ids';
import { Network, type SegmentRibbon } from '@world/network';
import { GROUND_ONLY, SURFACE_READ_REACH, buildRoadElevation, type RoadElevation } from '@world/elevation';
import { FOOTWAY_RISE, sidewalkHalf } from '@world/roadTypes';
import { footwayRiseAt, packFlush } from '@world/roads/footwayRise';
import { type PavingData, type PavingSource, pavedHeightFrom } from '@world/paving';
import type { RoadStructure } from '@world/structures';
import { TERRAIN_MAX_HEIGHT, TERRAIN_MIN_HEIGHT } from '@world/terrain';
import type { SimClient, VehicleView } from '@sim/host/simClient';
import type { GroundBox } from '@sim/host/fleetGrid';
import type { Viewport } from '@view/viewport';

import { VEHICLE_REACH, createAgentMeshes, type AgentMeshes } from './agents';
import { frustumGroundBox } from './frustumGround';
import { createEnvironment, sunShadowChunks } from './environment';
import { createMaterials, type SceneMaterials } from './materials';
import { PERSPECTIVE_FOV, createIsoRig } from './isoViewport';
import { renderTargetsBytes } from './targetBytes';
import { deviceGpuCap, gpuLedger, readGpuDevice } from './gpuLedger';
import { DEFAULT_ATMOSPHERE, createPostChain, type Atmosphere, type PostChain } from './postprocess';
import { createInspector, type Inspector } from './inspector';
import { buildRoadSurfaces, disposeSurfaceReuse, roadSurfaceSteps, type RoadSurfaces, type SurfaceReuse, type TileBundle } from './roadSurfaces';
import { SurfaceInputs } from './roadSurfaceInputs';
import { forgetDerivedKeys, forgetOtherDerived, readDerivedKeys, readDerivedSome, writeDerivedMany } from './derivedCache';
import { disposeMesh } from './mesh/surfaceMesh';
import { RoadTilePool } from './roadTilePool';
import { GroundShapePool } from './groundShapePool';
import { type BlockDigestAsk, type GroundShapeAsk, type PlateShapeAnswer, blockDigest, cornerBoxes, shapeGroundAsk } from './groundShape';
import { shapeBoth } from './terrainShaping';
import { PLANT_MAP_ZOOM, PLANT_NEAR_ZOOM, createSceneryKit, plantSamples, type SceneryKit } from './scenery';
import { createStreetFurniture } from './streetFurnitureLayer';
import { createGardens, type GardenPlant, type Gardens } from './gardens';
import { gardenLists } from './gardenLists';
import { localToWorld, solidFootprints, storedBounds } from '@world/buildings/geometry';
import { followPieces } from '@world/buildings/elements';
import { RoadDoc } from '@world/doc';
import { compileAhead, drainCompiles, drainUploads, drainWarm, shadowStandIn, warmPending } from './uploads';
import { partWarmMeshes } from './buildings/partWarm';
import { advanceWind, setWindWeather } from './wind';
import { holdStill } from './stillTree';
import { createRain } from './rain';
import { createLightning } from './lightning';
import { windVector } from '@world/weather';
import { createSignalHeads, type SignalHeads } from './signals';
import { buildStructureDetails } from './structures';
import { type StructureCells, createStructureCells } from './structureCells';
import { createExhaust } from './exhaust';
import { applyWear, createWearField } from './wear';
import { PLATE_SIZE, platesOver, plateRegion } from '@world/bounds';
import { createSignLayer } from './signLayer';
import { type PlantCells, createCoverCells, createTreeCells } from './plantCells';
import { paintCatalogue } from './markings';
import { isNear, updateRoadLevels } from './mesh/roadResidency';
import { JournalCursor } from '@world/derived';
import { Engine } from '@core/engine';
import { fadeMeshes } from './buildings/fade';
import { RevealGate } from './revealGate';
import { createShaderCatalogue } from './shaderCatalogue';
import { personProgramStandIns } from './people/proceduralCrowd';
import { createGpuTimer, type GpuTimer } from './gpuTimer';
import { poleGroundAt, type Utilities } from './utilities';
import { type PoleLayer, buildPolePreview, buildUtilities, docPoles, type PolePreviewInput } from './poleLayer';
import { createBarriers } from './barriers';
import { buildTrackPreview, createTrackPreview, createTransit, type TrackPreview } from './transit';
import { TERRAIN_CELL, TERRAIN_GRID, TERRAIN_HALF, type TerrainPart, type TerrainRegion, type TerrainSurface } from './terrain';
import { createFlatAtlas } from './flatAtlas';
import { FarRoads } from './farRoads';
import type { SharedGroundAt } from './sharedGround';
import { WOODS_SLOPE_STEP, WOODS_SPACING } from './woodsBase';
import { siteGrading } from '@world/buildings/siteGrading';
import { type CameraSolids, type GroundSince, cameraSolidsKeeper } from '@world/buildings/cameraSolids';
import { buildingFloors } from '@world/buildings/floors';
import { FLOOR_READ_REACH } from '@world/buildings/foundation';
import { RoomLamps } from './roomLamps';
import { TUNED_UNIT, m } from '@world/units';
/** Room lights kept in the scene for the floors cut open (`roomLamps.ts`). */
const ROOM_LIGHTS = 6;
declare const __ROAD_TILES_HASH__: string | undefined;
/** The fingerprint of the road tiles' code (`cook-plugin.ts`): their tiles are kept under it between sessions. */
const ROAD_TILES_HASH = typeof __ROAD_TILES_HASH__ !== 'undefined' && __ROAD_TILES_HASH__ ? __ROAD_TILES_HASH__ : null;
/** How long the opening's roads wait for the kept tiles to be read, ms: past it they are built. */
const KEPT_TILES_WAIT_MS = 3000;

import { type BuildingPreviewInput, type CutawaySpec, createBuildingLayer } from './buildings/layer';
import { buildBuildingMeshes } from './buildings/buildingMesh';
import { refillArrays } from './mesh/gpuOnly';
import { wantAllTexels } from './surfaceTextures';
import { BLUEPRINTS, instantiate } from '@world/buildings/blueprints';
import type { Building, BuildingId } from '@world/buildings/types';
import { QUALITY, QualityGovernor, type QualityLevel, type QualitySettings } from './quality';
import { type GroundRecord, type Rect, unionRect } from './groundChanges';
import { FOREST_SPECIES, createGroundCoverKit } from './groundCover';
import type { PlantedTree } from '@world/trees';
import { ClearingCells } from './clearingCells';
import { natureDensity } from './natureNoise';
import { buildNatureForest, loadNatureTrees, seedOfKind, type NatureTreeKit } from './natureTrees';
import { createFogField, createFogTexture, type FogLayer } from './fogLayer';
import { createElementLayer, loadElementKit, type ElementKit, type ElementLayer } from './elements';
import { isCoverKind } from '@world/terrainPaint';
import { CellKeeps, keepCellAt, keepCellRect, keepCellsOver } from './cellKeeps';
import { createDensityCars } from './densityCars';
import { COVER_SWEEP_PAD, SHORE_SWEEP_PAD, cellHash, forestIn, rocksIn, sameCandidate, sameShore, scrubIn, shoreIn, type Candidate, type CoverField, type ShoreCandidate, type WaterBox } from './coverSweep';

/** The scene renderer. ## The rebuild contract Everything derived from the road network or the terrain is rebuilt in */

/** How the sky is kept: `cycle` follows the residents' clock. */
export type SkyMode = 'day' | 'night' | 'cycle';


/** What an explosion broke, for the renderer to throw (`blast.ts`): world coordinates. */
export interface BlastHit {
  readonly ground: 'road' | 'earth' | 'building';
  readonly crater: boolean;
  readonly poles: readonly { x: number; y: number; lamp: boolean; mode: 'whole' | 'snap' | 'splinter'; dirX: number; dirY: number }[];
  /** Wires torn off a broken pole: from the pole still standing towards the one that went. */
  readonly wires: readonly { fromX: number; fromY: number; toX: number; toY: number }[];
  readonly posts: readonly { x: number; y: number; yaw: number }[];
  /** `id` and `archetype`: which vehicle, for a wreck of its own body (`AgentMeshes.carcass`). */
  readonly vehicles: readonly { x: number; y: number; angle: number; length: number; width: number; height: number; color: number; id?: number; archetype?: Archetype }[];
  readonly items: readonly { kind: string; x: number; y: number }[];
}

interface RenderStats {
  /** Built scene geometry budget; `gl.info.render.triangles` counts drawn passes. */
  readonly triangles: number;
  /** Actual draw calls across every pass of the last game frame. */
  readonly drawCalls: number;
  readonly quality: QualityLevel;
  readonly fps: number;
  /** Wall time of the last world rebuild, in milliseconds. */
  readonly rebuildMs: number;
  /** The road surface tiles the last rebuild made afresh, and those it kept. */
  readonly roadTiles?: { readonly built: number; readonly reused: number };
  /** Increments once per completed world rebuild. */
  readonly rebuilds: number;
  /** Wall time of the last terrain-only update (a brush dab while roads are held), ms. */
  readonly terrainMs: number;
}

interface DrawOptions {
  /** Keep the roads, and everything laid along them, as they are */
  readonly holdRoads?: boolean;
}

export interface SceneHandle {
  /** Loads what shots and blows leave behind */
  effects(): Promise<void>;
  /** The world of the last edit is still being built (`worldSteps`); the old one is drawn meanwhile. */
  readonly worldBusy: boolean;
  /** The opening's town (or a map being opened) is still being put together, nothing of it shown yet (`opened` in `draw`). */
  readonly opening: boolean;
  /** Settles once the programs of this opening are compiled (`shaderCatalogue.ts`): the curtain stays up until then. */
  readonly programsReady: Promise<void>;
  /** A map is being opened (a file, the autosave): nothing is shown until its whole world is in */
  beginLoad(): void;
  /** What else the opening waits for besides the town drawn: the tiles round the camera come in (`worldStreamer.ts` settled); null: nothing. */
  holdOpening(until: (() => boolean) | null): void;
  /** The buildings of the tiles not in the page's document, baked per tile from the tile store (`buildings/farLevels.ts`). */
  readonly farBuildings: FarTiles;
  /** The roads of the tiles not in the page's document, baked per tile from the tile store (`farRoads.ts`). */
  readonly farRoads: FarTiles;
  readonly backend: 'three-webgl';
  readonly viewport: Viewport;
  readonly scene: Scene;
  /** The underlying WebGL renderer. Exposed for diagnostics and tests. */
  readonly gl: WebGLRenderer;
  readonly stats: RenderStats;
  /** The GPU time of each frame drawn (`gpuTimer.ts`): the F9 monitor and the performance gate read it. */
  readonly gpu: GpuTimer;
  /** The solved road height field, for the editor's own previews. */
  elevationAt(x: number, y: number, structure?: RoadStructure): number;
  /** The editor's building ghost; null removes it. */
  setBuildingPreview(preview: BuildingPreviewInput | null): void;
  /** The pole run the pole tool would build, drawn as built; null removes it. */
  setPolePreview(net: Network, preview: PolePreviewInput | null): void;
  /** The metro seen as a cut through the ground (the transit tool on). */
  setTransitXray(on: boolean): void;
  /** The track being laid, built as it will be (`buildTrackPreview`); null removes it. */
  setTransitPreview(preview: { mode: 'train' | 'metro'; points: readonly { x: number; y: number }[] } | null): void;
  /** The lots of the Zoning tool coloured into the ground, all of them from the next frame (`lotOverlay.ts`) */
  setLotOverlay(input: LotOverlayInput | null, changes?: ChangeJournal): void;
  /** A blow on a building at world (x, y, z), `strength` 1..10: it breaks (`destruction.ts`). */
  strikeBuilding(b: Building, x: number, y: number, z: number, strength: number): boolean;
  /** A blow on the street at (x, y): a crater in the asphalt, dust. */
  strikeGround(x: number, y: number, strength: number): void;
  /** An explosion at world (x, y), height z, reaching `radius` (`blast.ts`), and the things it broke. */
  explode(x: number, y: number, z: number, radius: number, hit: BlastHit): void;
  /** People inside a struck building, thrown out of it (`ragdoll.fling`). */
  flingOccupants(list: readonly Occupant[]): void;
  /** Called when a struck building comes down after its blow (its pieces were made off the main thread). */
  onBuildingDown(listener: (id: number) => void): void;
  /** A broken hydrant spouting water (`blast.geyser`). */
  geyser(x: number, y: number, z: number, seconds?: number): void;
  /** A burst pipe: a small spout of water from a wall for a moment. */
  leak(x: number, y: number, z: number, seconds: number): void;
  /** Sparks of a short circuit at world (x, y), height z, for a while (`blast.arc`). */
  sparkAt(x: number, y: number, z: number, seconds: number): void;
  /** Soot laid on the ground (`blast.soot`). */
  soot(x: number, y: number, z: number, radius: number): void;
  /** Smoke in the air, 0 clear to 1 thick: the fog closes in, browner, the light dims. */
  setSmog(k: number): void;
  /** A lightning bolt onto the map point (x, y) now (`render/lightning.ts`). */
  strikeAt(x: number, y: number): void;
  /** Called at every strike with where it fell and how far from the view's centre, world units (for the thunder). */
  onStrike(listener: (x: number, y: number, distance: number) => void): void;
  /** How far the wind has carried the clouds, on the map (`world/clouds.ts` driftedCloud). */
  cloudDrift(): { readonly x: number; readonly y: number };
  /** A lasting fire at world (x, y), height z (a building burning). */
  burn(x: number, y: number, z: number, size: number, seconds: number): void;
  /** Whether anything is still moving on its own (an explosion, bodies, debris): keep drawing. */
  busy(): boolean;
  /** Clouds drifting over the map: worth a frame now and then even with nothing else moving. */
  drifting(): boolean;
  /** The bytes of the render targets and shadow maps alive (an estimate, `targetBytes.ts`): not in the scene, so not in `countMemory`. */
  targetBytes(): number;
  /** The bytes the buildings' detail holds on the GPU now (within the room the GPU ledger's cap leaves, `gpuLedger.ts`). */
  buildingDetailBytes(): number;
  /** Forgets a building's ruin (it was removed). */
  forgetRuin(id: number): void;
  /** The Builder's "Ocultar outros": undefined draws every building solid, null fades them all */
  setBuildingsDimmed(except: number | null | undefined): void;
  /** "See inside": the buildings near (x, y) drawn cut open at a floor; null draws them whole. */
  setBuildingCutaway(spec: CutawaySpec | null): void;
  /** The sky: always day, always night, or the residents' own clock. */
  setSkyMode(mode: SkyMode): void;
  /** Clouds and mist as the player set them (Landscape > Sky and weather). */
  setAtmosphere(atmosphere: Atmosphere): void;
  /** Perspective camera on, or the orthographic (isometric) view. */
  setPerspective(on: boolean): void;
  /** A shot: a tracer from the muzzle to where it struck, and the muzzle's flash (world x, y, height). */
  shot(from: readonly [number, number, number], to: readonly [number, number, number]): void;
  /** A person struck by a shot (world x, y, the height struck) */
  wound(x: number, y: number, z: number, dirX: number, dirY: number, severed: Severable | null): void;
  /** A shot along the line of sight between world points `a` and `b` (x, y, height) at the bodies on the ground */
  shootBody(a: readonly [number, number, number], b: readonly [number, number, number]): { alive: number; part: BodyPart } | 'hit' | null;
  /** Whether somebody is down on the ground as a body (not standing to be shot). */
  isDown(id: number): boolean;
  /** The bodies, guts and debris run at this share of real time (0: stopped; the weapons lab). */
  setEffectsSpeed(speed: number): void;
  /** Moves the bodies, guts and debris on by `seconds` once (a frame step while stopped). */
  stepEffects(seconds: number): void;
  /** Every body, piece, gut and blood stain gone (the weapons lab's clean slate). */
  clearCasualties(): void;
  /** Every body on the ground as the weapons lab measures it (`Ragdolls.probe`). */
  ragdollProbe(): RagdollProbe[];
  /** What poses a person now (`AgentMeshes.animProbe`). */
  animProbe(id: number): ReturnType<AgentMeshes['animProbe']>;
  /** Plays a clip on a person regardless (`AgentMeshes.forceClip`). */
  forceClip(id: number, clip: string | null): void;
  /** Every procedural person's skeleton measured against their body (`AgentMeshes.meshProbe`). */
  meshProbe(): ReturnType<AgentMeshes['meshProbe']>;
  /** A shot striking a vehicle at world (x, y, height z), coming along (dirX, dirY) */
  vehicleHit(x: number, y: number, z: number, dirX: number, dirY: number, glass: boolean, blood: boolean): void;
  /** The body a vehicle's driver or rider is drawn with (`AgentMeshes.driverBody`). */
  driverBody(vehicle: VehicleView, x: number, y: number): number | null;
  /** A two-wheeler its rider was shot off: the machine itself falling over and sliding to a stop. */
  dropVehicle(v: { id: number; archetype: Archetype; x: number; y: number; angle: number; color: number; dirX: number; dirY: number }): void;
  /** The height the terrain is drawn at — what anything laid on it must clear. */
  terrainHeightAt(x: number, y: number): number;
  /** The highest corner of the ground as drawn now (the mesh is flat between corners), read once per change of it. */
  landTop(): number;
  /** The universal grid (`world/grid.ts`) drawn over the whole map, on the ground, or not. */
  setGrid(on: boolean): void;
  /** The grid's cells a road was just laid over light up and fade back, a blink */
  flashGrid(cells: readonly { x: number; y: number; ring: number }[]): void;
  /** The roads just laid light up and fade back, a blink, over their whole width. */
  flashRoads(ids: readonly SegmentId[]): void;
  /** The ground what is built stands on (`builtGroundAt`) */
  builtGroundAt(x: number, y: number): number;
  /** The roads' heights an edit already solved for this network on the natural terrain (the tunnel test, `commitRoadPath`) */
  offerElevation(elevation: RoadElevation, networkRevision: number): void;
  /** The roads' heights last solved on the natural terrain, with the terrain revision they were solved on */
  roadsSolve(): { readonly elevation: RoadElevation; readonly terrainRevision: number } | null;
  /** The top of what is drawn at a point: a deck where a road's casing covers it, the terrain elsewhere. */
  surfaceHeightAt(x: number, y: number): number;
  /** The height of the paving at a point (NaN off the roads); with `pack`, what a worker reads it from over a rectangle (`world/paving.ts`). */
  readonly pavedHeightAt: PavingSource;
  resize(): void;
  draw(net: Network, sim: SimClient, alpha: number, delta: number, options?: DrawOptions): void;
  /** A tier, or the player's own settings on it (the options panel: shadows, occlusion, smoothing). */
  setQuality(level: QualityLevel | 'auto', settings?: QualitySettings): void;
  readonly quality: QualityLevel | 'auto';
  /** The inspection camera (`inspector.ts`); null outside development builds. */
  readonly inspect: Inspector | null;
  /** Every figure drawn last frame and the body it was cast as: the runtime census. */
  census(): ReturnType<AgentMeshes['census']>;
  dispose(): void;
}

/** Roads at grade, and the decks above them, as `surfaceHeightAt` asks them. */
const SURFACE_SETS: readonly ReadonlySet<RoadStructure>[] = [GROUND_ONLY, new Set<RoadStructure>(['elevated', 'bridge'])];

/** A plant's leaf cards (`scenery.ts` `plantMeshes`, `gardens.ts`): `...-trees-<species>-cards`, `...-bushes-<kind>-cards`. */
const isLeafCards = (mesh: Object3D): boolean => mesh.name.endsWith('-cards');

/** The vertices of the first mesh drawn under `root` (visible itself), 0 when none is: stops at the first, never counts them all. */
function firstDrawnVertices(root: Object3D): number {
  const stack: Object3D[] = [root];
  while (stack.length) {
    const o = stack.pop()!;
    const mesh = o as Mesh;
    if (mesh.isMesh && mesh.visible) {
      const count = mesh.geometry.getAttribute('position')?.count ?? 0;
      if (count > 0) return count;
    }
    for (const child of o.children) stack.push(child);
  }
  return 0;
}

/** The plants of every building's garden, in the world, on the ground they stand on. */
function gardenPlants(all: Iterable<Building>, groundAt: (x: number, y: number) => number): GardenPlant[] {
  const out: GardenPlant[] = [];
  for (const b of all) {
    for (const el of b.elements ?? []) {
      if (el.kind !== 'tree' && el.kind !== 'shrub' && el.kind !== 'hedge' && el.kind !== 'flowers') continue;
      // `w` runs across the way the element faces.
      const yaw = (b.rotation ?? 0) + (el.facing === 1 || el.facing === 3 ? Math.PI / 2 : 0) + (el.angle ?? 0);
      // A long hedge in steps, each on the ground under it, not one box at its middle's height.
      const kind = el.kind;
      followPieces(el).forEach((piece, k) => {
        const at = localToWorld(b, piece.x, piece.y);
        out.push({ kind, x: at.x, y: at.y, z: groundAt(at.x, at.y), w: piece.w, d: piece.d, h: piece.h, yaw,
          seed: ((b.id * 7919 + el.id * 104729 + k * 31) % 100003) / 100003 });
      });
    }
  }
  return out;
}

export function createSceneRenderer(
  canvas: HTMLCanvasElement,
  initialCentre: Vec2,
  initialZoom: number,
  initialQuality: QualityLevel | 'auto' = 'auto',
  onAssetsReady: () => void = () => {},
  /** The engine the scene's products are registered with (`core/engine.ts`): the game's one, from `main.ts`. */
  engine: Engine = new Engine(),
  /** The player's own settings on the tier (the options panel); the tier's own when absent. */
  initialSettings?: QualitySettings,
): SceneHandle {
  // A plate's ecosystem read off the page (`ecologyPool.ts`) is drawn as it comes back.
  onEcologyRead(onAssetsReady);
  /** The shadow map is drawn only when it can have changed. */
  let shadowMoved = true;
  /** Whether the simulation runs: what it moves moves (`environment.setMovers`). */
  let simRunning = false;
  /** DO NOT walk the scene for it each frame: whether anything that moves is drawn into the shadow map, as the layers that move it say */
  const movingCasters = (): boolean => agents.casting || transit.moving || (fx?.busy() ?? false);
  /** Moving casters in the last shadow frame: when they stop, the map is drawn once more with them at rest. */
  let castersMoved = false;
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
    // DO NOT drop it for a near plane pushed out or offsets grown until the flicker hides.
    reversedDepthBuffer: true,
  });
  // One game frame has the scene, shadows and several postprocess renders.
  renderer.info.autoReset = false;
  // Checking every program's compile and link log makes each new shader wait for the driver on the main thread
  renderer.debug.checkShaderErrors = import.meta.env.DEV;
  // The GPU time of every frame.
  const gpuTimer = createGpuTimer(renderer);
  renderer.outputColorSpace = SRGBColorSpace;
  // A film curve (ACES): contrast, deep shade and bright light, the look of the diorama the player holds up as the target
  renderer.toneMapping = ACESFilmicToneMapping;
  // Three's ACES already scales its input by 1 / 0.6
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  // PCFSoftShadowMap was REMOVED in three r186.
  renderer.shadowMap.type = PCFShadowMap;
  sunShadowChunks();
  // Drawn once a frame, on request (see `post.render` below).
  renderer.shadowMap.autoUpdate = false;

  // One shadow depth material per program variant. three draws every caster without a depth material of its own with ONE
  const depthVariants = {
    plain: new MeshDepthMaterial({ depthPacking: RGBADepthPacking }),
    instanced: new MeshDepthMaterial({ depthPacking: RGBADepthPacking }),
    tinted: new MeshDepthMaterial({ depthPacking: RGBADepthPacking }),
  };
  const ownDepth = new Set<MeshDepthMaterial>(Object.values(depthVariants));
  const plainOpaque = (material: Material): boolean => {
    const m = material as Material & { alphaTest: number; alphaMap?: unknown; map?: unknown; displacementMap?: unknown };
    // Anything three would give a depth material of its own (cut-outs, displacement, coverage) keeps three's own choice.
    return !(m.alphaTest > 0 && (m.map || m.alphaMap)) && !m.displacementMap && !m.alphaToCoverage;
  };
  /** DO NOT walk the scene for it (every 30 frames it walked every object): a mesh is given its variant's depth material as it comes in */
  const depthFor = (object: Object3D): void => {
    const mesh = object as Mesh & { isInstancedMesh?: boolean; instanceColor?: unknown };
    // Whether it casts or not: a mesh switched to casting later (the two-wheelers) has its material already.
    if (!mesh.isMesh) return;
    const current = mesh.customDepthMaterial as MeshDepthMaterial | undefined;
    if (current && !ownDepth.has(current)) return;
    if (Array.isArray(mesh.material) || !plainOpaque(mesh.material)) return;
    const wanted = !mesh.isInstancedMesh
      ? depthVariants.plain
      : mesh.instanceColor ? depthVariants.tinted : depthVariants.instanced;
    if (current !== wanted) mesh.customDepthMaterial = wanted;
  };
  /** Every container under `root` told of what is added to it (three's `childadded`), and what is there now given its depth material. */
  const watchedForDepth = new WeakSet<Object3D>();
  const watchShadowDepth = (root: Object3D): void => {
    root.traverse((object) => {
      depthFor(object);
      if ((object as Mesh).isMesh || watchedForDepth.has(object)) return;
      watchedForDepth.add(object);
      object.addEventListener('childadded', onChildAdded);
    });
  };
  const onChildAdded = (event: { child: Object3D }): void => watchShadowDepth(event.child);

  let requested: QualityLevel | 'auto' = initialQuality;
  const governor = new QualityGovernor(requested === 'auto' ? 'high' : requested);
  let quality: QualitySettings = initialSettings ?? QUALITY[governor.current];

  const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
  const anisotropy = Math.min(quality.anisotropy, maxAnisotropy);

  let gridWanted = false;
  /** The blinks of cells under a road just laid (`flashGrid`), until each has faded; `time` seconds since each began. */
  const gridFlashes: { mesh: Mesh; start: number; end: number; time: number }[] = [];
  /** ONE material for every blink, made once: a material per road laid was an object made and disposed per edit */
  const blinkMaterial = new ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        attribute float aRing; varying float vRing;
        void main() {
          vRing = aRing;
          vec3 p = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `uniform float uTime; varying float vRing;
        void main() {
          float t = uTime - vRing * 0.09;
          float a = smoothstep(0.0, 0.1, t) * (1.0 - smoothstep(0.1, 0.75, t)) * (vRing < 0.5 ? 0.3 : 0.12);
          if (a <= 0.001) discard;
          gl_FragColor = vec4(0.62, 0.95, 1.0, a);
        }`,
      // Over the ground whatever it does meanwhile
      transparent: true, depthWrite: false, depthTest: false, side: DoubleSide, blending: AdditiveBlending,
  });
  /** A blink on the ground: triangles (three's x, height, -y) lighting up and fading, each by its ring's delay. */
  const addBlink = (pos: readonly number[], ring: readonly number[]): void => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geometry.setAttribute('aRing', new Float32BufferAttribute(ring, 1));
    const mesh = new Mesh(geometry, blinkMaterial);
    mesh.name = 'grid-flash';
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;
    const flash = { mesh, start: performance.now(), end: 0.8 + Math.max(0, ...ring) * 0.09, time: 0 };
    mesh.onBeforeRender = () => {
      blinkMaterial.uniforms['uTime']!.value = flash.time;
      blinkMaterial.uniformsNeedUpdate = true;
    };
    scene.add(mesh);
    gridFlashes.push(flash);
  };
  /** Roads just laid, to blink once their heights are solved (`flashRoads`, `draw`). */
  const pendingRoadFlash: SegmentId[] = [];
  /** Behind the map while building it (`draw`): a plain dark blue. */
  const MAP_BACKGROUND = new Color(0x0c1a2c);
  const scene = new Scene();
  watchShadowDepth(scene);
  // The root never moves.
  scene.matrixAutoUpdate = false;
  scene.updateMatrix();
  const initialHeight = Math.max(1, canvas.clientHeight || window.innerHeight);
  /** Where the relief's close window is centred (three's x, z; see `draw`). */
  const reliefFocus = { x: 0, z: 0 };
  const rig = createIsoRig(initialCentre, initialHeight / Math.max(0.001, initialZoom * 2));

  const environment = createEnvironment(scene, renderer, {
    shadows: quality.shadows,
    shadowMapSize: quality.shadowMapSize,
  });
  const materials: SceneMaterials = createMaterials(anisotropy);
  // Streets and footways wear with use (`wear.ts`).
  const wear = createWearField();
  let lastWall = -1;
  applyWear(materials.asphalt, wear, 0, 'asphalt');
  applyWear(materials.footway, wear, 1, 'footway');
  materials.setDetail(quality.surfaceDetail);
  // Every prop model and material, built once.
  const sceneryKit: SceneryKit = createSceneryKit();
  // The map's ground, in plates (`flatAtlas.ts`).
  const terrain: TerrainSurface = createFlatAtlas(anisotropy);
  /** The ground what is built stands on - the roads solved on it, the buildings' floors worked out on it */
  const builtGroundAt = (x: number, y: number): number => terrain.naturalRenderedHeightAt(x, y);
  // The perspective view looks at the ground and stays over it (`IsoRig.setGround`).
  rig.setGround((x, y) => terrain.renderedHeightAt(x, y));
  // DO NOT make it again unseen.
  if (import.meta.env.DEV) Object.assign(window, { __scene: scene, __gl: renderer });
  scene.add(...terrain.meshes);

  const world = new Group();
  world.name = 'world';
  // Roads, plants, poles, furniture, forests: placed once, never moved (`stillTree.ts`).
  holdStill(world);
  scene.add(world);
  /** The roads of the tiles not in the page's document (`farRoads.ts`), on the ground shared with the workers. */
  const farRoads = new FarRoads(() => (terrain.renderedHeightAt as SharedGroundAt).share?.current ?? null);
  world.add(farRoads.group);

  let roads: RoadSurfaces | null = null;
  /** The roads' structures, cell by cell (`structureCells.ts`), made with the first world. */
  let details: StructureCells | null = null;
  /** What the player placed on the footways and the long grass, kept item by item from the diary (`streetFurnitureLayer.ts`) */
  const furniture = createStreetFurniture(sceneryKit);
  world.add(furniture.group, furniture.grass);
  let utilities: PoleLayer | null = null;
  /** The pole tool's planned run, and the plan it was built for (rebuilt only when that changes). */
  /** Vehicle exhaust and dust (`exhaust.ts`): one particle cloud for the map. */
  const exhaust = createExhaust();
  scene.add(exhaust.points);
  const shakeOffset = new Vector3();
  /** What shots and blows leave behind - bodies, blood, explosions, broken buildings (`playEffects.ts`) */
  let fx: PlayEffects | null = null;
  let fxLoading: Promise<void> | null = null;
  /** The effects asked for in idle time once the world stands (`draw`). */
  let fxPreload = false;
  // The effects' two lights - the muzzle's flash and the blast's - in the scene from the start, dark until used.
  const fxLights = {
    muzzle: new PointLight(0xffc070, 0, m(8), 2),
    blast: new PointLight(0xffb060, 0, m(60), 1.6),
  };
  scene.add(fxLights.muzzle, fxLights.blast);
  const buildingDownListeners: ((id: number) => void)[] = [];
  const loadEffects = (): Promise<void> => fxLoading ??= import('./playEffects').then((mod) => {
    fx = mod.createPlayEffects({
      scene, exhaust, agents,
      buildings: {
        chunkOf: (b) => buildings.chunkOf(b),
        setRuined: (ruined) => buildings.setRuined(ruined),
        lotHeightAt: (id, x, y) => buildings.lotHeightAt(id, x, y),
      },
      renderedHeightAt: (x, y) => terrain.renderedHeightAt(x, y),
      naturalRenderedHeightAt: (x, y) => builtGroundAt(x, y),
      pavedHeightAt: (x, y) => pavedHeightAt(x, y),
      camera: () => rig.camera,
      onAssetsReady,
      lights: fxLights,
    });
    fx.onBuildingDown((id) => { for (const listener of buildingDownListeners) listener(id); });
    onAssetsReady();
  });
  let polePreview: Utilities | null = null;
  /** Placed signs, street name plates and the junctions' rule plates, kept sign by sign from the diary (`signLayer.ts`). */
  const signs = createSignLayer();
  let polePreviewKey = '';
  /** Walls, fences and hedges (`barriers.ts`), kept barrier by barrier from the diary. */
  const barriers = createBarriers();
  /** Public transport (`transit.ts`), kept track by track and stop by stop from the diary. */
  const transit = createTransit();
  let elevation: RoadElevation | null = null;
  /** Each rewrite of the drawn ground by the land (`terrain.update`), and the highest corner read after one (`landTop`). */
  let landVersion = 0;
  let landTopFor = -1;
  let landTopValue = 0;

  // What each rebuild keeps for the next
  const tilesPrefix = ROAD_TILES_HASH ? `roadtiles:${ROAD_TILES_HASH}:` : null;
  /** The kept tiles have been read (or there are none to read). */
  let storedRead = tilesPrefix === null;
  /** What the store holds now, by `storedKey`, and by place (`pass|tile`): a tile built again at its place replaces what was kept of it. */
  const storedKeys = new Set<string>();
  const storedAt = new Map<string, string>();
  const placeOf = (key: string): string => key.slice(0, key.lastIndexOf('|'));
  const noteStored = (key: string): void => {
    const place = placeOf(key);
    const was = storedAt.get(place);
    if (was && was !== key && tilesPrefix) { storedKeys.delete(was); forgetDerivedKeys(tilesPrefix, [was]); }
    storedAt.set(place, key);
    storedKeys.add(key);
  };
  /** Where the road tiles are kept for a later session, off the page (`derivedWriter.worker.ts`); none in tests. */
  const tileWriter = tilesPrefix && typeof Worker !== 'undefined'
    ? jobPort('derivedWriter') : null;
  /** Where the camera looks and how far the roads are at full detail round it (`mesh/roadResidency.ts`). */
  const roadFocus = { x: initialCentre.x, y: initialCentre.y, reach: 700, frames: 0 };
  const surfaceReuse: SurfaceReuse = {
    tiles: new Map(),
    dependsOn: (minX, minY, maxX, maxY) => new Digest()
      .add(elevation?.digest(minX, minY, maxX, maxY, SURFACE_READ_REACH) ?? 0)
      .add(terrain.digest(minX, minY, maxX, maxY))
      .value(),
    paint: paintCatalogue(),
    // A block of road is made at full detail only near the camera (`mesh/roadLod.ts`).
    near: (x, y) => isNear(x, y, roadFocus.x, roadFocus.y, roadFocus.reach),
    chunks: new Map(),
    inputs: new SurfaceInputs(),
    retired: [],
    // DO NOT read the whole store at the opening: it grows with every place the camera went (CLAUDE.md, "Streaming world").
    stored: {
      has: (key) => storedKeys.has(key),
      fetch: (keys) => (tilesPrefix ? readDerivedSome<TileBundle>(tilesPrefix, keys) : Promise.resolve(new Map())),
    },
    // DO NOT hold the built tiles for idle writes
    keep: (key, bundle) => {
      if (!tilesPrefix || storedKeys.has(key)) return;
      noteStored(key);
      // The tile's arrays handed to the writer, not copied: nothing reads them once its blocks are merged (`SurfaceReuse.keep`).
      if (tileWriter) {
        const buffers: ArrayBuffer[] = [];
        for (const tile of bundle.values()) {
          for (const a of [tile.positions, tile.normals, tile.uvs, tile.colors, tile.sections, tile.indices]) buffers.push(a.buffer as ArrayBuffer);
        }
        tileWriter.postMessage({ prefix: tilesPrefix, entries: [[key, bundle]] }, buffers);
      } else writeDerivedMany(tilesPrefix, new Map([[key, bundle]]));
    },
  };
  if (tilesPrefix && ROAD_TILES_HASH) {
    forgetOtherDerived('roadtiles', ROAD_TILES_HASH);
    void readDerivedKeys(tilesPrefix).then((kept) => {
      for (const key of kept) noteStored(key);
    }).finally(() => { storedRead = true; });
  }


  /** The world being rebuilt for the last edit (`rebuildWorld`), a slice a frame. */
  let worldJob: Generator<'wait' | void, void, void> | null = null;
  /** The roads' heights an edit solved ahead (`offerElevation`). */
  let offeredElevation: { elevation: RoadElevation; revision: number; terrain: number } | null = null;
  /** The roads' surface tiles shaped on the other cores (`roadTilePool.ts`). */
  const roadTiles = new RoadTilePool();
  /** The job was started in this frame (`pumpWorld` waits for the next). */
  let worldJobFresh = false;
  /** DO NOT hold the grading for the whole job */
  let worldJobGround = false;
  /** The opening's town (or a map opened) is held until it is whole (`revealGate.ts`). */
  const reveal = new RevealGate();
  /** Every program the game draws with, compiled before the town is shown (`shaderCatalogue.ts`). */
  const programs = createShaderCatalogue(personProgramStandIns);
  let openingSince: number | null = null;
  /** The streamed world's tiles round the camera (`holdOpening`): the opening shows the town once they are in. */
  let openingHeld: (() => boolean) | null = null;
  /** While nothing is shown (`opened` false) the world is built this much a frame */
  const HIDDEN_SLICE_MS = 250;

  /** The world of an edit is built up to this much a frame */
  const WORLD_SLICE_MS = 28;
  /** The last steps' costs, ms: the next step is started only if the dearest of them still fits in the slice */
  const stepCosts = new Float64Array(8);
  let stepCursor = 0;
  /** Builds the world of the last edit for a few milliseconds; it puts itself in place once complete. */
  /** DO NOT ask the next frame at once while the world's job waits on a worker: the unseen opening's frames come without the display's pace (`frameLoop.ts`), and it spun the page at 2,000 frames a second, starving the workers it waited on (2026-10-16); looked at again a display frame later. */
  const WAIT_LOOK_MS = 16;
  let waitLook: ReturnType<typeof setTimeout> | null = null;
  const lookAgain = (): void => {
    if (waitLook !== null) return;
    waitLook = setTimeout(() => { waitLook = null; onAssetsReady(); }, WAIT_LOOK_MS);
  };
  const pumpWorld = (): void => {
    if (!worldJob) return;
    // Not in the frame of the edit itself, which has already paid for the edit and the roads' heights
    if (worldJobFresh) { worldJobFresh = false; onAssetsReady(); return; }
    const until = reveal.opened ? workUntil(WORLD_SLICE_MS, WORLD_SLICE_MS) : performance.now() + HIDDEN_SLICE_MS;
    if (!until) { onAssetsReady(); return; }
    // At least one step a frame, whatever it is expected to cost: the job always moves on.
    let at = performance.now();
    let step = worldJob.next();
    for (;;) {
      const now = performance.now();
      stepCosts[stepCursor++ % stepCosts.length] = now - at;
      if (step.done || step.value === 'wait') break;
      let estimate = 0;
      for (const cost of stepCosts) if (cost > estimate) estimate = cost;
      if (now + estimate > until) break;
      at = now;
      step = worldJob.next();
    }
    if (step.done) { worldJob = null; stepCosts.fill(0); shadowMoved = true; }
    else if (step.value === 'wait') lookAgain();
    else onAssetsReady();
  };
  let networkRevision = -1;
  let terrainRevision = -1;
  let builtTriangles = 0;
  let rebuildMs = 0;
  let rebuilds = 0;
  let terrainMs = 0;

  const deckHeight = (
    x: number,
    y: number,
    segment: SegmentId | undefined,
  ): number => {
    if (!elevation) return terrain.renderedHeightAt(x, y);
    return segment === undefined ? elevation.at(x, y) : elevation.onSegment(segment, x, y);
  };

  /** The footway's rise over the carriageway at a point (`footwayRiseAt`), kerbed before any network is built. */
  const footwayRiseHere = (x: number, y: number): number => (worldNet ? footwayRiseAt(worldNet, x, y) : FOOTWAY_RISE);
  /** See `SceneHandle.pavedHeightAt` (`world/paving.ts`). */
  const pavedHeightAt: PavingSource = Object.assign((x: number, y: number): number => {
    if (!elevation || !elevation.has(GROUND_ONLY)) return NaN;
    return pavedHeightFrom(elevation, GROUND_ONLY, footwayRiseHere, x, y);
  }, {
    pack: (rect: readonly [number, number, number, number]): { data: PavingData; transfer: ArrayBuffer[] } | null => {
      const ground = elevation !== null && elevation.has(GROUND_ONLY);
      if (ground && !elevation!.fieldFor) return null;
      const field = ground ? elevation!.fieldFor!([rect], []) : null;
      const flush = worldNet ? packFlush(worldNet, [rect]) : null;
      return { data: { rect, field: field?.data ?? null, flush: flush?.data ?? null },
        transfer: [...field?.transfer ?? [], ...flush?.transfer ?? []] };
    },
  });

  const agents: AgentMeshes = createAgentMeshes(deckHeight, onAssetsReady,
    // A walker off the streets stands on what is drawn there
    (x, y) => {
      const lot = buildings.anyLotHeightAt(x, y);
      // On a road's footway or carriageway, its paving; the terrain elsewhere.
      const paved = pavedHeightAt(x, y);
      const ground = Number.isFinite(paved) ? paved : terrain.renderedHeightAt(x, y);
      return Number.isFinite(lot) ? Math.max(lot, ground) : ground;
    },
    // A resident's parked car stands on its lot as the lot is drawn.
    (building, x, y) => buildings.lotHeightAt(building as BuildingId, x, y),
    // The land alone: whether a walker off the streets is on screen at all, before the yards are asked.
    (x, y) => terrain.renderedHeightAt(x, y));

  const crowdFrustum = new Frustum();
  /** The view's frustum the buildings' detail is chosen in (`levelOfDetail`), and its matrix. */
  const detailFrustum = new Frustum();
  const detailProjection = new Matrix4();
  const crowdProjection = new Matrix4();
  const crowdBounds = new Sphere(new Vector3(), 8);
  const pedestrianVisible = (x: number, y: number, height: number): boolean => {
    crowdBounds.center.set(x, height + 3, -y);
    return crowdFrustum.intersectsSphere(crowdBounds);
  };
  // How tall a person stands on the screen, canvas pixels: feet and head through the view-projection (either camera)
  const pixelFoot = new Vector3(), pixelOther = new Vector3(), pixelBase = new Vector3(), cameraRight = new Vector3();
  const personPixels = (x: number, y: number, z: number, height: number): number => {
    const halfW = renderer.domElement.width * 0.5, halfH = renderer.domElement.height * 0.5;
    pixelFoot.set(x, z, -y);
    pixelOther.set(x, z + height, -y).applyMatrix4(crowdProjection);
    pixelBase.copy(pixelFoot).addScaledVector(cameraRight, height).applyMatrix4(crowdProjection);
    pixelFoot.applyMatrix4(crowdProjection);
    const tall = Math.hypot((pixelOther.x - pixelFoot.x) * halfW, (pixelOther.y - pixelFoot.y) * halfH);
    pixelOther.copy(pixelBase);
    const across = Math.hypot((pixelOther.x - pixelFoot.x) * halfW, (pixelOther.y - pixelFoot.y) * halfH);
    return Math.max(tall, across * 0.4);
  };
  /** CSS pixels a world unit across the screen at (x, y, z) - the viewport's zoom, there */
  const screenScale = (x: number, y: number, z: number): number => {
    pixelFoot.set(x, z, -y);
    pixelOther.copy(pixelFoot).add(cameraRight).applyMatrix4(crowdProjection);
    pixelFoot.applyMatrix4(crowdProjection);
    return Math.hypot((pixelOther.x - pixelFoot.x) * cssHalfW, (pixelOther.y - pixelFoot.y) * cssHalfH);
  };
  /** Half the canvas's CSS size, read once a frame (`draw`). */
  let cssHalfW = 1, cssHalfH = 1;
  // A vehicle is tested with its own reach, grown by its height towards the sun's side
  const vehicleBounds = new Sphere(new Vector3(), 1);
  const vehicleVisible = (x: number, y: number, height: number, radius: number): boolean => {
    vehicleBounds.center.set(x, height + radius * 0.3, -y);
    vehicleBounds.radius = radius;
    return crowdFrustum.intersectsSphere(vehicleBounds);
  };
  /** The ground every vehicle `vehicleVisible` passes stands on, set each frame (`frustumGroundBox`): its sphere's centre between the deepest land and the highest deck. */
  const vehicleBox: GroundBox = { x0: 0, y0: 0, x1: 0, y1: 0 };
  // A raised deck over the highest land, and room for decks stacked on it; a cut below the deepest.
  const VEHICLE_LOW = TERRAIN_MIN_HEIGHT - m(16), VEHICLE_HIGH = TERRAIN_MAX_HEIGHT + m(64) + VEHICLE_REACH * 0.3;
  scene.add(...agents.meshes);
  // The far traffic: the meso model's cars on every road outside the micro window, in one draw (`densityCars.ts`).
  const densityCars = createDensityCars(deckHeight);
  scene.add(densityCars.object);
  // What moves and casts: each sun cascade it is drawn into is drawn again while it moves (`sunCascades.ts`).
  environment.setMovers([
    { roots: agents.meshes, moving: () => simRunning && agents.casting },
    { roots: [transit.group], moving: () => simRunning && transit.moving },
  ]);
  const signals: SignalHeads = createSignalHeads(scene, deckHeight);

  // Modular buildings: their own layer, behind their own gate
  const buildings = createBuildingLayer();
  scene.add(buildings.group);
  // Each sun cascade draws the parts wider than its own texel only, not every part the finest one draws.
  environment.setCasters((texel) => buildings.castInto(texel));
  // The town's meshes keep their arrays only until they are on the GPU (`mesh/gpuOnly.ts`)
  renderer.domElement.addEventListener('webglcontextrestored', () => {
    refillArrays(scene);
    for (const { mesh } of surfaceReuse.chunks?.values() ?? []) refillArrays(mesh);
    buildings.refill();
    farRoads.refill();
    wantAllTexels();
  });
  /** The buildings' garden plants, and the buildings and ground they were planted for. */
  let gardens: Gardens | null = null;
  const coverKit = createGroundCoverKit();
  // The countryside's trees are hand-made models (`natureTrees.ts`), loaded once
  let natureTreeKit: NatureTreeKit | null = null;
  /** The plants and stones drawn cell by cell (`plantCells.ts`) */
  let coverCells: PlantCells | null = null;
  let natureCards: PlantCells | null = null;
  let natureForest: PlantCells | null = null;
  let paintedForest: PlantCells | null = null;
  let plantedForest: PlantCells | null = null;
  let natureTreesPending = true;
  /** Whether the camera's pull in front of a building is still moving (`isoViewport.ts` `settle`): draw again. */
  let cameraEasing = false;
  /** The town's solids as filed for the camera, for the light shut out of the streets (`canyonLight.ts`). */
  let townSolids: (() => CameraSolids) | null = null;
  /** The placements' two steps (`natureSweep`/`natureKeeps`, `coverSweep.ts`/`coverKeeps`) */
  let natureSweepState: NatureSweep | null = null;
  /** The sweep being worked towards (its key), whether plates still wait for it, and a count of the sweeps the trees were kept from. */
  let natureSweepWant = '';
  let natureSweepPending = false;
  /** The sweep the ecosystem's trees were last filed from (`fileNature`). */
  let natureFiledFrom: NatureSweep | null = null;
  /** The card trees the cover cells were last drawn for (moved: every cell drawn again), and the geology serial their stones' colours read. */
  let coverStandIns: boolean | null = null;
  let coverGeologySeen = -1;
  /** The paint the covers were swept for, read from the diary (`coverPaintRead`), and the water the rivers' stones were. */
  const coverPaintRead = new JournalCursor(['paint']);
  let coverWaterSeen = -1;
  let coverWaterBox: WaterBox | null = null;
  /** The trees the player planted, cell by cell as the diary says they were planted or cut (`plantedRead`). */
  const plantedRead = new JournalCursor(['trees']);
  /** What the plants' and stones' tests read, from the diary: a change there tests again only the places it reached */
  const vegetationRead = new JournalCursor(['roads', 'buildings', 'clearings', 'terrain', 'elevation', 'ground']);
  let vegetationRedraw = true;
  /** The network the keeps test against (`draw`'s). */
  let keepNet: Network | null = null;
  /** The elements laid with the brush (`elements.ts`): their models, loaded once, and the layer built for the map. */
  let elementKit: ElementKit | null = null;
  let elementLayer: ElementLayer | null = null;
  /** What the elements stand on and are, from the diary: a dab lays its own cells again, not the map's. */
  const elementRead = new JournalCursor(['elements', 'terrain', 'ground']);
  void loadElementKit(anisotropy).then((kit) => { elementKit = kit; }, (error: unknown) => {
    console.warn('[elements] models not loaded', error);
  });
  /** The weather drawn (`world/weather.ts`) */
  const rain = createRain();
  const lightning = createLightning();
  const cloudDrift = { x: 0, y: 0 };
  const canvasSize = new Vector2();
  const rainWind = new Vector2();
  let weatherActive = false;
  scene.add(rain.object, lightning.group);
  const strikeListeners: ((x: number, y: number, distance: number) => void)[] = [];
  /** A bolt onto the map point (x, y), from some way up in the sky. */
  const strikeAt = (x: number, y: number): void => {
    const ground = terrain.renderedHeightAt(x, y);
    const up = m(260) + Math.random() * m(140);
    lightning.strike(new Vector3(x + (Math.random() - 0.5) * up * 0.3, ground + up, -y + (Math.random() - 0.5) * up * 0.3), new Vector3(x, ground, -y));
    const distance = Math.hypot(x - rig.target.x, y + rig.target.z);
    for (const listener of strikeListeners) listener(x, y, distance);
  };
  /** The gully revision the relief was baked for. */
  let gulliesFor = -1;
  /** The painted fog's map (`fogLayer.ts`), and the fog and land it was built for. */
  const fogTexture = createFogTexture();
  let fogLayer: FogLayer | null = null;
  const fogField = createFogField(fogTexture);
  /** What the fog map follows in the diary, and how far it was read. */
  const FOG_KINDS: readonly ChangeKind[] = ['fog', 'terrain', 'ground'];
  let fogJournal: ChangeJournal | null = null;
  let fogSeen = -1;
  let fogTerrainSeen = -1;
  let fogMoving = false;
  /** Clouds placed on the map: they boil, so the frame is drawn now and then. */
  let placedCloudsShown = false;
  let natureTreesStarted = false;
  /** @rebuild Once, when the first world is in (`draw`). */
  const startNatureTrees = (): void => {
    natureTreesStarted = true;
    void loadNatureTrees(anisotropy).then(async (kit) => {
      // Its programs built before the first forest is drawn - its shadow's too, wind-swayed (`uploads.ts` shadowStandIn)
      const sample = buildNatureForest(FOREST_SPECIES.flatMap((species) => [0.1, 0.35, 0.6, 0.85].map((seed) => ({ x: 0, y: 0, z: 0, size: m(12), yaw: 0, seed, species }))), kit);
      const lit = new Group(), shadows = new Group();
      for (const mesh of sample.meshes) {
        lit.add(mesh);
        const standIn = shadowStandIn(mesh);
        if (standIn) shadows.add(standIn);
      }
      await Promise.all([compileAhead(lit), compileAhead(shadows, true)]);
      lit.clear();
      shadows.clear();
      sample.dispose();
      natureTreeKit = kit;
      // The kept trees are grown with it at the next look.
      vegetationRedraw = true;
      onAssetsReady();
    }, (error: unknown) => {
      natureTreesPending = false;
      vegetationRedraw = true;
      console.warn('[nature] trees not loaded; the procedural ones stay', error);
      onAssetsReady();
    });
  };
  /** The buildings cut open, for the people drawn inside them (`indoors.ts`). */
  let cutSpec: CutawaySpec | null = null;
  let skyMode: SkyMode = 'day';
  /** Clouds and mist as the player set them (`setAtmosphere`). */
  let atmosphere: Atmosphere = DEFAULT_ATMOSPHERE;
  /** The sun's colour times its strength, that the clouds are lit by. */
  const sunLight = new Color();
  /** Towards the sun, for the relief's own shadows (`TerrainSurface.setSun`). */
  const sunTowards = new Vector3();
  const flatDirection = new Vector3();
  const roomLamps = new RoomLamps();
  // Room lights for the floors cut open: a fixed set, so switching them on and off never changes the scene's light count
  const roomLights: PointLight[] = [];
  for (let i = 0; i < ROOM_LIGHTS; i++) {
    const light = new PointLight(0xffd6a0, 0, m(8), 2);
    light.name = 'room-light';
    light.castShadow = false;
    scene.add(light);
    roomLights.push(light);
  }
  let lampsKey = '';
  /** The sky's mesh (`environment.ts`), found once by name (`draw`). */
  let skyMesh: Object3D | null = null;
  let lastDark = -1;
  /** The building revision the ground was last graded for. */
  let gradedFor = -1;
  /** What the ground under the buildings is graded from (`buildingPads`) */
  /** The ground the buildings were last graded on (frozen while a stroke is held). */
  let buildingGround = '';
  /** Where and when the drawn ground changed: what stands on it is set again only there (`groundChanges.ts`). */
  let groundDiary: ChangeJournal | null = null;
  const GROUND_KINDS: readonly DerivedChangeKind[] = ['elevation', 'ground'];
  /** The serial of the latest change of the ground (not of the diary: a zone drawn is no change of the ground), and how far the diary was read for it. */
  let groundVersion = 0, groundScanned = 0;
  /** Where the ground changed after `since`, from the diary; null where it cannot say (the whole map, or forgotten). */
  const groundRectsSince = (since: number): ChangeRect[] | null => {
    const entries = groundDiary?.since(since, GROUND_KINDS);
    if (!entries) return null;
    const rects: ChangeRect[] = [];
    for (const entry of entries) {
      if (entry.rects === null) return null;
      rects.push(...entry.rects);
    }
    return rects;
  };
  const groundChanges: GroundRecord = {
    get version() {
      const diary = groundDiary;
      if (!diary || diary.version === groundScanned) return groundVersion;
      const fresh = diary.since(groundScanned, GROUND_KINDS);
      if (fresh === null) groundVersion = diary.version;
      else if (fresh.length) groundVersion = fresh[fresh.length - 1]!.serial;
      groundScanned = diary.version;
      return groundVersion;
    },
    touches: (since, area) => groundDiary?.touches(since, area, GROUND_KINDS) ?? false,
    // DO NOT leave it out: without it the gardens asked every planted building of the city whether the ground moved under it
    rectsSince: (since) => groundRectsSince(since),
  };
  /** The gardens' plants, building by building, on the ground they stand on (`gardenLists.ts`). */
  const plantLists = gardenLists(groundChanges, (b) => bankBox(b), (b) => gardenPlants([b], terrain.renderedHeightAt));
  /** Where the ground changed since a serial, from the same diary (`cameraSolids.ts` `GroundSince`). */
  const groundSince: GroundSince = {
    get version() { return groundChanges.version; },
    rectsSince: (since) => groundRectsSince(since),
  };
  /** What a building's floor reads (`floors.ts` on `builtGroundAt` and `pavedHeightAt`): the natural ground and the roads' heights, never the ground cut and filled to them
   *  - DO NOT re-floor the buildings for the diary's 'ground' (the ground shaped to the roads and the sites): it is not what the floor reads, and every block shaped in an opening re-floored the buildings round it again (3.7 floors a building, 2026-10-16). */
  const FLOOR_KINDS: readonly ChangeKind[] = ['elevation', 'terrain'];
  const floorGroundSince: GroundSince = {
    get version() { return groundDiary?.serialOf(...FLOOR_KINDS) ?? 0; },
    rectsSince: (since) => {
      const entries = groundDiary?.since(since, FLOOR_KINDS);
      if (!entries) return null;
      const rects: ChangeRect[] = [];
      for (const entry of entries) {
        if (entry.rects === null) return null;
        rects.push(...entry.rects);
      }
      return rects;
    },
  };
  /** Where a building's floor reads the ground and the paving (`FLOOR_READ_REACH`), once per record. */
  const floorBoxes = new WeakMap<Building, ChangeRect>();
  const floorBox = (b: Building): ChangeRect => {
    let box = floorBoxes.get(b);
    if (!box) {
      const r = storedBounds(b, FLOOR_READ_REACH);
      floorBoxes.set(b, box = [r.minX, r.minY, r.maxX, r.maxY]);
    }
    return box;
  };
  /** The buildings' solids for the camera's eye (`world/buildings/cameraSolids.ts`) */
  /** DO NOT key the canyon on a revision of the whole town again: it laid its whole window at every building. */
  const CANYON_KINDS: readonly ChangeKind[] = ['buildings', 'ground', 'elevation'];
  const CANYON_GROUND_REACH = FLOOR_READ_REACH + m(64);
  let canyonJournal: ChangeJournal | null = null;
  let canyonSerial = -1;
  const NOTHING_CHANGED: readonly ChangeRect[] = [];
  const canyonChanges = (journal: ChangeJournal): readonly ChangeRect[] | null => {
    const serial = journal.serialOf(...CANYON_KINDS);
    if (journal === canyonJournal && serial === canyonSerial) return NOTHING_CHANGED;
    const entries = journal === canyonJournal && canyonSerial >= 0 ? journal.since(canyonSerial, CANYON_KINDS) : null;
    canyonJournal = journal;
    canyonSerial = serial;
    if (!entries || entries.some((e) => e.rects === null)) return null;
    // The ground moved under a building's floor (it reads the ground round it) lifts the whole building
    const grow = (r: ChangeRect, d: number): ChangeRect => [r[0] - d, r[1] - d, r[2] + d, r[3] + d];
    return entries.flatMap((e) => e.kind === 'buildings' ? e.rects! : e.rects!.map((r) => grow(r, CANYON_GROUND_REACH)));
  };
  /** Each building's floor, once per record while what it reads stands (`floors.ts`) */
  const floors = buildingFloors(builtGroundAt, pavedHeightAt, floorBox, FLOOR_READ_REACH);
  const followFloors = (net: Network): void => floors.follow(net.doc.buildings, floorGroundSince);
  const cameraSolidsKept = cameraSolidsKeeper((b) => floors.floorOf(b), floorBox, FLOOR_READ_REACH);
  /** The roads watched for vanishing from the picture */
  let roadsWatchedAt = 0;
  let roadsReported = false;
  /** DO NOT copy every ribbon to pick four: a walk over the live map, four ribbons a look, started again at its end. */
  let roadsWalk: { readonly net: Network; readonly at: Iterator<SegmentRibbon> } | null = null;
  const nextWatched = (net: Network): SegmentRibbon | null => {
    let walk = roadsWalk;
    if (!walk || walk.net !== net) roadsWalk = walk = { net, at: net.ribbons.values() };
    let step = walk.at.next();
    if (step.done) { roadsWalk = walk = { net, at: net.ribbons.values() }; step = walk.at.next(); }
    return step.done ? null : step.value;
  };
  const watchRoads = (net: Network): void => {
    const now = performance.now();
    // Not while the world is being rebuilt: until the job lands the new roads have no picture yet by design
    if (now - roadsWatchedAt < 1000 || !reveal.opened || net.doc.segments.size === 0 || worldJob !== null) return;
    roadsWatchedAt = now;
    // DO NOT count every road mesh's vertices: one drawn mesh is the answer.
    const vertices = roads ? firstDrawnVertices(roads.group) : 0;
    let buried: { x: number; y: number; land: number; paved: number } | null = null;
    for (let k = 0; k < 4; k++) {
      const ribbon = nextWatched(net);
      if (!ribbon) break;
      const p = ribbon.full.sampleAt(ribbon.full.length / 2).p;
      const paved = pavedHeightAt(p.x, p.y), land = terrain.renderedHeightAt(p.x, p.y);
      // Under the land on purpose in a tunnel.
      if (net.doc.segment(ribbon.id)?.structure === 'tunnel') continue;
      if (Number.isFinite(paved) && land > paved + m(0.3)) { buried = { x: p.x, y: p.y, land, paved }; break; }
    }
    const missing = !roads || !roads.group.parent || vertices === 0;
    if ((missing || buried) && !roadsReported) {
      roadsReported = true;
      // Once, latched by `roadsReported`; as text, so a headless console log keeps it.
      console.error('roads missing from the picture', JSON.stringify({
        missing, buried, vertices, inWorld: !!roads?.group.parent, worldJob: worldJob !== null,
        terrainRevision: net.doc.terrainRevision, revision: net.revision,
      }));
    } else if (!missing && !buried) roadsReported = false;
  };
  /** Cuts and fills the ground to the roads AND to the buildings */
  /** Each building's platform, the town's, and the sites as last graded (`world/buildings/siteGrading.ts`). */
  const sitesGraded = siteGrading(builtGroundAt, pavedHeightAt, TERRAIN_CELL * 1.5, (b) => bankBox(b), floors);
  /** The box a building's bank reaches, once per record (records are never changed in place) */
  const bankBoxes = new WeakMap<Building, readonly [number, number, number, number]>();
  /** How far a building's bank reaches past its own bounds. */
  const BANK_REACH = TERRAIN_CELL * 1.5 + m(40) + TERRAIN_CELL;
  const bankBox = (b: Building): readonly [number, number, number, number] => {
    let box = bankBoxes.get(b);
    if (!box) {
      const r = storedBounds(b, BANK_REACH);
      bankBoxes.set(b, box = [r.minX, r.minY, r.maxX, r.maxY]);
    }
    return box;
  };
  /** DO NOT walk the town for it: every building's bank was made again at each building grown */
  const buildingsOnGroundSince = (doc: RoadDoc, serial: number): Building[] | null => {
    const rects = groundSince.rectsSince(serial);
    if (!rects) return null;
    // Every change in one look (`nearAny`): a change at a time read the cells they share again for each.
    return doc.buildings.nearAny(rects, BANK_REACH, (b, r) => {
      const box = bankBox(b);
      return box[0] <= r[2] && box[2] >= r[0] && box[1] <= r[3] && box[3] >= r[1];
    });
  };
  /** The ground serial the buildings were last told of (`buildingGround`). */
  let buildingGroundSeen = -1;
  /** Where two solves of the roads differ: the blocks of the map whose ground the roads shape differently. */
  const SHAPE_BLOCK = 160;
  /** What a block of ground reads of a solve, digested: at each corner of the terrain grid in it */
  const groundRead = new WeakMap<RoadElevation, Map<number, number>>();
  /** The blocks of a solve being digested off the page, each with the job that will file it (`compareSolves`). */
  const groundReading = new WeakMap<RoadElevation, Map<number, Promise<void>>>();
  const blockKey = (x0: number, y0: number): number => x0 * 65_536 + y0;
  const readOf = (solve: RoadElevation): Map<number, number> => {
    let known = groundRead.get(solve);
    if (!known) groundRead.set(solve, known = new Map());
    return known;
  };
  /** A block of a solve digested on the page (`groundShape.ts` `blockDigest`, the worker's own function). */
  const blockRead = (solve: RoadElevation, x0: number, y0: number): number => {
    const known = readOf(solve);
    const key = blockKey(x0, y0);
    const kept = known.get(key);
    if (kept !== undefined) return kept;
    const value = blockDigest(solve, terrain.naturalRenderedHeightAt, x0, y0, SHAPE_BLOCK, TERRAIN_CELL, TERRAIN_HALF);
    known.set(key, value);
    return value;
  };
  /** The plates whose blocks a comparison reads: those the boxes reach, or (no boxes) the plates drawn in full. */
  const platesUnder = (where: readonly { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number }[] | null):
    { readonly cx: number; readonly cy: number; readonly half: number }[] => {
    if (!where) return terrain.parts.map((p) => ({ cx: p.cx, cy: p.cy, half: TERRAIN_HALF }));
    const keys = new Set<number>();
    for (const r of where) for (const k of platesOver([r.minX, r.minY, r.maxX, r.maxY])) keys.add(k);
    return [...keys].map(plateRegion);
  };
  /** Two solves compared block by block (`compareSolves`): `blocks` once `ready`, with the page's time it took. */
  interface BlockCompare { blocks: [number, number, number, number][]; ready: boolean; ms: number }
  /** The blocks whose ground two solves of the roads shape differently, or whose decks differ */
  const compareSolves = (before: RoadElevation, after: RoadElevation, landBlocks: readonly [number, number, number, number][] | null): BlockCompare => {
    const at = performance.now();
    const out: BlockCompare = { blocks: [], ready: false, ms: 0 };
    const candidates: [number, number][] = [];
    // Only blocks a road that differs reaches can differ (`differences`)
    const where = after.differences?.(before) ?? null;
    if (!where || where.length) {
      // The blocks of the plates the differences reach; not knowing where, of the plates drawn in full (only their ground is shaped, `shapeToRoads`), never of a world's plates.
      for (const plate of platesUnder(where)) {
        for (let x = plate.cx - plate.half; x < plate.cx + plate.half; x += SHAPE_BLOCK) {
          for (let y = plate.cy - plate.half; y < plate.cy + plate.half; y += SHAPE_BLOCK) {
            const x1 = x + SHAPE_BLOCK, y1 = y + SHAPE_BLOCK;
            if (where && !where.some((r) => r.minX <= x1 && r.maxX >= x && r.minY <= y1 && r.maxY >= y)) continue;
            candidates.push([x, y]);
          }
        }
      }
    }
    const finish = (): void => {
      const changed: [number, number, number, number][] = [];
      for (const [x, y] of candidates) if (blockRead(before, x, y) !== blockRead(after, x, y)) changed.push([x, y, x + SHAPE_BLOCK, y + SHAPE_BLOCK]);
      if (landBlocks) {
        const seen = new Set(changed.map((b) => `${b[0]},${b[1]}`));
        for (const b of landBlocks) if (!seen.has(`${b[0]},${b[1]}`)) changed.push(b);
      }
      out.blocks = changed;
      out.ready = true;
    };
    const waits: Promise<void>[] = [];
    const ask: { solve: RoadElevation; blocks: [number, number][] }[] = [];
    for (const solve of [before, after]) {
      const known = readOf(solve);
      const reading = groundReading.get(solve);
      const mine: [number, number][] = [];
      for (const [x, y] of candidates) {
        const key = blockKey(x, y);
        if (known.has(key)) continue;
        const job = reading?.get(key);
        if (job) { if (!waits.includes(job)) waits.push(job); continue; }
        mine.push([x, y]);
      }
      if (mine.length) ask.push({ solve, blocks: mine });
    }
    if (ask.length && groundWorkers.available && ask.every((a) => a.solve.shapeCut)) {
      // The roads near the blocks asked and the ground under them, as plain numbers; a block the worker cannot read
      const rect = (x: number, y: number): [number, number, number, number] => [x - 1, y - 1, x + SHAPE_BLOCK + 1, y + SHAPE_BLOCK + 1];
      const job: BlockDigestAsk = {
        solves: ask.map(({ solve, blocks }) => ({
          roads: solve.shapeCut!(blocks.map(([x, y]) => rect(x, y))),
          blocks: Float64Array.from(blocks.flat()),
        })),
        plates: terrain.naturalCut?.(ask.flatMap(({ blocks }) => blocks.map(([x, y]) => rect(x, y)))) ?? [],
        block: SHAPE_BLOCK, cell: TERRAIN_CELL, half: TERRAIN_HALF,
      };
      const filed = groundWorkers.digest(job).then((answers) => {
        ask.forEach(({ solve, blocks }, k) => {
          const known = readOf(solve);
          blocks.forEach(([x, y], j) => { const v = answers[k]![j]!; if (!Number.isNaN(v)) known.set(blockKey(x, y), v); });
        });
      }, (error: unknown) => { console.warn('[ground] blocks digested on the page', error); }).finally(() => {
        for (const { solve, blocks } of ask) for (const [x, y] of blocks) groundReading.get(solve)?.delete(blockKey(x, y));
      });
      for (const { solve, blocks } of ask) {
        let reading = groundReading.get(solve);
        if (!reading) groundReading.set(solve, reading = new Map());
        for (const [x, y] of blocks) reading.set(blockKey(x, y), filed);
      }
      waits.push(filed);
    }
    if (!waits.length) { finish(); out.ms = performance.now() - at; return out; }
    out.ms = performance.now() - at;
    void Promise.all(waits).then(() => { const t = performance.now(); finish(); out.ms += performance.now() - t; });
    return out;
  };
  /** A terrain region (`terrainRegion`) back as the world box it covers, a cell round. */
  const regionRect = (region: TerrainRegion): Rect => terrain.rectOf(region);
  /** A world box as the terrain grid corners it covers. */
  const terrainRegion = (box: readonly [number, number, number, number]): TerrainRegion => terrain.regionOf(box);
  /** `region`: a brush dab while the stroke is held */
  /** The ground cut and filled again only in `blocks` (the roads changed there, the land did not) */
  /** `shapeBlocks` in steps (`worldSteps`) */
  function* shapeBlocksSteps(net: Network, blocks: readonly [number, number, number, number][]): Generator<'wait' | void, void, void> {
    // DO NOT walk `buildings.all()` for them, nor every building for a platform not known yet (`ensure`, a building a step)
    const reached = net.doc.buildings.nearAny(blocks, BANK_REACH, (b, q) => {
      const box = bankBox(b);
      return box[0] <= q[2] && box[2] >= q[0] && box[1] <= q[3] && box[3] >= q[1];
    });
    followFloors(net);
    for (const b of reached) {
      sitesGraded.refresh(b);
      yield;
    }
    gradedFor = net.doc.buildings.revision;
    // The sites that changed with the edit
    const sites = sitesGraded.changedSites(net.doc.buildings);
    sitesGraded.rebuild(net.doc.buildings);
    yield;
    // Each block in quarters, a quarter a step: a whole block was 18 ms of terrain in one step, past the frame's allowance
    const quarters = (q: readonly [number, number, number, number]): [number, number, number, number][] => {
      const mx = (q[0] + q[2]) / 2, my = (q[1] + q[3]) / 2;
      return [[q[0], q[1], mx, my], [mx, q[1], q[2], my], [q[0], my, mx, q[3]], [mx, my, q[2], q[3]]];
    };
    const regions = blocks.flatMap(quarters).map(terrainRegion);
    if (sites) regions.push(...sites.map(terrainRegion));
    // DO NOT cut it into a block a step again: that spread the page's work over frames, and it is the worker's now.
    const shaping = shapeGround(net, regions, false, true);
    while (!shaping.landed) { landShapes(); if (shaping.landed) break; yield 'wait'; }
    derived(net, 'ground', regions.map(regionRect), 'ground cut and filled up to the roads', worldCause,
      { ms: shaping.ms, detail: `${regions.length} regions` });
  }


  /** The ground's work off the page (`groundShapePool.ts`). */
  const groundWorkers = new GroundShapePool();
  /** A shaping pass asked of the ground's worker (`shapeGround`): put in place in the order asked (`landShapes`). */
  interface Shaping {
    readonly ask: GroundShapeAsk;
    readonly take: (answers: readonly PlateShapeAnswer[]) => boolean;
    /** What the ground's readers are told, once the heights are in place (the diary's 'ground'). */
    readonly then: () => void;
    answers: PlateShapeAnswer[] | null;
    failed: boolean;
    landed: boolean;
    /** The page's time: the ask put together and the answer put in place. */
    ms: number;
  }
  /** The passes asked, in order. */
  const shapings: Shaping[] = [];
  const LANDED = { landed: true, ms: 0 } as const;
  /** Puts in place every pass answered, in the order asked, up to the first still being worked out. */
  const landShapes = (): void => {
    while (shapings.length) {
      const next = shapings[0]!;
      if (!next.answers && !next.failed) { groundWorkers.check(); return; }
      shapings.shift();
      const at = performance.now();
      next.take(next.answers ?? shapeGroundAsk(next.ask));
      next.ms += performance.now() - at;
      next.landed = true;
      next.then();
    }
  };
  /** DO NOT shape the corners here while the worker is there: 9.5 s of the page in a 2,560 m city's growth (2026-10-15). */
  const shapeGround = (net: Network, regions: TerrainRegion | readonly TerrainRegion[] | null = null, sites = false, padsReady = false): { readonly landed: boolean; readonly ms: number } => {
    const at = performance.now();
    const list: readonly TerrainRegion[] | null = regions === null ? null
      : typeof regions[0] === 'number' ? [regions as TerrainRegion] : regions as readonly TerrainRegion[];
    if (list && !list.length) return LANDED;
    const region = list;
    // The ground is cut and filled here, and only here: what stands on it reads where from the diary
    const parent = net.doc.changes.version;
    const told = (): void => {
      if (padsReady) return;
      derived(net, 'ground', list ? list.map(regionRect) : null, sites ? 'lot ground levelled' : 'ground cut and filled', parent);
    };
    const roads = net.doc.segments.size > 0 ? elevation : null;
    followFloors(net);
    if (!padsReady && (!region || !sitesGraded.pads || sites)) {
      gradedFor = net.doc.buildings.revision;
      // The roads or the land moved: every platform is worked out afresh.
      if (!sites) sitesGraded.forget(net.doc.buildings);
      sitesGraded.rebuild(net.doc.buildings);
    }
    const pads = net.doc.buildings.size > 0 ? sitesGraded.pads : null;
    if (groundWorkers.available || shapings.length) {
      // The corners asked, and the roads and platforms they read as they stand now, as plain numbers.
      const asking = terrain.askShape(region, region ? null : [...(roads?.shapeBounds() ?? []), ...(pads?.shapeBounds() ?? [])]);
      const boxes = cornerBoxes(asking.plates, TERRAIN_CELL, TERRAIN_HALF);
      const ask: GroundShapeAsk = { roads: roads ? roads.shapeCut!(boxes) : null, pads: pads ? pads.cut(boxes) : null, plates: asking.plates };
      const shaping: Shaping = { ask, take: asking.take, then: told, answers: null, failed: false, landed: false, ms: 0 };
      shapings.push(shaping);
      if (groundWorkers.available) {
        groundWorkers.shape(ask).then((answers) => { shaping.answers = answers; }, (error: unknown) => {
          console.warn('[ground] a pass is shaped on the page', error);
          shaping.failed = true;
        });
      } else shaping.failed = true;
      shaping.ms = performance.now() - at;
      // No worker: put in place now, after the passes before it.
      if (shaping.failed) landShapes();
      return shaping;
    }
    told();
    const shape = pads ? { shapeBounds: () => [...(roads?.shapeBounds() ?? []), ...pads.shapeBounds()], shapeAt: shapeBoth(roads, pads) } : roads;
    terrain.shapeToRoads(shape, region);
    return { landed: true, ms: performance.now() - at };
  };

  /** `doc.utilityRevision` the poles and the furniture were last brought up to. */
  let utilityRevision = -1;
  /** What moves a pole or its parts: the poles and wires, the roads (its kerb), the roads' heights and the ground under it. */
  const POLE_KINDS: readonly ChangeKind[] = ['utilities', 'roads', 'elevation', 'ground', 'terrain'];
  /** The diary's serial of `POLE_KINDS` the pole layer was brought up to. */
  let poleSerial = -1;
  /** The pole layer brought up to the diary (`poleLayer.ts`) */
  const syncUtilities = (net: Network, groundAt: (x: number, y: number) => number): void => {
    const serial = net.doc.changes.serialOf(...POLE_KINDS);
    if (utilities && serial === poleSerial) return;
    const entries = utilities ? net.doc.changes.since(poleSerial, POLE_KINDS) : null;
    const before = utilities?.triangles ?? 0;
    if (!utilities || entries === null || entries.some((e) => e.rects === null)) {
      if (utilities) { world.remove(utilities.group); utilities.dispose(); }
      utilities = buildUtilities(net, groundAt, sceneryKit, docPoles(net.doc));
      world.add(utilities.group);
    } else {
      utilities.follow(net, groundAt, net.doc, entries);
    }
    builtTriangles += utilities.triangles - before;
    poleSerial = serial;
  };
  /** The poles and the placed things, outside a world being built: a pole edit moves only `doc.utilityRevision` */
  const rebuildUtilities = (net: Network): void => {
    if (!elevation) return;
    utilityRevision = net.doc.utilityRevision;
    const at = performance.now();
    syncUtilities(net, poleGroundAt(elevation, terrain.renderedHeightAt, net));
    performance.measure('hitch:utilities/poles', { start: at, end: performance.now() });
  };

  /** The city's clock, read each frame: the planted trees and shrubs grow with it (`plantGrowth`). */
  let cityMinutes = Number.NaN;
  /** The street furniture and the signs brought up to the diary, once the world stands (`draw`): the furniture item by item */
  /** The world the placed things stand on, once it stands (`draw`): what the engine's 'draw' phase reads. */
  let placedOn: Network | null = null;
  engine.register({
    name: 'street furniture',
    refresh: (): number => {
      if (!placedOn || !elevation) return 0;
      const at = performance.now();
      const before = furniture.triangles;
      const work = furniture.sync(placedOn, elevation, terrain.renderedHeightAt, cityMinutes);
      builtTriangles += furniture.triangles - before;
      performance.measure('hitch:furniture', { start: at, end: performance.now() });
      return work;
    },
  }, 'draw');
  engine.register({
    name: 'signs',
    // DO NOT build every sign of the map again on a serial of the roads, the land or the landscaping: every edit anywhere did.
    refresh: (): number => {
      if (!placedOn || !elevation) return 0;
      if (!signs.group.parent) world.add(signs.group);
      return signs.sync(placedOn, elevation);
    },
  }, 'draw');

  engine.register({
    name: 'barriers',
    // DO NOT build every barrier of the map again on its revision or on a change of the ground under any one.
    refresh: (): number => {
      if (!placedOn) return 0;
      if (!barriers.group.parent) world.add(barriers.group);
      const before = barriers.triangles;
      const work = barriers.sync(placedOn.doc, terrain.renderedHeightAt);
      builtTriangles += barriers.triangles - before;
      return work;
    },
  }, 'draw');
  engine.register({
    name: 'transit',
    // DO NOT build the whole transport again on its revision or the ground under it.
    refresh: (): number => {
      const net = placedOn;
      if (!net) return 0;
      if (!transit.group.parent) { world.add(transit.group); transit.setXray(transitXray); }
      const before = transit.triangles;
      // A metro entrance stands off the streets and out of the buildings: the buildings at the point only
      const work = transit.sync(net.doc, terrain.renderedHeightAt, pavedHeightAt, (p) => {
        if (onCarriageway(net, p)) return true;
        for (const b of net.doc.buildings.near(p.x, p.y, p.x, p.y)) {
          if (solidFootprints(b).some((ring) => pointInPolygon(p, ring))) return true;
        }
        return false;
      });
      builtTriangles += transit.triangles - before;
      return work;
    },
  }, 'draw');

  /** The comparisons of solves whose blocks a dropped rebuild had not shaped yet */
  let pendingBlocks: (BlockCompare | null)[] = [];
  /** The land a brush moved since the world was last built */
  let landDirty: Rect | 'all' | null = null;
  /** The shaping blocks a world box reaches, on the grid `changedBlocks` uses. */
  const blocksOver = (box: Rect): [number, number, number, number][] => {
    const out: [number, number, number, number][] = [];
    for (const key of platesOver(box)) {
      const plate = plateRegion(key);
      const left = plate.cx - plate.half, right = plate.cx + plate.half;
      const bottom = plate.cy - plate.half, top = plate.cy + plate.half;
      if (box[2] <= left || box[0] >= right || box[3] <= bottom || box[1] >= top) continue;
      const x0 = Math.max(left, Math.floor((box[0] - left) / SHAPE_BLOCK) * SHAPE_BLOCK + left);
      const y0 = Math.max(bottom, Math.floor((box[1] - bottom) / SHAPE_BLOCK) * SHAPE_BLOCK + bottom);
      for (let x = x0; x < Math.min(right, box[2]); x += SHAPE_BLOCK) {
        for (let y = y0; y < Math.min(top, box[3]); y += SHAPE_BLOCK) out.push([x, y, x + SHAPE_BLOCK, y + SHAPE_BLOCK]);
      }
    }
    return out;
  };
  /** The diary entry the world being built follows from (`world/changes.ts`). */
  let worldCause = 0;
  /** Writes what the world derived in the document's diary, after `parent`; its serial (0: nothing written). */
  const derived = (net: Network, kind: DerivedChangeKind, rects: readonly ChangeRect[] | null, cause: string, parent: number,
    extra: { readonly ms?: number; readonly detail?: string } = {}): number =>
    net.doc.changes.record(kind, rects, { cause, ...(parent ? { parent } : {}), ...extra });
  /** The network the world was last built for: what stands on a footway reads it (`footwayRiseAt`). */
  let worldNet: Network | null = null;
  const rebuildWorld = (net: Network): void => {
    worldNet = net;
    if (networkRevision === net.revision && terrainRevision === net.doc.terrainRevision) {
      // A world being built builds the poles too (`worldSteps`)
      if (worldJob === null && (utilityRevision !== net.doc.utilityRevision || poleSerial !== net.doc.changes.serialOf(...POLE_KINDS))) {
        const atUtilities = performance.now();
        rebuildUtilities(net);
        performance.measure('hitch:road-edit/utilities alone', { start: atUtilities, end: performance.now() });
      }
      return;
    }
    buildWorld(net);
  };
  /** @rebuild The roads' heights solved again and the world's rebuild started (`worldSteps`). */
  const buildWorld = (net: Network): void => {
    const started = performance.now();
    // Only the roads changed (the land did not): the ground is cut and filled again only where the solve of the roads differs.
    const landStill = terrainRevision === net.doc.terrainRevision && elevation !== null;
    const previousElevation = elevation;
    networkRevision = net.revision;
    terrainRevision = net.doc.terrainRevision;

    // ONE solve for the whole network, shared by every consumer below.
    const offered = offeredElevation;
    offeredElevation = null;
    elevation = offered && offered.revision === net.revision && offered.terrain === terrainRevision
      ? offered.elevation
      // On land that has not moved, from the last solve
      : buildRoadElevation(net, builtGroundAt, landStill ? previousElevation : null);
    performance.measure('hitch:road-edit/elevation', { start: started, end: performance.now() });
    // Now the ground comes to meet the roads
    const land = landDirty;
    landDirty = null;
    const landBlocks = !landStill && land !== null && land !== 'all' ? blocksOver(land) : null;
    // The blocks the two solves differ in, digested off the page (`compareSolves`) and read by the job, which waits for them
    const compare = previousElevation && (landStill || landBlocks) ? compareSolves(previousElevation, elevation, landBlocks) : null;
    pendingBlocks = compare && !pendingBlocks.includes(null) ? [...pendingBlocks, compare] : [null];
    const elevationMs = performance.now() - started;
    const cause = net.doc.changes.version;
    // DO NOT build it in one go: the roads of a generated city were built in the frame of the change, on the page
    worldJob = worldSteps(net, pendingBlocks, { cause, elevationMs }, started, true);
    worldJobFresh = true;
    worldJobGround = true;
  };

  /** @rebuild What `worldSteps` builds before it is put in place at once. */
  function* worldSteps(net: Network, compares: readonly (BlockCompare | null)[], solved: { readonly cause: number; readonly elevationMs: number },
    started: number, sliced: boolean): Generator<'wait' | void, void, void> {
    const solve = elevation!;
    // The blocks the solves differ in, once the worker has digested them (`compareSolves`).
    while (compares.some((c) => c && !c.ready)) { groundWorkers.check(); yield 'wait'; }
    const own = compares[compares.length - 1] ?? null;
    const changed = own ? own.blocks : null;
    // In the diary: the roads' heights solved again where they differ, after the edit that moved them.
    worldCause = derived(net, 'elevation', changed, 'road heights solved', solved.cause,
      { ms: solved.elevationMs + (own?.ms ?? 0), detail: changed ? `${changed.length} blocks of ${SHAPE_BLOCK} u` : 'whole map' }) || solved.cause;
    // The roads' own heights (the footway, the carriageway) moved where the solve did
    // DO NOT shape the whole map when the blocks are known, however many: past a quarter of the plates loaded it re-floored and re-graded every building of the region at each tile the streamed world put in (5 floors a building in an opening, 2026-10-16); the blocks' work follows what moved.
    const blocks = compares.includes(null) ? null : compares.flatMap((c) => c!.blocks);
    if (blocks === null) {
      const shaping = shapeGround(net);
      while (!shaping.landed) { landShapes(); if (shaping.landed) break; yield 'wait'; }
    } else if (blocks.length || gradedFor !== net.doc.buildings.revision) yield* shapeBlocksSteps(net, blocks);
    pendingBlocks = [];
    worldJobGround = false;
    yield;
    // The tiles kept from the last session, read while the game started: a sliced build waits for them a little
    if (sliced && !storedRead) {
      const since = performance.now();
      while (!storedRead && performance.now() - since < KEPT_TILES_WAIT_MS) yield 'wait';
    }
    // Sliced, the tiles are shaped by the workers while the frames go on (`roadTilePool.ts`); built in one go
    const freshRoads = yield* roadSurfaceSteps(net, solve, materials, terrain.renderedHeightAt, surfaceReuse, terrain.vergeMaterial,
      sliced ? roadTiles : null);
    derived(net, 'surfaces', freshRoads.rebuilt, 'road surfaces rebuilt', worldCause,
      { ms: freshRoads.workMs, detail: `${freshRoads.built} tiles feitos, ${freshRoads.reused} aproveitados` });
    // The structures' details, the poles and the street furniture are each kept as they are when the edit's blocks reach none
    const atdetails = performance.now();
    details ??= createStructureCells(materials, terrain.vergeMaterial);
    const freshDetails = details.prepare(net, solve, terrain.renderedHeightAt, blocks);
    performance.measure('hitch:road-edit/details', { start: atdetails, end: performance.now() });
    yield;
    // The overhead utility network.
    const utilityBuilt = net.doc.utilityRevision;
    yield;

    // The new pieces' shaders compiled before they are drawn - in parallel where the driver can
    if (sliced) {
      const stage = new Group();
      for (const piece of [freshRoads.group, ...freshDetails.fresh]) {
        if (piece.parent === null) stage.add(piece);
      }
      if (stage.children.length > 0) {
        let compiled = false;
        void compileAhead(stage).then(() => { compiled = true; });
        while (!compiled) yield 'wait';
      }
    }

    // Everything in place at once: the world as it was goes - only what is replaced here.
    let triangles = builtTriangles;
    if (roads && roads !== freshRoads) { triangles -= roads.triangles; world.remove(roads.group); roads.dispose(); }
    triangles -= details.triangles;
    for (const mesh of surfaceReuse.retired?.splice(0) ?? []) disposeMesh(mesh);
    roads = freshRoads;
    roads.adopt();
    world.add(roads.group);
    freshDetails.apply();
    if (!details.group.parent) world.add(details.group);
    utilityRevision = utilityBuilt;
    builtTriangles = triangles + roads.triangles + details.triangles;
    // The poles the edit reached, on the ground just put in place (`syncUtilities`, from the diary).
    const atutilities = performance.now();
    syncUtilities(net, poleGroundAt(solve, terrain.renderedHeightAt, net));
    performance.measure('hitch:road-edit/utilities', { start: atutilities, end: performance.now() });
    // The street furniture and the signs follow from the diary once the world stands (the engine's 'draw' phase, in `draw`).
    rebuildMs = performance.now() - started;
    performance.measure('hitch:road-edit/world rebuilt', { start: started, end: performance.now() });
    rebuilds++;
    onAssetsReady();
  }

  /** The road shaders compiled before the first road is drawn. */
  let roadShadersWarm: 'no' | 'started' = 'no';
  /** @rebuild Once; every later frame returns at its first check. */
  const warmRoadShaders = (): void => {
    if (roadShadersWarm !== 'no') return;
    roadShadersWarm = 'started';
    try {
      const doc = new RoadDoc();
      const centre = doc.addNode({ x: 0, y: 0 });
      // Each class of road, a junction and a pedestrian crossing on one leg.
      [[m(70), 0, 0], [-m(70), 0, 1], [0, m(70), 2], [0, -m(70), 3]].forEach(([x, y, type]) => {
        doc.addSegment(doc.addNode({ x: x!, y: y! }).id, centre.id, type!);
      });
      const pole1 = doc.addPole({ x: m(20), y: m(12) }, true);
      const pole2 = doc.addPole({ x: m(50), y: m(12) }, false);
      doc.addPoleSpan(pole1.id, pole2.id);
      const warmNet = new Network(doc);
      warmNet.rebuild();
      const flat = (): number => 0;
      const warmElevation = buildRoadElevation(warmNet, flat);
      const group = new Group();
      const parts = [
        buildRoadSurfaces(warmNet, warmElevation, materials, flat, undefined, terrain.vergeMaterial),
        buildStructureDetails(warmNet, warmElevation, flat, materials),
        buildUtilities(warmNet, poleGroundAt(warmElevation, flat), sceneryKit),
      ];
      for (const part of parts) group.add(part.group);
      // And the street furniture's, the long grass's and the signs' meshes as their layers draw them, with their shadows
      const placedShadows = new Group();
      for (const mesh of [...furniture.warm(), ...signs.warm()]) {
        group.add(mesh);
        const standIn = shadowStandIn(mesh);
        if (standIn) placedShadows.add(standIn);
      }
      void compileAhead(placedShadows, true).then(() => placedShadows.clear());
      void compileAhead(group).then(() => {
        for (const part of parts) part.dispose();
      });
    } catch (error) {
      console.warn('road shader warm-up skipped', error);
    }
  };

  /** The shaders a blow first needs - a broken building's pieces */
  let blastShadersWarm = false;
  /** @rebuild Once; every later frame returns at its first check. */
  const warmBlastShaders = (): void => {
    if (blastShadersWarm) return;
    blastShadersWarm = true;
    const kit = buildings.kit;
    const tiny = new BufferGeometry();
    tiny.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    tiny.setAttribute('normal', new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    tiny.setAttribute('color', new Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1], 3));
    tiny.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
    tiny.setAttribute('aDecay', new Float32BufferAttribute([0, 0, 0], 1));
    const group = new Group();
    const mats = [kit.shellMaterial, kit.ruinShell, kit.facade, ...Object.values(kit.material), kit.furniture().material, kit.massing];
    for (const mat of mats) {
      const mesh = new Mesh(tiny, mat);
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
      group.add(mesh);
    }
    // In the scene for its lights, but never drawn
    group.visible = false;
    scene.add(group);
    void compileAhead(group).then(() => { scene.remove(group); tiny.dispose(); });
    // And every part as the layer draws it, instanced, with its shadow (`partWarmMeshes`)
    const parts = new Group();
    const partShadows = new Group();
    for (const mesh of partWarmMeshes(kit)) {
      parts.add(mesh);
      const standIn = shadowStandIn(mesh);
      if (standIn) partShadows.add(standIn);
    }
    parts.visible = false;
    scene.add(parts);
    void compileAhead(parts).then(() => { scene.remove(parts); parts.clear(); });
    void compileAhead(partShadows, true).then(() => partShadows.clear());
  };

  /** The tools' previews compiled ahead, as the roads' and the blows' are */
  let previewShadersWarm = false;
  /** @rebuild Once; every later frame returns at its first check. */
  const warmPreviewShaders = (): void => {
    if (previewShadersWarm) return;
    previewShadersWarm = true;
    try {
      const group = new Group();
      const done: (() => void)[] = [];
      const blueprint = BLUEPRINTS[0];
      if (blueprint) {
        const sample = { ...instantiate(blueprint.body, { x: 0, y: 0 }, 0), id: -1 } as Building;
        const ghost = buildBuildingMeshes([sample], () => 0, buildings.kit, true);
        group.add(ghost.group);
        done.push(() => ghost.dispose());
        // And as a building grown on a lot draws it: its window panes carry their rooms' light slots
        const real = buildBuildingMeshes([sample], () => 0, buildings.kit, false);
        group.add(real.group);
        done.push(() => real.dispose());
        // And faded ("ocultar outros", `fade.ts`): the faded materials on parts with and without instance colours.
        const faded = buildBuildingMeshes([sample], () => 0, buildings.kit, false);
        fadeMeshes(faded.group, buildings.kit, true);
        group.add(faded.group);
        done.push(() => faded.dispose());
      }
      // The gardens' plants and their shadows, the first lots painted grow them.
      const plants = plantSamples(sceneryKit);
      group.add(plants.group);
      void compileAhead(plants.depth, true);
      done.push(() => plants.dispose());
      for (const mode of ['train', 'metro'] as const) {
        const track = buildTrackPreview([{ x: 0, y: 0 }, { x: m(60), y: 0 }], mode, () => 0);
        group.add(track.group);
        done.push(() => track.dispose());
      }
      // The lots need no program of their own: the ground's materials draw them (`lotOverlay.ts`).
      void compileAhead(group).then(() => { for (const finish of done) finish(); });
    } catch (error) {
      console.warn('preview shader warm-up skipped', error);
    }
  };

  const applyQuality = (level: QualityLevel, settings: QualitySettings = QUALITY[level]): void => {
    quality = settings;
    // The far woods as dense as the near ones, on the same budget (`farWoods.ts`).
    terrain.setVegetation?.(quality.vegetation);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatio));
    renderer.shadowMap.enabled = quality.shadows;
    materials.setDetail(quality.surfaceDetail);
    environment.setQuality({ shadows: quality.shadows, shadowMapSize: quality.shadowMapSize });
    post?.dispose();
    post = createPostChain(renderer, scene, rig.camera, quality, level);
    post.setNight(Math.max(0, lastDark));
    resize();
    // DO NOT force one with `networkRevision = -1`
    shadowMoved = true;
  };

  let post: PostChain = createPostChain(renderer, scene, rig.camera, quality, governor.current);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatio));

  function resize(): void {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    renderer.setSize(width, height, false);
    rig.resize(width, height);
    post.setSize(width, height, renderer.getPixelRatio());
    // The GPU's cap from the device and the drawing buffer's pixels, and the frame's targets in the ledger (`gpuLedger.ts`).
    gpuLedger.cap = deviceGpuCap(readGpuDevice(renderer.getContext(), canvas.width * canvas.height));
    gpuLedger.set('render targets', 'render targets', renderTargetsBytes(post.targets()));
  }
  resize();

  const target = new Vector3();
  let fps = 60;
  /** Wall-clock seconds, for the wind; independent of the simulation speed. */
  let windClock = 0;
  let lastWidth = 0;
  let lastHeight = 0;

  // Development only: the production build replaces the flag with false and drops the inspector with it.
  const inspect = import.meta.env.DEV ? createInspector(renderer, scene) : null;
  let lotOverlay: ReturnType<typeof createLotOverlay> | null = null;
  let transitXray = false;
  let transitPreview: TrackPreview | null = null;
  let transitPreviewKey = '';

  /** The map zoom and the plant layers `setMap` was last told about (`draw`). */
  let plantMapFor: { map: boolean | null; gardens: Gardens | null } = { map: null, gardens: null };
  /** In perspective: how far down the street a person or a car is still big enough to see appear, u. */
  const VIEW_SEEN = m(320);
  /** In perspective: radians added to each side of the camera's width (the camera turns). */
  const VIEW_MARGIN = 0.35;
  /** What grows of itself on a map with an ecosystem (`world/ecology.ts`) */
  const NATURE_SPACING = WOODS_SPACING;
  /** Trees the ecosystem grows at full vegetation quality (the forests take most). */
  const NATURE_TREES = 2_500;
  /** The ecosystem's sweep: where a tree may grow, the budget the tier allows, and the room a forest of them needs. */
  interface NatureSweep {
    readonly key: string;
    readonly trees: readonly Candidate[];
    readonly budget: number;
    room: number[] | null;
    /** Plates left to sweep (one is swept a frame): the sweep runs again next frame while any is. */
    readonly pending?: number;
    /** Each plate's run of `trees` (filed plate by plate, `fileNature`). */
    readonly slices?: readonly { readonly plate: NaturePlate; readonly start: number; readonly count: number }[];
  }
  /** One plate's tree density as last swept, and what it was swept for (`natureSweep`), by surface. */
  interface NaturePlate {
    readonly key: string; readonly part: TerrainPart; readonly odds: Float32Array; readonly band: Uint8Array; readonly di: number; readonly dj: number; readonly sum: number;
    /** Its trees as last picked, and the scale they were picked at: picked again only when either moved. */
    picked: { readonly scale: number; readonly trees: readonly Candidate[] } | null;
    /** The trees of `picked` kept on open ground (its own indices, their ground), and what they were kept for. */
    kept: { readonly key: string; readonly of: readonly Candidate[]; readonly idx: readonly number[]; readonly z: readonly number[] } | null;
  }
  const naturePlates = new WeakMap<object, NaturePlate>();
  /** DO NOT key every plate's sweep on the document's terrain revision */
  const plateLandRead = new JournalCursor(['terrain']);
  const plateLand = new WeakMap<object, number>();
  let landSerial = 0;
  const bringPlateLand = (doc: RoadDoc): void => {
    const entries = plateLandRead.read(doc.changes);
    if (entries !== null && entries.length === 0) return;
    for (const part of terrain.parts) {
      const box: ChangeRect = [part.cx - TERRAIN_HALF - TERRAIN_CELL, part.cy - TERRAIN_HALF - TERRAIN_CELL, part.cx + TERRAIN_HALF + TERRAIN_CELL, part.cy + TERRAIN_HALF + TERRAIN_CELL];
      const reached = entries === null || entries.some((e) => e.rects === null || e.rects.some((r) => r[0] <= box[2] && r[2] >= box[0] && r[1] <= box[3] && r[3] >= box[1]));
      if (reached) plateLand.set(part.surface, ++landSerial);
    }
  };
  const natureSweep = (key: string): NatureSweep => {
    const trees: Candidate[] = [];
    if (quality.vegetation <= 0 || !terrain.parts.some((p) => p.surface.ecology())) return { key, trees, budget: 0, room: null };
    // One plate's density swept a frame at most while the game is seen (each was some 35 ms)
    let sweptNew = false, pending = 0;
    const sweepFrom = performance.now();
    // THE TREE MAP, as Horizon Zero Dawn's Placement_Trees (Guerrilla, GDC 2017)
    const cells = Math.floor((TERRAIN_HALF * 2) / NATURE_SPACING);
    const plates: NaturePlate[] = [];
    let treeSum = 0;
    const d = WOODS_SLOPE_STEP;
    // What a plate's density reads besides its own ecology: its own land (`plateLand`) and the vegetation setting.
    const vegetation = quality.vegetation;
    for (const part of terrain.parts) {
      const field = part.surface.ecology();
      if (!field) continue;
      // Kept from the last sweep while its own ecology and the land are as they were
      const plateKey = `${part.surface.ecologyRevision}:${plateLand.get(part.surface) ?? 0}:${vegetation}`;
      const known = naturePlates.get(part.surface);
      if (known && known.key === plateKey) {
        plates.push(known);
        treeSum += known.sum;
        continue;
      }
      if (sweptNew && (reveal.opened || performance.now() - sweepFrom > HIDDEN_SLICE_MS)) { pending++; continue; }
      sweptNew = true;
      const odds = known?.odds ?? new Float32Array(cells * cells);
      const band = known?.band ?? new Uint8Array(cells * cells);
      let plateSum = 0;
      const di = Math.round(part.cx / NATURE_SPACING), dj = Math.round(part.cy / NATURE_SPACING);
      // The land's own slope, before the roads cut and fill it: a wood holds a hillside, not the bank of a street
      const natural = part.surface.naturalRenderedHeightAt;
      // Its density but the ecosystem's share, made off the page with the plate (`woodsBase.ts`): only that share added here.
      const base = part.surface.woodsBase?.() ?? null;
      for (let j = 0; j < cells; j++) {
        for (let i = 0; i < cells; i++) {
          const x = -TERRAIN_HALF + (i + 0.5) * NATURE_SPACING, y = -TERRAIN_HALF + (j + 0.5) * NATURE_SPACING;
          const ix = Math.round((x + TERRAIN_HALF) / TERRAIN_CELL), iy = Math.round((TERRAIN_HALF - y) / TERRAIN_CELL);
          const k = iy * field.side + ix;
          const ecology = Math.min(1, (field.canopy[k] ?? 0) * 0.9 + (field.trees[k] ?? 0) * 0.5 + (field.emergent[k] ?? 0) * 0.3);
          const o = j * cells + i;
          let density: number;
          if (base) density = base[o]! + ecology * 0.3;
          else {
            const wx = x + part.cx, wy = y + part.cy;

            const slope = Math.hypot(natural(x + d, y) - natural(x - d, y), natural(x, y + d) - natural(x, y - d)) / (2 * d);
            const hillside = Math.min(1, Math.max(0, (slope - 0.06) / 0.35));
            // The patches drawn out to clear masses: woods on the plains too, as capões, and clean meadows between them.
            density = natureDensity(wx, wy, m(1), hillside, ecology);
          }
          // The bands: inner forest, its edge, scattered trees, a rare lone one.
          if (density > 0.62) { odds[o] = 0.92; band[o] = 3; }
          else if (density > 0.5) { odds[o] = 0.25 + (density - 0.5) / 0.12 * 0.6; band[o] = 2; }
          else if (density > 0.38) { odds[o] = 0.025; band[o] = 1; }
          else { odds[o] = 0.003; band[o] = 1; }
          plateSum += odds[o]!;
        }
      }
      const plate: NaturePlate = { key: plateKey, part, odds, band, di, dj, sum: plateSum, picked: null, kept: null };
      naturePlates.set(part.surface, plate);
      plates.push(plate);
      treeSum += plateSum;
    }
    // As many plates' budgets as the plates in full cover, the woods as thick on each: the budget shared by area.
    const plateArea = (2 * TERRAIN_HALF) ** 2;
    const base = NATURE_TREES * Math.min(1, quality.vegetation / 2_600);
    const budget = base * Math.max(1, (plates.length * plateArea) / m(1_920) ** 2);
    const plannedSum = (treeSum / Math.max(1, plates.length)) * (m(1_920) ** 2 / plateArea);
    // In steps of 2 %: a plate brought in nudges the average
    const treeScale = Math.min(1, Math.exp(Math.round(Math.log(base / Math.max(1, plannedSum)) / 0.02) * 0.02));
    const slices: { plate: NaturePlate; start: number; count: number }[] = [];
    for (const plate of plates) {
      if (plate.picked && plate.picked.scale === treeScale) {
        slices.push({ plate, start: trees.length, count: plate.picked.trees.length });
        for (const t of plate.picked.trees) trees.push(t);
        continue;
      }
      const { part, odds, band, di, dj } = plate;
      const mine: Candidate[] = [];
      for (let j = 0; j < cells; j++) {
        for (let i = 0; i < cells; i++) {
          const o = j * cells + i;
          const gi = i + di, gj = j + dj;
          if (cellHash(gi, gj, 41) >= odds[o]! * treeScale) continue;
          const x = part.cx - TERRAIN_HALF + (i + 0.5 + (cellHash(gi, gj, 43) - 0.5) * 0.9) * NATURE_SPACING;
          const y = part.cy - TERRAIN_HALF + (j + 0.5 + (cellHash(gi, gj, 44) - 0.5) * 0.9) * NATURE_SPACING;
          // Tall in the heart of a wood, crowns meeting into one canopy; lower at its edge; short and crooked out in the open.
          const inner = band[o] === 3, edge = band[o] === 2;
          const h = inner ? m(11) + m(8) * cellHash(gi, gj, 45) : edge ? m(8) + m(6) * cellHash(gi, gj, 45) : m(5.5) + m(4) * cellHash(gi, gj, 45);
          const roll = cellHash(gi, gj, 46);
          const species = inner ? (roll < 0.6 ? 'broadleafTall' : 'broadleaf') : roll < 0.25 ? 'broadleafTall' : 'broadleaf';
          // Which of the low-poly trees (`natureTrees.ts`): oaks and cypresses most, a palm now and then out in the open.
          const pick = cellHash(gi, gj, 49);
          const kind = pick < 0.55 ? 'oak' : pick < (inner ? 0.97 : 0.85) ? 'cypress' : 'palm';
          mine.push({ x, y, size: h, yaw: cellHash(gi, gj, 47) * Math.PI * 2, seed: seedOfKind(kind, cellHash(gi, gj, 48)), species });
        }
      }
      plate.picked = { scale: treeScale, trees: mine };
      slices.push({ plate, start: trees.length, count: mine.length });
      for (const t of mine) trees.push(t);
    }
    return { key, trees, budget, room: null, pending, slices };
  };
  /** DO NOT make it at every keep - a keep runs at every road, building and terrain edit */
  let clearingsFor = -1;
  let clearingsDoc: RoadDoc | null = null;
  /** The clearings by place, filed one cut at a time (`clearingCells.ts`). */
  const clearingCells = new ClearingCells();
  const inClearing = (x: number, y: number): boolean => clearingCells.has(x, y);
  const clearingsOf = (doc: RoadDoc): ((x: number, y: number) => boolean) => {
    if (clearingsDoc !== doc || clearingsFor !== doc.clearingRevision) {
      clearingsDoc = doc;
      clearingsFor = doc.clearingRevision;
      clearingCells.follow(doc, doc.treeClearings);
    }
    return inClearing;
  };
  /** Water, a cliff, a road or a building: nothing of the ecosystem grows there. */
  const natureOpen = (net: Network, x: number, y: number, z: number): boolean => {
    // Off its plate's edge strip (the plate's centre worked out, no object a candidate).
    const cx = Math.floor(x / PLATE_SIZE + 0.5) * PLATE_SIZE, cy = Math.floor(y / PLATE_SIZE + 0.5) * PLATE_SIZE;
    if (Math.abs(x - cx) > PLATE_SIZE / 2 - m(2) || Math.abs(y - cy) > PLATE_SIZE / 2 - m(2)) return false;
    const level = terrain.shoreLevelAt(x, y);
    if (level !== null && level > z - m(0.3)) return false;
    const g = m(2);
    const grade = Math.hypot(terrain.renderedHeightAt(x + g, y) - terrain.renderedHeightAt(x - g, y), terrain.renderedHeightAt(x, y + g) - terrain.renderedHeightAt(x, y - g)) / (2 * g);
    if (grade > 0.75) return false;
    return !onCarriageway(net, { x, y }) && !buildings.covers(x, y);
  };
  /** How far round a place its test reads (the slope's samples, a margin): a change within it tests the place again. */
  const KEEP_REACH = m(4);
  /** A tree of the ecosystem stands on open ground, out of the clearings: its ground, or null. */
  const natureStands = (c: Candidate): number | null => {
    const net = keepNet!;
    const at = terrain.renderedHeightAt(c.x, c.y);
    return natureOpen(net, c.x, c.y, at) && !clearingsOf(net.doc)(c.x, c.y) ? at : null;
  };
  /** Which of the ecosystem's swept trees stand, cell by cell (`cellKeeps.ts`), and the trees each plate's cells were filled from. */
  const natureKeeps = new CellKeeps<Candidate>(natureStands);
  const natureFiled = new Map<object, { readonly trees: readonly Candidate[]; readonly cells: readonly number[] }>();
  /** DO NOT test and draw every tree of the ecosystem again for one plate swept again: the cells of the plates whose trees changed */
  const fileNature = (sweep: NatureSweep): void => {
    const swept = new Set<object>();
    for (const { plate } of sweep.slices ?? []) {
      const surface = plate.part.surface;
      swept.add(surface);
      const trees = plate.picked?.trees ?? [];
      const was = natureFiled.get(surface);
      if (was?.trees === trees) continue;
      const byCell = new Map<number, Candidate[]>();
      for (const t of trees) {
        const key = keepCellAt(t.x, t.y);
        const list = byCell.get(key);
        if (list) list.push(t); else byCell.set(key, [t]);
      }
      for (const key of was?.cells ?? []) if (!byCell.has(key)) natureKeeps.fill(key, []);
      // A cell whose trees came out the same keeps them standing as they are: neither tested nor drawn again.
      for (const [key, list] of byCell) natureKeeps.fill(key, list, sameCandidate);
      natureFiled.set(surface, { trees, cells: [...byCell.keys()] });
    }
    // The plates no longer swept (no ecosystem, or no vegetation): their cells let go.
    for (const [surface, was] of natureFiled) {
      if (swept.has(surface)) continue;
      for (const key of was.cells) natureKeeps.fill(key, []);
      natureFiled.delete(surface);
    }
  };
  /** A cover's place: never on a road or under a building. */
  const coverFree = (x: number, y: number): boolean => !onCarriageway(keepNet!, { x, y }) && !buildings.covers(x, y);
  const coverPlain = (c: Candidate): number | null => (coverFree(c.x, c.y) ? terrain.renderedHeightAt(c.x, c.y) : null);
  /** Which of the painted covers' and the rivers' places stand, kind by kind and cell by cell (`cellKeeps.ts`). */
  const coverKeeps = {
    // The woods out of the clearings.
    forest: new CellKeeps<Candidate>((c) => (coverFree(c.x, c.y) && !clearingsOf(keepNet!.doc)(c.x, c.y) ? terrain.renderedHeightAt(c.x, c.y) : null)),
    scrub: new CellKeeps<Candidate>(coverPlain),
    rocks: new CellKeeps<Candidate>(coverPlain),
    // A river's stone by its height over the water: thickest at the waterline, thinning up the bank and into the deep.
    shore: new CellKeeps<ShoreCandidate>((c) => {
      const ground = terrain.renderedHeightAt(c.x, c.y);
      const above = ground - c.level;
      const odds = above < -m(2.5) ? 0.06 : above < -m(0.3) ? 0.3 : above < m(0.6) ? 0.45 : above < m(2) ? 0.22 : above < m(4) ? 0.07 : 0;
      return c.draw <= odds && coverFree(c.x, c.y) ? ground : null;
    }),
  };
  /** The four kinds as the draw walks them: refreshed, and their changed cells taken, alike. */
  const coverKinds: readonly Pick<CellKeeps<Candidate>, 'refresh' | 'refreshAll' | 'takeChangedCells'>[] = [coverKeeps.forest, coverKeeps.scrub, coverKeeps.rocks, coverKeeps.shore];
  /** @rebuild Every cell of every kind: only when every cell is drawn again. */
  const allCoverCells = (): Set<number> => new Set([...coverKeeps.forest.cellKeys(), ...coverKeeps.scrub.cellKeys(), ...coverKeeps.rocks.cellKeys(), ...coverKeeps.shore.cellKeys()]);
  /** Which of the trees the player planted stand: off the roads, out of the buildings. */
  const plantedKeeps = new CellKeeps<PlantedTree>((t) => (onCarriageway(keepNet!, t) || buildings.covers(t.x, t.y) ? null : terrain.renderedHeightAt(t.x, t.y)));
  /** The planted trees standing in a keep cell, from the document's filing by place (`RoadDoc.treesIn`). */
  const plantedIn = (doc: RoadDoc, key: number): PlantedTree[] => doc.treesIn(keepCellRect(key)).filter((t) => keepCellAt(t.x, t.y) === key);
  /** @rebuild Every planted tree filed cell by cell: the map opened, or its trees replaced whole. */
  const plantAll = (doc: RoadDoc): void => {
    plantedKeeps.clear();
    const byCell = new Map<number, PlantedTree[]>();
    for (const t of doc.trees) {
      const key = keepCellAt(t.x, t.y);
      const list = byCell.get(key);
      if (list) list.push(t); else byCell.set(key, [t]);
    }
    for (const [key, list] of byCell) plantedKeeps.fill(key, list);
  };
  /** What the cover sweeps read of the ground (`coverSweep.ts`). */
  const coverField: CoverField = {
    forestAt: (x, y) => terrain.forestAt(x, y),
    coverAt: (kind, x, y) => terrain.coverAt(kind, x, y),
    shoreLevelAt: (x, y) => terrain.shoreLevelAt(x, y),
  };
  /** The painted covers of keep cells swept again, each cell's places kept as they stand where the sweep finds the same. */
  const resweepCovers = (cells: Iterable<number>): void => {
    for (const key of cells) {
      coverKeeps.forest.fill(key, forestIn(key, coverField), sameCandidate);
      coverKeeps.scrub.fill(key, scrubIn(key, coverField), sameCandidate);
      coverKeeps.rocks.fill(key, rocksIn(key, coverField), sameCandidate);
    }
  };
  /** @rebuild The painted covers swept over every cover dab of the map (opened, replaced, or a change the diary cannot place). */
  const sweepAllCovers = (doc: RoadDoc): void => {
    for (const keep of [coverKeeps.forest, coverKeeps.scrub, coverKeeps.rocks]) keep.clear();
    const cells = new Set<number>();
    for (const dab of doc.terrainPaint) {
      if (isCoverKind(dab.kind)) keepCellsOver([dab.x - dab.radius, dab.y - dab.radius, dab.x + dab.radius, dab.y + dab.radius], COVER_SWEEP_PAD, cells);
    }
    resweepCovers(cells);
  };
  /** The rivers' stones swept again over the water's box as it was and as it is (`terrain.waterRevision`) */
  const resweepShore = (): void => {
    const water = terrain.waterArea();
    const cells = new Set<number>();
    for (const box of [coverWaterBox, water]) {
      if (box) keepCellsOver([box.minX, box.minY, box.maxX, box.maxY], SHORE_SWEEP_PAD, cells);
    }
    for (const key of cells) coverKeeps.shore.fill(key, shoreIn(key, coverField, water), sameShore);
    coverWaterBox = water;
  };
  const handle: SceneHandle = {
    // Asked for by the Actions (a shot, a bomb) and the weapons lab: the effects, and now the physics the bodies fall with
    effects: () => loadEffects().then(() => import('./ragdoll')).then((mod) => mod.warmPhysics()),
    flashGrid(cells) {
      if (!cells.length) return;
      const pos: number[] = [], ring: number[] = [];
      const lift = m(0.3), sub = 4, d = GRID_CELL / sub;
      for (const c of cells) {
        // Each cell in 4 x 4 pieces on the ground, so it bends with it.
        for (let i = 0; i < sub; i++) for (let j = 0; j < sub; j++) {
          const x0 = c.x + i * d, y0 = c.y + j * d, x1 = x0 + d, y1 = y0 + d;
          const v = (x: number, y: number): void => { pos.push(x, terrain.renderedHeightAt(x, y) + lift, -y); ring.push(c.ring); };
          v(x0, y0); v(x1, y0); v(x1, y1); v(x0, y0); v(x1, y1); v(x0, y1);
        }
      }
      addBlink(pos, ring);
    },
    flashRoads(ids) {
      // Built in the next frame, once the new roads' heights are solved (`draw`).
      pendingRoadFlash.push(...ids);
      onAssetsReady();
    },
    setGrid(on) {
      // Drawn by the ground's own material (`TERRAIN_GRID`): always on it, over any ground, in world units.
      TERRAIN_GRID.value = [GRID_CELL, on ? 0.08 : 0];
      if (on !== gridWanted) { gridWanted = on; onAssetsReady(); }
    },
    shootBody: (a, b) => fx?.shootBody(a, b) ?? null,
    isDown: (id) => fx?.hides(id) ?? false,
    setEffectsSpeed(speed) { fx?.setEffectsSpeed(speed); },
    stepEffects(seconds) { fx?.stepEffects(seconds); },
    ragdollProbe: () => fx?.ragdollProbe() ?? [],
    clearCasualties() { fx?.clearCasualties(); },
    meshProbe: () => agents.meshProbe(),
    animProbe: (id) => agents.animProbe(id),
    forceClip: (id, clip) => agents.forceClip(id, clip as never),
    driverBody: (vehicle, x, y) => agents.driverBody(vehicle, x, y),
    vehicleHit(x, y, z, dirX, dirY, glass, blood) { fx?.vehicleHit(x, y, z, dirX, dirY, glass, blood); },
    dropVehicle(v) { fx?.dropVehicle(v); },
    wound(x, y, z, dirX, dirY, severed) { fx?.wound(x, y, z, dirX, dirY, severed); },
    shot(from, to) { fx?.shot(from, to); },
    inspect,
    census: () => agents.census(),
    backend: 'three-webgl',
    viewport: rig.viewport,
    scene,
    gl: renderer,
    gpu: gpuTimer,
    get stats(): RenderStats {
      return {
        triangles: builtTriangles + buildings.triangles,
        drawCalls: renderer.info.render.calls,
        quality: governor.current,
        fps: Math.round(fps),
        rebuildMs: Math.round(rebuildMs),
        roadTiles: roads ? { built: roads.built, reused: roads.reused } : { built: 0, reused: 0 },
        rebuilds,
        terrainMs: Math.round(terrainMs),
      };
    },
    terrainHeightAt(x, y) {
      return terrain.renderedHeightAt(x, y);
    },
    landTop() {
      if (landTopFor !== landVersion) {
        landTopFor = landVersion;
        // Kept by the atlas as its plates' ground moves
        let top = terrain.highest?.() ?? -Infinity;
        const corners = Math.round((TERRAIN_HALF * 2) / TERRAIN_CELL);
        if (!terrain.highest) for (const part of terrain.parts) {
          for (let j = 0; j <= corners; j++) {
            for (let i = 0; i <= corners; i++) top = Math.max(top, part.surface.renderedHeightAt(-TERRAIN_HALF + i * TERRAIN_CELL, TERRAIN_HALF - j * TERRAIN_CELL));
          }
        }
        landTopValue = top;
      }
      return landTopValue;
    },
    builtGroundAt(x, y) {
      return builtGroundAt(x, y);
    },
    get worldBusy() {
      return worldJob !== null;
    },
    get opening() {
      return !reveal.opened;
    },
    get programsReady() {
      return programs.ready;
    },
    holdOpening(until) {
      openingHeld = until;
    },
    get farBuildings() {
      return buildings.far;
    },
    get farRoads() {
      return farRoads;
    },
    beginLoad() {
      reveal.begin();
      programs.begin();
      openingSince = null;
      onAssetsReady();
    },
    offerElevation(solved, revision) {
      offeredElevation = { elevation: solved, revision, terrain: terrainRevision };
    },
    roadsSolve() {
      return elevation ? { elevation, terrainRevision } : null;
    },
    surfaceHeightAt(x, y) {
      const ground = terrain.renderedHeightAt(x, y);
      if (!elevation) return ground;
      let top = ground;
      // The road at grade and the decks are asked apart
      for (const set of SURFACE_SETS) {
        if (!elevation.has(set)) continue;
        const road = elevation.roadAt(x, y, set);
        if (road.type < 0 || Math.abs(road.across) > road.half) continue;
        top = Math.max(top, elevation.at(x, y, set));
      }
      return top;
    },
    pavedHeightAt,
    setBuildingPreview(preview) {
      buildings.setPreview(preview);
    },
    strikeBuilding: (b, x, y, z, strength) => fx?.strikeBuilding(b, x, y, z, strength) ?? false,
    strikeGround(x, y, strength) {
      for (let k = 0; k < 6 + strength * 2; k++) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * m(0.6 + strength * 0.25);
        wear.wheels(x + Math.cos(a) * r, y + Math.sin(a) * r, a, 0.01, 30);
      }
      wear.tick(10);
      exhaust.burst(x, y, terrain.renderedHeightAt(x, y), 20 + strength * 6, 1, m(1 + strength * 0.4), m(3), 5);
    },
    explode(x, y, z, radius, hit) { fx?.explode(x, y, z, radius, hit); },
    burn: (x, y, z, size, seconds) => fx?.burn(x, y, z, size, seconds),
    soot: (x, y, z, r) => fx?.soot(x, y, z, r),
    geyser: (x, y, z, seconds) => fx?.geyser(x, y, z, seconds),
    sparkAt: (x, y, z, seconds) => fx?.sparkAt(x, y, z, seconds),
    leak: (x, y, z, seconds) => fx?.leak(x, y, z, seconds),
    onBuildingDown: (listener) => { buildingDownListeners.push(listener); },
    flingOccupants: (list) => { fx?.flingOccupants(list); },
    setSmog: (k) => environment.setSmog(k),
    strikeAt: (x, y) => strikeAt(x, y),
    onStrike(listener) { strikeListeners.push(listener); },
    cloudDrift: () => cloudDrift,
    busy: () => (fx?.busy() ?? false) || natureTreesPending || cameraEasing,
    targetBytes: () => renderTargetsBytes([...post.targets(), ...environment.shadowMaps()]),
    buildingDetailBytes: () => buildings.residentBytes,
    drifting: () => ((fogMoving || placedCloudsShown) && post.enabled && (quality.cloudShadows || quality.skyClouds)) || weatherActive,
    forgetRuin(id) { fx?.forgetRuin(id); },
    setTransitXray(on) {
      transitXray = on;
      transit.setXray(on);
    },
    setTransitPreview(preview) {
      const key = preview ? `${preview.mode}:${preview.points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(';')}` : '';
      if (key === transitPreviewKey) return;
      transitPreviewKey = key;
      // ONE preview for the tool's life, written again as the track changes (`createTrackPreview`).
      if (!transitPreview) {
        transitPreview = createTrackPreview();
        world.add(transitPreview.group);
      }
      transitPreview.set(preview?.points ?? [], preview?.mode ?? 'train', terrain.renderedHeightAt, pavedHeightAt);
    },
    setLotOverlay(input, changes) {
      lotOverlay ??= createLotOverlay((x, y) => handle.surfaceHeightAt(x, y));
      lotOverlay.set(input, changes);
    },
    setPolePreview(net, preview) {
      const key = preview && elevation
        ? `${net.revision}:${preview.poles.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)},${+p.lamp},${+p.standing}`).join(';')}`
        : '';
      if (key === polePreviewKey) return;
      polePreviewKey = key;
      if (polePreview) {
        world.remove(polePreview.group);
        polePreview.dispose();
        polePreview = null;
      }
      if (!preview || !elevation || preview.poles.length === 0) return;
      polePreview = buildPolePreview(net, poleGroundAt(elevation, terrain.renderedHeightAt, net), sceneryKit, preview);
      world.add(polePreview.group);
    },
    setPerspective(on) {
      if (on === rig.perspective) return;
      rig.setPerspective(on);
      // The passes hold the camera they were made with.
      post.dispose();
      post = createPostChain(renderer, scene, rig.camera, quality, governor.current);
      post.setNight(Math.max(0, lastDark));
      resize();
      onAssetsReady();
    },
    setSkyMode(mode) {
      // Read by the next frame drawn.
      skyMode = mode;
    },
    setAtmosphere(next) {
      atmosphere = next;
    },
    setBuildingCutaway(spec) {
      buildings.setCutaway(spec);
      cutSpec = spec;
    },
    setBuildingsDimmed(except) {
      buildings.setDimmed(except === undefined ? undefined : (except as BuildingId | null));
    },
    elevationAt(x, y, structure) {
      if (!elevation) return terrain.renderedHeightAt(x, y);
      return elevation.at(x, y, structure ? new Set([structure]) : undefined);
    },
    resize,
    // Wall-clock time between drawn frames, for things that age as they are watched.
    draw(net, sim, alpha, delta, options) {
      renderer.info.reset();
      groundDiary = net.doc.changes;
      // Planted trees and shrubs grow with the city's clock: resized once a city hour.
      cityMinutes = sim.minutes;
      const wallNow = performance.now();
      const wallDt = lastWall < 0 ? 0 : Math.min(0.1, (wallNow - lastWall) / 1000);
      // The bodies, guts and debris on their own clock
      const fxDt = fx ? fx.clock(wallDt) : 0;
      lastWall = wallNow;
      cameraEasing = rig.settle(wallDt);
      if (canvas.clientWidth !== lastWidth || canvas.clientHeight !== lastHeight) {
        lastWidth = canvas.clientWidth;
        lastHeight = canvas.clientHeight;
        resize();
      }
      const terrainStarted = performance.now();
      const stroking = !!options?.holdRoads && !!elevation && networkRevision === net.revision;
      const groundMoved = terrain.update(net.doc, stroking);
      if (groundMoved) {
        landVersion++;
        // The stroke's dirty region, dab by dab (`landDirty`).
        const moved = terrain.lastRegion;
        landDirty = moved === null || landDirty === 'all' ? 'all' : unionRect(landDirty, regionRect(moved));
      }
      terrain.updatePaint(net.doc);
      // A brush stroke in progress: every dab used to re-solve the whole road network and re-mesh every road
      if (stroking) {
        if (groundMoved) {
          shapeGround(net, terrain.lastRegion);
          terrainMs = performance.now() - terrainStarted;
        }
      } else {
        const atRebuild = performance.now();
        rebuildWorld(net);
        performance.measure('hitch:draw/Rebuild', { start: atRebuild, end: performance.now() });
        terrain.settle();
      }
      const atPump = performance.now();
      pumpWorld();
      performance.measure('hitch:draw/Pump', { start: atPump, end: performance.now() });
      // A building placed, moved or reshaped grades its own site.
      landShapes();
      followFloors(net);
      if (!(worldJob && worldJobGround) && gradedFor !== net.doc.buildings.revision) {
        gradedFor = net.doc.buildings.revision;
        const changed = sitesGraded.changedSites(net.doc.buildings);
        if (changed) shapeGround(net, changed.map(terrainRegion), true);
      }
      // What stands on the ground - the buildings, the walls, the transport, the gardens
      const groundSettled = !stroking && !worldJob;
      // The street furniture, the signs, the barriers and the transport on the world as it stands (the engine's 'draw' products)
      if (groundSettled) { placedOn = net; engine.refresh('draw'); }
      // The buildings follow the ground once a stroke is over, not on every dab of it
      if (groundSettled && groundChanges.version !== buildingGroundSeen) {
        const moved = buildingGroundSeen < 0 ? null : buildingsOnGroundSince(net.doc, buildingGroundSeen);
        if (moved === null || moved.length > 0) buildingGround = String(groundChanges.version);
        buildingGroundSeen = groundChanges.version;
      }
      // At the opening the buildings come once the first world (the roads, the ground cut and filled to them) is in
      if (roads !== null && (reveal.opened || !worldJob)) {
        buildings.hidden = !reveal.opened;
        // Buildings put together or streamed in (HLOD, `layer.ts`) are new casters: the shadow map is drawn again.
        if (buildings.update(net.doc, terrain.renderedHeightAt, buildingGround, pavedHeightAt, builtGroundAt,
          (b, since) => groundChanges.touches(Number(since), bankBox(b)),
          (since) => (since === '' ? null : buildingsOnGroundSince(net.doc, Number(since))))) shadowMoved = true;
        if (buildings.pending) onAssetsReady();
      }
      // The countryside's trees are grown once the first world is in, not while the opening builds it (`loadNatureTrees`).
      if (!natureTreesStarted && roads !== null && !worldJob) startNatureTrees();
      // The Actions' effects (`playEffects.ts`) made in idle time once the world stands, not on the first shot
      if (!fxPreload && !fxLoading && roads !== null && !worldJob && typeof requestIdleCallback === 'function') {
        fxPreload = true;
        requestIdleCallback(() => { void loadEffects(); }, { timeout: 5000 });
      }
      // Each building's plants (`gardenLists.ts`), placed again only when some changed.
      const plants = plantLists.update(net.doc.buildings, groundSettled);
      if (plants) {
        // Kept building by building (`gardens.ts`): a list the same as before keeps its plants' slots.
        gardens ??= createGardens(sceneryKit);
        const swapped = gardens.update(plants);
        for (const mesh of swapped.removed) world.remove(mesh);
        for (const mesh of swapped.added) world.add(mesh);
      }
      // THE PLANTS AND STONES (`coverSweep.ts`/`coverKeeps`, `natureSweep`/`natureKeeps`, the planted trees)
      if (!stroking && !worldJob) {
        keepNet = net;
        // What the tests read that changed since the last look, and where (null: the diary cannot say).
        const entries = vegetationRead.read(net.doc.changes);
        let rects: ChangeRect[] | null = entries === null ? null : [];
        for (const entry of entries ?? []) {
          if (entry.rects === null) { rects = null; break; }
          rects!.push(...entry.rects);
        }
        // The stones, the scrub and the painted woods: swept again only in the cells the paint reached (`coverSweep.ts`).
        {
          const at = performance.now();
          const paint = coverPaintRead.read(net.doc.changes);
          if (paint === null || paint.some((e) => e.rects === null)) sweepAllCovers(net.doc);
          else if (paint.length) {
            const cells = new Set<number>();
            for (const e of paint) for (const r of e.rects!) keepCellsOver(r, COVER_SWEEP_PAD, cells);
            resweepCovers(cells);
          }
          if (coverWaterSeen !== terrain.waterRevision) {
            coverWaterSeen = terrain.waterRevision;
            resweepShore();
          }
          performance.measure('hitch:cover/sweep', { start: at, end: performance.now() });
        }
        // The painted woods' trees are the countryside's (`natureTrees.ts`); the old card trees only if those cannot be grown.
        const standIns = !natureTreeKit && !natureTreesPending;
        let coverWhole = vegetationRedraw || coverStandIns !== standIns;
        // The cells whose places changed, of every kind (the painted woods' are read by the cover's card trees and by the forest).
        const changed = new Set<number>();
        // The stones take the colour of the painted rock under them: drawn again where the geology changed.
        const geology = terrain.geologyChanges.version;
        if (geology !== coverGeologySeen) {
          const painted = coverGeologySeen < 0 ? null : terrain.geologyChanges.rectsSince(coverGeologySeen);
          if (painted === null) coverWhole = true;
          else for (const r of painted) keepCellsOver(r, TERRAIN_CELL, changed);
          coverGeologySeen = geology;
        }
        {
          const at = performance.now();
          if (rects === null) for (const keep of coverKinds) keep.refreshAll();
          else if (rects.length) for (const keep of coverKinds) keep.refresh(rects, KEEP_REACH);
          for (const keep of coverKinds) {
            const cells = keep.takeChangedCells();
            if (cells === null) coverWhole = true; else for (const cell of cells) changed.add(cell);
          }
          if (coverWhole || changed.size) {
            coverCells ??= (() => {
              const made = createCoverCells(coverKit, 'ground-cover', {
                rocksIn: (cell) => [...coverKeeps.rocks.standingIn(cell), ...coverKeeps.shore.standingIn(cell)]
                  .map(({ c, z }) => ({ x: c.x, y: c.y, z, size: c.size, yaw: c.yaw, seed: c.seed, rock: terrain.geologyAt(c.x, c.y) })),
                scrubIn: (cell) => coverKeeps.scrub.standingIn(cell).map(({ c, z }) => ({ x: c.x, y: c.y, z, size: c.size, yaw: c.yaw, seed: c.seed })),
                treesIn: (cell) => (!natureTreeKit && !natureTreesPending ? coverKeeps.forest.standingIn(cell).map(({ c, z }) => ({ ...c, z })) : []),
              });
              world.add(made.group);
              return made;
            })();
            // DO NOT gather every cell of the map unless every cell is drawn again.
            coverCells.sync(coverWhole ? null : changed, coverWhole ? allCoverCells() : []);
            if (natureTreeKit) {
              paintedForest ??= (() => {
                const made = createTreeCells(natureTreeKit, 'painted-forest', (cell) => coverKeeps.forest.standingIn(cell).map(({ c, z }) => ({ ...c, z })));
                world.add(made.group);
                return made;
              })();
              paintedForest.sync(coverWhole ? null : changed, coverWhole ? coverKeeps.forest.cellKeys() : []);
            }
          }
          coverStandIns = standIns;
          performance.measure('hitch:cover', { start: at, end: performance.now() });
        }
        // The ecosystem's own trees.
        bringPlateLand(net.doc);
        const natureSweepKey = `${terrain.ecologyRevision}:${landSerial}:${quality.vegetation}`;
        if (natureSweepWant !== natureSweepKey || natureSweepPending) {
          const at = performance.now();
          natureSweepWant = natureSweepKey;
          const swept = natureSweep(natureSweepKey);
          natureSweepPending = (swept.pending ?? 0) > 0;
          // While plates wait their sweep (one a frame), the trees standing stay
          if (!natureSweepPending || !natureSweepState) natureSweepState = swept;
          performance.measure('hitch:nature/sweep', { start: at, end: performance.now() });
        }
        if (natureSweepState) {
          const sweep = natureSweepState;
          const at = performance.now();
          // A new sweep fills again the cells of the plates swept again only (`fileNature`).
          if (natureFiledFrom !== sweep) {
            natureFiledFrom = sweep;
            fileNature(sweep);
          }
          if (rects === null) natureKeeps.refreshAll();
          else if (rects.length) natureKeeps.refresh(rects, KEEP_REACH);
          const cells = natureKeeps.takeChangedCells();
          const whole = cells === null || vegetationRedraw;
          if (whole || cells!.size) {
            const changed = whole ? null : cells;
            if (natureTreeKit) {
              natureForest ??= (() => {
                const made = createTreeCells(natureTreeKit, 'nature-forest', (cell) => natureKeeps.standingIn(cell).map(({ c, z }) => ({ ...c, z })));
                world.add(made.group);
                return made;
              })();
              natureForest.sync(changed, whole ? natureKeeps.cellKeys() : []);
              // Grown (or nothing to grow): no longer drawing while waiting for them.
              natureTreesPending = false;
            }
            // The old card trees only if the new ones could not be grown
            natureCards ??= (() => {
              const made = createCoverCells(coverKit, 'nature-cards', {
                rocksIn: () => [], scrubIn: () => [],
                treesIn: (cell) => (!natureTreeKit && !natureTreesPending ? natureKeeps.standingIn(cell).map(({ c, z }) => ({ ...c, z })) : []),
              });
              world.add(made.group);
              return made;
            })();
            natureCards.sync(changed, whole ? natureKeeps.cellKeys() : []);
          }
          performance.measure('hitch:nature', { start: at, end: performance.now() });
        }
        // The trees the player planted (`world/trees.ts`), with the woods' own models: filed again only in the cells planted or cut
        if (natureTreeKit) {
          const planted = plantedRead.read(net.doc.changes);
          if (planted === null || planted.some((e) => e.rects === null)) plantAll(net.doc);
          else if (planted.length) {
            const cells = new Set<number>();
            for (const e of planted) for (const r of e.rects!) keepCellsOver(r, 0, cells);
            for (const key of cells) plantedKeeps.fill(key, plantedIn(net.doc, key), (a, b) => a === b);
          }
          if (rects === null) plantedKeeps.refreshAll();
          else if (rects.length) plantedKeeps.refresh(rects, KEEP_REACH);
          const cells = plantedKeeps.takeChangedCells();
          if (cells === null || cells.size || vegetationRedraw) {
            plantedForest ??= (() => {
              const made = createTreeCells(natureTreeKit, 'planted-forest', (cell) => plantedKeeps.standingIn(cell)
                .map(({ c, z }) => ({ x: c.x, y: c.y, z, size: c.height, yaw: c.yaw, seed: c.seed, species: 'broadleaf' as const })));
              world.add(made.group);
              return made;
            })();
            const whole = cells === null || vegetationRedraw;
            plantedForest.sync(whole ? null : cells, whole ? plantedKeeps.cellKeys() : []);
          }
        }
        vegetationRedraw = false;
      }
      // The perspective camera kept out of the buildings (`IsoRig.setSolids`)
      followFloors(net);
      if (cameraSolidsKept.follow(net.doc.buildings, floorGroundSince)) {
        rig.setSolids((x, y) => cameraSolidsKept.solids().floorAt(x, y), (x, y) => cameraSolidsKept.solids().roofAt(x, y));
        townSolids = () => cameraSolidsKept.solids();
      }
      // The light the buildings shut out of the streets round the view (`canyonLight.ts`).
      post.followTown(rig.target.x, -rig.target.z, townSolids, canyonChanges(net.doc.changes));
      const detailed = rig.viewport.zoom >= quality.detailCutoffZoom;
      const plantMap = rig.viewport.zoom < PLANT_MAP_ZOOM;
      // The buildings' detail and parts by the error on the screen (`levelOfDetail`, `cullDetails`).
      {
        const eye = rig.camera.position;
        let k = 1;
        if (!rig.perspective) {
          const halfH = canvas.clientHeight / Math.max(1e-3, 2 * rig.viewport.zoom);
          k = halfH / Math.tan((PERSPECTIVE_FOV * Math.PI) / 360) / Math.max(1e-3, eye.distanceTo(rig.target));
        }
        const t = rig.target;
        const ex = t.x + (eye.x - t.x) * k, ey = -(t.z + (eye.z - t.z) * k), ez = t.y + (eye.y - t.y) * k;
        // The far level of the buildings by the error on the screen, in CSS pixels
        const pxAtMetre = canvas.clientHeight / (2 * Math.tan(((rig.perspective ? (rig.camera as PerspectiveCamera).fov : PERSPECTIVE_FOV) * Math.PI) / 360));
        // In the view from above a metre spans the same pixels wherever it stands; in perspective nothing past the far plane is seen
        let reach = rig.perspective ? (rig.camera as PerspectiveCamera).far : Infinity;
        if (!rig.perspective) {
          const halfH = canvas.clientHeight / Math.max(1e-3, 2 * rig.viewport.zoom);
          const halfW = (halfH * canvas.clientWidth) / Math.max(1, canvas.clientHeight);
          reach = Math.hypot(halfW, halfH / Math.max(0.3, Math.sin(rig.viewport.elevation))) * 1.25 + m(120);
        }
        rig.camera.updateMatrixWorld();
        detailProjection.multiplyMatrices(rig.camera.projectionMatrix, rig.camera.matrixWorldInverse);
        detailFrustum.setFromProjectionMatrix(detailProjection, rig.camera.coordinateSystem, rig.camera.reversedDepth);
        // The sun's cascades are made by three at their first draw: counted as they stand before the detail is chosen.
        gpuLedger.set('shadow maps', 'shadow maps', renderTargetsBytes(environment.shadowMaps()));
        buildings.levelOfDetail(ex, ey, ez, pxAtMetre, rig.perspective ? null : rig.viewport.zoom, reach, detailFrustum);
        farRoads.choose(ex, ey, ez, pxAtMetre, rig.perspective ? null : rig.viewport.zoom, reach);
        // A shadow texel's side, m: a part's shadow narrower than it is not cast.
        const shadow = environment.sun.shadow;
        const texel = environment.sun.castShadow ? (shadow.camera.right - shadow.camera.left) / shadow.camera.zoom / shadow.mapSize.x : Infinity;
        buildings.cullDetails(ex, ey, ez, pxAtMetre, rig.perspective ? null : rig.viewport.zoom, texel);
      }
      if (roads) roads.group.visible = true;
      if (details) details.group.visible = true;
      watchRoads(net);
      // DO NOT test `-leaves`: no mesh is named so, and the cards were drawn at every zoom.
      for (const mesh of furniture.meshes) {
        mesh.visible = quality.detailProps && detailed && (!plantMap || !isLeafCards(mesh));
      }
      for (const mesh of gardens?.meshes ?? []) {
        mesh.visible = detailed && (!plantMap || !isLeafCards(mesh));
      }
      gardens?.setNear(rig.viewport.zoom >= PLANT_NEAR_ZOOM);
      // After `visible` is set (the contract of `Scenery.setMap`), and only when the map zoom is crossed or the layer is new
      if (plantMap !== plantMapFor.map || gardens !== plantMapFor.gardens) {
        plantMapFor = { map: plantMap, gardens };
        gardens?.setMap(plantMap);
        furniture.setMap(plantMap);
      }
      // The roads just laid: a strip over their whole width, on their own deck.
      if (pendingRoadFlash.length && elevation) {
        const pos: number[] = [], ring: number[] = [];
        for (const id of pendingRoadFlash.splice(0)) {
          const ribbon = net.ribbons.get(id);
          if (!ribbon) continue;
          const line = ribbon.full, half = sidewalkHalf(ribbon.road);
          const at = (s: number, side: number): [number, number, number] => {
            const f = line.sampleAt(Math.min(s, line.length));
            const x = f.p.x + f.n.x * half * side, y = f.p.y + f.n.y * half * side;
            return [x, elevation!.onSegment(id, f.p.x, f.p.y) + m(0.3), -y];
          };
          // The road itself only: cut where its ends meet a junction (its trims), not running into the road it joins.
          const trims = net.trims.get(id);
          const from = trims ? Math.max(0, ...Object.values(trims.a)) : 0;
          const to = line.length - (trims ? Math.max(0, ...Object.values(trims.b)) : 0);
          const step = m(1.5);
          for (let s = from; s < to; s += step) {
            const e = Math.min(to, s + step);
            const l0 = at(s, 1), r0 = at(s, -1), l1 = at(e, 1), r1 = at(e, -1);
            pos.push(...l0, ...r0, ...r1, ...l0, ...r1, ...l1);
            for (let k = 0; k < 6; k++) ring.push(0);
          }
        }
        if (pos.length) addBlink(pos, ring);
      }
      for (let i = gridFlashes.length - 1; i >= 0; i--) {
        const f = gridFlashes[i]!;
        const t = (performance.now() - f.start) / 1000;
        f.time = t;
        if (t > f.end) { scene.remove(f.mesh); f.mesh.geometry.dispose(); gridFlashes.splice(i, 1); }
        else onAssetsReady();
      }
      // The map stands on a plain dark blue
      {
        // Found once: looked up by name it walked the whole scene every frame.
        skyMesh ??= scene.getObjectByName('sky') ?? null;
        if (skyMesh) skyMesh.visible = false;
        scene.background = MAP_BACKGROUND;
      }
      // The wind blows in real time: a paused simulation is still a windy day.
      windClock += Math.min(0.1, Math.max(0, delta));
      advanceWind(windClock);

      const cullCamera = rig.camera;
      crowdProjection.multiplyMatrices(cullCamera.projectionMatrix, cullCamera.matrixWorldInverse);
      crowdFrustum.setFromProjectionMatrix(crowdProjection, cullCamera.coordinateSystem, cullCamera.reversedDepth);
      cameraRight.setFromMatrixColumn(cullCamera.matrixWorld, 0).normalize();
      // The canvas's CSS size read once a frame, before the vehicles ask `screenScale`
      cssHalfW = renderer.domElement.clientWidth * 0.5;
      cssHalfH = renderer.domElement.clientHeight * 0.5;
      // Plants and street furniture outside the view are not drawn at all.
      furniture.cull(crowdFrustum, crowdProjection);
      signs.cull(crowdFrustum, crowdProjection);
      barriers.cull(crowdFrustum, crowdProjection);
      transit.cull(crowdFrustum, crowdProjection);
      for (const plants of [coverCells, natureCards, natureForest, paintedForest, plantedForest]) plants?.cull(crowdFrustum, crowdProjection);
      elementLayer?.cull(crowdFrustum, crowdProjection);
      gardens?.cull(crowdFrustum, crowdProjection);
      transit.update(sim.trains, terrain.renderedHeightAt);
      frustumGroundBox(crowdFrustum, VEHICLE_REACH, VEHICLE_LOW, VEHICLE_HIGH, vehicleBox);
      agents.sync(sim, net, alpha, detailed, rig.viewport.zoom, {
        pedestrianDetail: quality.pedestrianDetail,
        pedestrianVisible,
        personPixels,
        screenScale,
        pixelRatio: renderer.getPixelRatio(),
        shadows: renderer.shadowMap.enabled,
        eye: cullCamera.position,
        vehicleVisible,
        vehicleBox,
        occupantZoom: quality.occupantZoom,
        exhaust: (x, y, z, angle, length, speed, dusty) => {
          exhaust.emit(x, y, z, angle, length, speed, dusty);
          if (!dusty && Math.abs(speed) > 0.5) wear.wheels(x, y, angle, Math.min(length * 0.42, m(1.7)), wallDt);
        },
        // The bodies of shots and blows (`playEffects.ts`), once anybody has shot or struck.
        ...(fx ? { ragdolls: (citizens: Parameters<PlayEffects['frame']>[0]) => fx!.frame(citizens, sim, wallDt, fxDt) } : {}),
        hiddenPed: (id) => fx?.hides(id) ?? false,
      });
      // The micro window follows the view's centre; the far cars of the meso step drawn round it.
      densityCars.update(net, sim, rig.target.x, -rig.target.z);
      exhaust.tick(windClock, renderer.domElement.height / 2);
      fx?.update(wallDt, fxDt);
      for (const ped of sim.pedViews) if (ped.v > 0.05) wear.feet(ped.x, ped.y, wallDt);
      wear.follow(rig.viewport.centre.x, rig.viewport.centre.y);
      wear.tick(wallDt);
      // The rooms cut open are lit from inside: brighter as the day goes.
      const key = cutSpec ? `${cutSpec.level}@${cutSpec.x},${cutSpec.y}:${net.doc.buildings.revision}` : '';
      if (key !== lampsKey) {
        lampsKey = key;
        const lamps = roomLamps.lamps(net.doc, cutSpec, builtGroundAt, pavedHeightAt, ROOM_LIGHTS);
        roomLights.forEach((light, i) => {
          const at = lamps[i];
          light.userData['used'] = !!at;
          if (at) light.position.set(at.x, at.z, -at.y);
        });
      }
      // Falls off with the distance in world units: the same lamp in metres at any unit.
      for (const light of roomLights) light.intensity = cutSpec && light.userData['used'] ? 55 * TUNED_UNIT ** light.decay * (0.25 + 0.75 * lastDark) : 0;
      signals.sync(sim.signals, net, detailed, crowdFrustum);

      target.copy(rig.target);
      const halfHeight = canvas.clientHeight / Math.max(0.001, rig.viewport.zoom * 2);
      const halfWidth = (halfHeight * canvas.clientWidth) / Math.max(1, canvas.clientHeight);
      // The screen's height covers more ground the lower the camera looks
      const reach = rig.perspective ? 1.6 : 1;
      const groundHalfDepth = (reach * halfHeight) / Math.max(0.3, Math.sin(rig.viewport.elevation));
      // The top of the tallest building, as the layer keeps it (`BuildingLayer.top`).
      const tallestTop = Math.max(0, buildings.top);
      // Day and night, by the city's clock (`sim/city/city.ts`).
      const fixedHour = skyMode === 'day' ? 16 * 60 : skyMode === 'night' ? 22 * 60 : null;
      const clock = fixedHour === null ? sim.minutes : fixedHour;
      {
        // THE WEATHER (`world/weather.ts`): the wind carries the clouds and bends the plants and the smoke
        const weather = net.doc.weather;
        const step = Math.min(0.1, Math.max(0, delta));
        const wind = windVector(weather, m(1));
        cloudDrift.x += wind.x * step;
        cloudDrift.y += wind.y * step;
        post.setCloudDrift(cloudDrift.x, cloudDrift.y);
        setWindWeather(wind.x, -wind.y, weather.wind);
        // The water: its waves run with the wind, rougher the harder it blows; its foam; how fast the rivers run.
        const windLength = Math.hypot(wind.x, wind.y);
        const angle = (weather.windDirection * Math.PI) / 180;
        terrain.setWaterLook({
          waves: Math.min(1, weather.waves + weather.wind / 40),
          foam: weather.foam,
          current: weather.current * m(1),
          windX: windLength > 1e-6 ? wind.x / windLength : Math.cos(angle),
          windZ: windLength > 1e-6 ? -wind.y / windLength : -Math.sin(angle),
          windSpeed: windLength,
        });
        const span = 2 * Math.max(halfWidth, halfHeight);
        if (weather.lightning > 0 && Math.random() < (step * weather.lightning) / 60) {
          const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * span * 0.45;
          strikeAt(target.x + Math.cos(a) * r, -target.z + Math.sin(a) * r);
        }
        canvasSize.set(canvas.clientWidth, canvas.clientHeight);
        const flash = lightning.update(step, canvasSize);
        const storm = Math.min(1, weather.lightning / 8);
        environment.setWeather(Math.max(weather.rain * 0.85, storm * 0.6), flash);
        rainWind.set(wind.x, -wind.y);
        rain.update(weather.rain, target, span, rainWind, step);
        sceneryKit.setHaze(Math.max(weather.rain, storm));
        weatherActive = weather.rain > 0 || weather.lightning > 0 || flash > 0 || (weather.wind > 0 && placedCloudsShown);
      }
      const dark = environment.setTimeOfDay(clock);
      // What a cloud's shadow can take: the sun's share of the light now.
      post.setDirectShare(environment.directShare());
      if (Math.abs(dark - lastDark) > 0.01) {
        lastDark = dark;
        post.setNight(dark);
        sceneryKit.setNight(dark);
        agents.setNight(dark);
      }
      // The windows every frame: how many rooms are lit follows the clock
      buildings.setNight(lastDark, clock / 60);
      // The sun's cascades fitted to what the camera sees, up to the tallest top.
      environment.follow(rig.camera, target, tallestTop, builtGroundAt);
      // What the simulation must show in full: people step round each other only where they are seen, and big enough to see it
      {
        // In perspective, tilted towards the horizon, the camera sees far past the circle round the centre of the view
        let view: { ex: number; ey: number; dx: number; dy: number; cos: number; far: number } | null = null;
        if (rig.perspective) {
          // The cone on the plane, as the simulation sees it.
          const coneDirection = rig.camera.getWorldDirection(flatDirection);
          const flat = Math.hypot(coneDirection.x, coneDirection.z);
          if (flat > 0.05) {
            const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
            const fov = rig.camera instanceof PerspectiveCamera ? rig.camera.fov : PERSPECTIVE_FOV;
            const halfAcross = Math.atan(Math.tan((fov * Math.PI) / 360) * aspect);
            view = {
              ex: rig.camera.position.x, ey: -rig.camera.position.z,
              dx: coneDirection.x / flat, dy: -coneDirection.z / flat,
              cos: Math.cos(Math.min(Math.PI, halfAcross + VIEW_MARGIN)), far: VIEW_SEEN,
            };
          }
        }
        sim.focus = {
          x: target.x,
          y: -target.z,
          r: Math.hypot(halfWidth, groundHalfDepth) + m(20),
          detail: rig.viewport.zoom * m(1.7) >= 10,
          view,
        };
      }

      // The shadow pass, drawn when the map can have changed.
      if (renderer.shadowMap.enabled) {
        // The two-wheelers changed between casting and a soft disc: their shadows come or go now.
        if (agents.castersChanged) shadowMoved = true;
        // Moving only when something that moves is in the pass (`movingCasters`) or the wind bends the trees
        simRunning = !sim.paused;
        const moving = net.doc.weather.wind > 0 || (simRunning && movingCasters());
        if (castersMoved && !moving) shadowMoved = true;
        castersMoved = moving;
        // Each cascade drawn when what it holds can have changed (`sunCascades.ts` `pass`)
        if (environment.shadowPass({ changed: shadowMoved, effects: simRunning && (fx?.busy() ?? false), wind: net.doc.weather.wind > 0 })) {
          renderer.shadowMap.needsUpdate = true;
        }
        shadowMoved = false;
      }
      // An explosion shakes the camera for a moment.
      const shake = fx?.shake() ?? 0;
      if (shake > 0) {
        shakeOffset.set((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
        rig.camera.position.add(shakeOffset);
        rig.camera.updateMatrixWorld();
      }
      // The land's own light (its hills' shading, baked a plate at a time).
      terrain.setSun(sunTowards.copy(environment.sun.position).sub(environment.sun.target.position));
      {
        // The relief's close window (terrainRelief.ts) round the ground the view looks at, drawn a little towards the camera
        const centre = rig.viewport.centre;
        const cam = rig.camera.position;
        const dx = cam.x - centre.x, dz = cam.z + centre.y;
        const across = Math.hypot(dx, dz);
        const pull = across > 1 ? Math.min(150, across * 0.3) / across : 0;
        reliefFocus.x = centre.x + dx * pull;
        reliefFocus.z = -centre.y + dz * pull;
        // Close: the screen's height under some 1800 units of ground, in either camera
        const halfHeight = renderer.domElement.clientHeight / Math.max(1e-3, 2 * rig.viewport.zoom);
        const close = halfHeight < 900;
        if (net.doc.gullyRevision !== gulliesFor) {
          gulliesFor = net.doc.gullyRevision;
          terrain.setGullies(net.doc.gullyDabs, net.doc.gullyAuto);
        }
        // The atlas keeps in full only the plates near what the view takes in (`flatAtlas.ts`).
        terrain.focus?.(centre.x, centre.y, halfHeight);
        // Each plate's patches for this camera, where a coarser level would move the ground by under a pixel (`terrainLod.ts`).
        terrain.lookFrom?.(rig.camera, renderer.domElement.height);
        // The roads at full detail within reach of what the view takes in, the far level beyond: a few frames apart
        roadFocus.x = centre.x; roadFocus.y = centre.y;
        roadFocus.reach = Math.min(900, Math.max(320, halfHeight * 1.8));
        if (roadFocus.frames++ % 6 === 0) {
          const blocks: Mesh[] = [];
          for (const { mesh } of surfaceReuse.chunks.values()) blocks.push(mesh);
          updateRoadLevels(blocks, roadFocus.x, roadFocus.y, roadFocus.reach);
        }
        terrain.bakeRelief(renderer, close ? reliefFocus : null);
      }
      {
        // The painted fog: its map again when the fog or the land under it changed (never in the middle of a sculpting stroke).
        const doc = net.doc;
        // A fog stroke shows as it is painted; a land stroke waits for its end.
        const landHeld = !!options?.holdRoads && fogTerrainSeen !== doc.terrainRevision;
        const fogSerial = doc.changes.serialOf(...FOG_KINDS);
        if ((fogJournal !== doc.changes || fogSerial !== fogSeen) && !landHeld) {
          const startedAt = performance.now();
          // Only where the fog, the land or the ground under it changed (`createFogField`)
          const entries = fogJournal === doc.changes && fogSeen >= 0 ? doc.changes.since(fogSeen, FOG_KINDS) : null;
          const ground = (x: number, y: number): number => terrain.renderedHeightAt(x, y);
          const laid = !entries || entries.some((e) => e.rects === null)
            ? fogField.whole(doc.fogDabs, ground)
            : fogField.update(doc.fogDabs, ground, entries.flatMap((e) => e.rects!));
          fogLayer = laid.any ? laid : null;
          fogJournal = doc.changes;
          fogSeen = fogSerial;
          fogTerrainSeen = doc.terrainRevision;
          performance.measure('hitch:fog', { start: startedAt, end: performance.now() });
        }
        if (!landHeld) {
          // The fog's window kept round where the view looks (`fogLayer.ts`): only the texels that came in written.
          const followed = fogField.follow(rig.viewport.centre.x, rig.viewport.centre.y, doc.fogDabs, (x, y) => terrain.renderedHeightAt(x, y));
          if (followed) fogLayer = followed.any ? followed : null;
        }
        const f = doc.fogSettings;
        post.setPlacedClouds(doc.clouds);
        // The elements: again only in the cells where they or the ground under them changed (`elements.ts`).
        if (elementKit && !landHeld) {
          const startedAt = performance.now();
          if (!elementLayer) {
            elementLayer = createElementLayer(elementKit);
            world.add(elementLayer.group);
          }
          const entries = elementRead.read(doc.changes);
          let cells: Set<number> | null = null;
          if (entries !== null && entries.every((e) => e.rects !== null)) {
            cells = new Set();
            // A prop stands on the ground drawn under its point: a terrain cell round a change of the ground.
            for (const e of entries) for (const r of e.rects!) keepCellsOver(r, TERRAIN_CELL, cells);
          }
          if ((cells === null || cells.size > 0) && elementLayer.sync(cells, doc, (x, y) => terrain.renderedHeightAt(x, y))) {
            elementLayer.cull(crowdFrustum, crowdProjection);
            shadowMoved = true;
          }
          performance.measure('hitch:elements', { start: startedAt, end: performance.now() });
        }
        elementLayer?.emit(Math.min(0.1, Math.max(0, delta)), rig.camera.position, exhaust);
        post.setGroundFog(fogLayer?.any ? { texture: fogLayer.texture, low: fogLayer.low, high: fogLayer.high, density: f.density, window: fogLayer.window } : null);
        fogMoving = !!fogLayer?.any;
        placedCloudsShown = doc.clouds.length > 0 || !!elementLayer?.hasEffects;
      }
      // Rain thickens the air: a grey mist over the distance (`world/weather.ts`).
      const rainNow = net.doc.weather.rain;
      const air = rainNow > 0 ? { ...atmosphere, fog: Math.max(atmosphere.fog, rainNow * 0.2), fogHeight: Math.max(atmosphere.fogHeight, m(120)) } : atmosphere;
      // The orthographic camera stands far back by construction
      const eyeShift = rig.perspective ? 0
        : rig.camera.position.distanceTo(rig.target) - halfHeight / Math.tan((PERSPECTIVE_FOV * Math.PI) / 360);
      post.setAtmosphere(air, sunTowards.copy(environment.sun.position).sub(environment.sun.target.position), environment.skyColor,
        sunLight.copy(environment.sun.color).multiplyScalar(environment.sun.intensity), eyeShift);
      const atRender = performance.now();
      // The people's skeletons on the GPU (`people/crowdAnimation.ts`), before anybody draws them.
      agents.renderPalettes(renderer);
      // The opening's town is shown whole
      openingSince ??= performance.now();
      if (!reveal.opened) {
        const whole = roads !== null && !worldJob && !buildings.pending && natureTreesStarted && !natureTreesPending && (openingHeld?.() ?? true);
        const next = reveal.step(whole, performance.now());
        if (next === 'warm') {
          // One frame drawn unseen first: the new meshes go to the GPU
          if (post.target) {
            renderer.setRenderTarget(post.target);
            renderer.render(scene, rig.camera);
            renderer.setRenderTarget(null);
          }
          programs.compile(scene);
          onAssetsReady();
        } else if (next === 'show') {
          // Shown however far it got (`REVEAL_LIMIT_MS`): its programs compiled all the same.
          programs.compile(scene);
          performance.mark('opening:shown', { detail: { waitedMs: performance.now() - openingSince, workedMs: reveal.worked, whole } });
        }
      }
      if (reveal.opened) {
        // Round the frame's whole drawing: the shadow, the scene, every pass.
        gpuTimer.poll();
        gpuTimer.begin();
        post.render(delta);
        gpuTimer.end();
      } else onAssetsReady();
      performance.measure('hitch:draw/Render', { start: atRender, end: performance.now() });
      if (shake > 0) { rig.camera.position.sub(shakeOffset); rig.camera.updateMatrixWorld(); }
      // One waiting texture a frame to the GPU, before anybody draws it.
      drainUploads(renderer, 1);
      drainCompiles(renderer, rig.camera, scene, post.target);
      // From the second frame on, the compiler answers: warm the road shaders.
      warmRoadShaders();
      warmBlastShaders();
      warmPreviewShaders();
      // One waiting body's geometry a frame to the GPU, before anybody draws it.
      drainWarm(renderer, rig.camera, scene, post.target);
      // Meshes still waiting to go up: another frame, so the queue never stands while the game is still.
      if (warmPending()) onAssetsReady();

      if (delta > 0) fps = fps * 0.9 + (1 / Math.min(1, delta)) * 0.1;
    },
    setQuality(level, settings) {
      requested = level;
      const resolved = level === 'auto' ? governor.current : level;
      governor.set(resolved);
      applyQuality(resolved, settings);
    },
    get quality() {
      return requested;
    },
    dispose() {
      roadTiles.dispose();
      groundWorkers.dispose();
      tileWriter?.terminate();
      // Everything the renderer made, the GPU's included: the layers, the previews and the effects too
      fx?.dispose();
      densityCars.dispose();
      exhaust.dispose();
      wear.dispose();
      barriers.dispose();
      transit.dispose();
      transitPreview?.dispose();
      polePreview?.dispose();
      utilities?.dispose();
      signs.dispose();
      for (const flash of gridFlashes) flash.mesh.geometry.dispose();
      agents.dispose();
      signals.dispose();
      buildings.dispose();
      farRoads.dispose();
      blinkMaterial.dispose();
      worldJob = null;
      roads?.dispose();
      disposeSurfaceReuse(surfaceReuse);
      details?.dispose();
      furniture.dispose();
      gardens?.dispose();
      for (const plants of [coverCells, natureCards, natureForest, paintedForest, plantedForest]) plants?.dispose();
      coverKit.dispose();
      fogTexture.dispose();
      elementLayer?.dispose();
      elementKit?.dispose();
      paintedForest?.dispose();
      plantedForest?.dispose();
      rain.dispose();
      lightning.dispose();
      natureTreeKit?.dispose();
      sceneryKit.dispose();
      terrain.dispose();
      materials.dispose();
      environment.dispose();
      post.dispose();
      lotOverlay?.dispose();
      renderer.dispose();
    },
  };
  return handle;
}

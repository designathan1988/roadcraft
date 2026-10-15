import { onEcologyRead } from './ecologyPool';
import { GRID_CELL } from '@world/grid';
import type { BodyPart, Severable } from '@sim/people/view';
import type { Archetype } from '@sim/vehicles/archetypes';
import type { Vehicle } from '@sim/vehicles/state';
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
  Box3,
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
import { Network } from '@world/network';
import { GROUND_ONLY, SURFACE_READ_REACH, buildRoadElevation, type RoadElevation } from '@world/elevation';
import { FOOTWAY_RISE, ROAD_TYPES, casingHalf, sidewalkHalf } from '@world/roadTypes';
import { footwayRiseAt } from '@world/roads/footwayRise';
import type { RoadStructure } from '@world/structures';
import type { SimWorld } from '@sim/world';
import type { Viewport } from '@view/viewport';

import { createAgentMeshes, type AgentMeshes } from './agents';
import { createEnvironment, slopeScaledShadowOffset } from './environment';
import { createMaterials, type SceneMaterials } from './materials';
import { PERSPECTIVE_FOV, createIsoRig } from './isoViewport';
import { DEFAULT_ATMOSPHERE, createPostChain, type Atmosphere, type PostChain } from './postprocess';
import { createInspector, type Inspector } from './inspector';
import { buildRoadSurfaces, disposeSurfaceReuse, roadSurfaceSteps, storedKey, type RoadSurfaces, type SurfaceReuse, type TileBundle } from './roadSurfaces';
import { forgetDerivedKeys, forgetOtherDerived, readDerivedAll, writeDerivedMany } from './derivedCache';
import { disposeMesh } from './mesh/surfaceMesh';
import { RoadTilePool } from './roadTilePool';
import { PLANT_MAP_ZOOM, PLANT_NEAR_ZOOM, createSceneryKit, plantSamples, type SceneryKit } from './scenery';
import { createStreetFurniture } from './streetFurnitureLayer';
import { createGardens, type GardenPlant, type Gardens } from './gardens';
import { gardenLists } from './gardenLists';
import { localToWorld, solidFootprints, storedBounds } from '@world/buildings/geometry';
import { followPieces } from '@world/buildings/elements';
import { RoadDoc } from '@world/doc';
import { compileAhead, compileCopy, drainCompiles, drainUploads, drainWarm, shadowStandIn, warmPending } from './uploads';
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
import { MAP_HALF, MAP_REGIONS, MAP_SIZE, regionAt } from '@world/bounds';
import { createSignLayer } from './signLayer';
import { type PlantCells, createCoverCells, createTreeCells } from './plantCells';
import { CandidateKeep } from './candidateKeep';
import { JournalCursor } from '@world/derived';
import { Engine } from '@core/engine';
import { fadeMeshes } from './buildings/fade';
import { RevealGate } from './revealGate';
import { createGpuTimer, type GpuTimer } from './gpuTimer';
import { poleGroundAt, type Utilities } from './utilities';
import { type PoleLayer, buildPolePreview, buildUtilities, docPoles, type PolePreviewInput } from './poleLayer';
import { createBarriers } from './barriers';
import { buildTrackPreview, createTrackPreview, createTransit, type TrackPreview } from './transit';
import { TERRAIN_CELL, TERRAIN_GRID, TERRAIN_HALF, type TerrainPart, type TerrainRegion, type TerrainSurface } from './terrain';
import { createFlatAtlas } from './flatAtlas';
import { WOODS_SLOPE_STEP, WOODS_SPACING } from './woodsBase';
import { siteGrading } from '@world/buildings/siteGrading';
import { type CameraSolids, type GroundSince, cameraSolidsKeeper } from '@world/buildings/cameraSolids';
import { FLOOR_READ_REACH, floorHeight } from '@world/buildings/foundation';
import { RoomLamps } from './roomLamps';
import { TUNED_UNIT, m, perM } from '@world/units';
/** Room lights kept in the scene for the floors cut open (`roomLamps.ts`). */
const ROOM_LIGHTS = 6;
declare const __ROAD_TILES_HASH__: string | undefined;
/** The fingerprint of the road tiles' code (`cook-plugin.ts`): their tiles are kept under it between sessions. */
const ROAD_TILES_HASH = typeof __ROAD_TILES_HASH__ !== 'undefined' && __ROAD_TILES_HASH__ ? __ROAD_TILES_HASH__ : null;
/** How long the opening's roads wait for the kept tiles to be read, ms: past it they are built. */
const KEPT_TILES_WAIT_MS = 3000;

/** The thinnest frame bars are 0.045 u wide: their shadows are subpixel below this zoom. */
const FACADE_SHADOW_ZOOM = perM(27.5);
/**
 * The zoom above which the shadow map is drawn every frame (px per metre).
 * Close up a caster's shadow is metres wide on the screen and a frame of lag
 * is a pixel or two; further out the whole shadow is a texel or less and a
 * frame of it cannot be seen, so the pass is skipped (`SHADOW_FAR_EVERY`).
 */
const SHADOW_FULL_ZOOM = perM(12);
/** Frames between shadow passes where a shadow is smaller than a texel. */
const SHADOW_FAR_EVERY = 3;
/**
 * Longest a caster that arrived without saying so can be absent from the map,
 * in frames: the same cadence as `assignShadowDepth`, which is what gives a
 * mesh added by any path its depth material.
 */
const SHADOW_SAFETY_FRAMES = 30;
import { type BuildingPreviewInput, type CutawaySpec, createBuildingLayer } from './buildings/layer';
import { buildBuildingMeshes } from './buildings/buildingMesh';
import { refillArrays } from './mesh/gpuOnly';
import { BLUEPRINTS, instantiate } from '@world/buildings/blueprints';
import type { Building, BuildingId } from '@world/buildings/types';
import { QUALITY, QualityGovernor, type QualityLevel, type QualitySettings } from './quality';
import { type GroundRecord, type Rect, unionRect } from './groundChanges';
import { FOREST_SPECIES, createGroundCoverKit, type ForestSpecies } from './groundCover';
import { clearingIndex } from '@world/trees';
import { natureDensity } from './natureNoise';
import { buildNatureForest, loadNatureTrees, seedOfKind, type NatureTreeKit } from './natureTrees';
import { createFogField, createFogTexture, type FogLayer } from './fogLayer';
import { buildElementLayer, loadElementKit, type ElementKit, type ElementLayer } from './elements';
import { isCoverKind } from '@world/terrainPaint';

/**
 * The scene renderer.
 *
 * ## The rebuild contract
 *
 * Everything derived from the road network or the terrain is rebuilt in exactly
 * one place, `rebuildWorld`, and only when one of the two revisions it watches
 * has moved. Nothing computes geometry inside `draw`. That matters because a
 * road rebuild solves the whole elevation field and re-triangulates every band:
 * doing it per frame was how earlier versions turned an edit into a stall.
 *
 * A terrain edit invalidates the roads too — they are laid ON the terrain — so
 * both revisions gate the same rebuild.
 *
 * ## Draw order
 *
 * 1. terrain (heightfield, water)
 * 2. road surfaces (four bands per structural level, plus markings)
 * 3. structure details (piers, parapets)
 * 4. scenery (furniture, trees, bushes; grass at close zoom only)
 * 5. agents and signal heads, resynced every frame from the simulation
 */

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

export interface RenderStats {
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

export interface DrawOptions {
  /**
   * Keep the roads, and everything laid along them, as they are: only the
   * ground is updated, and shaped to the roads' current heights. Set while a
   * terrain brush stroke is held; the first draw without it re-solves the
   * roads once for the whole stroke.
   */
  readonly holdRoads?: boolean;
}

export interface SceneHandle {
  /**
   * Loads what shots and blows leave behind (`playEffects.ts`: bodies, blood,
   * explosions, broken buildings) the first time the dock's Actions or walking
   * the city want them; resolves at once after that. Until then every effect
   * method below does nothing.
   */
  effects(): Promise<void>;
  /** The world of the last edit is still being built (`worldSteps`); the old one is drawn meanwhile. */
  readonly worldBusy: boolean;
  /** The opening's town (or a map being opened) is still being put together, nothing of it shown yet (`opened` in `draw`). */
  readonly opening: boolean;
  /**
   * A map is being opened (a file, the autosave): nothing is shown until its
   * whole world is in - the roads, the ground, the buildings, the trees, the
   * things on the footways - and then all of it at once, as at the opening.
   */
  beginLoad(): void;
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
  /** The editor's building ghost (docs/buildings.md); null removes it. */
  setBuildingPreview(preview: BuildingPreviewInput | null): void;
  /** The pole run the pole tool would build, drawn as built; null removes it. */
  setPolePreview(net: Network, preview: PolePreviewInput | null): void;
  /** The metro seen as a cut through the ground (the transit tool on). */
  setTransitXray(on: boolean): void;
  /** The track being laid, built as it will be (`buildTrackPreview`); null removes it. */
  setTransitPreview(preview: { mode: 'train' | 'metro'; points: readonly { x: number; y: number }[] } | null): void;
  /**
   * The lots of the Zoning tool coloured into the ground, all of them from
   * the next frame (`lotOverlay.ts`); null removes them. `changes`, the
   * document's diary: where the ground moved, a built lot's level is read again.
   */
  setLotOverlay(input: LotOverlayInput | null, changes?: ChangeJournal): void;
  /**
   * A blow on a building at world (x, y, z), `strength` 1..10: it breaks
   * (`destruction.ts`). Returns true when nothing of it is left standing.
   */
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
  /** Forgets a building's ruin (it was removed). */
  forgetRuin(id: number): void;
  /**
   * The Builder's "Ocultar outros": undefined draws every building solid,
   * null fades them all, an id fades every building but that one.
   */
  setBuildingsDimmed(except: number | null | undefined): void;
  /** "See inside": the buildings near (x, y) drawn cut open at a floor; null draws them whole. */
  setBuildingCutaway(spec: CutawaySpec | null): void;
  /** The sky: always day, always night, or the residents' own clock. */
  setSkyMode(mode: SkyMode): void;
  /** Clouds and mist as the player set them (Paisagem > Céu e clima). */
  setAtmosphere(atmosphere: Atmosphere): void;
  /** Perspective camera on, or the orthographic (isometric) view. */
  setPerspective(on: boolean): void;
  /** A shot: a tracer from the muzzle to where it struck, and the muzzle's flash (world x, y, height). */
  shot(from: readonly [number, number, number], to: readonly [number, number, number]): void;
  /**
   * A person struck by a shot (world x, y, the height struck): blood sprayed
   * out of the far side and on the ground behind, and what the shot took off
   * (an arm, a leg, the head) flung along the shot.
   */
  wound(x: number, y: number, z: number, dirX: number, dirY: number, severed: Severable | null): void;
  /**
   * A shot along the line of sight between world points `a` and `b` (x, y,
   * height) at the bodies on the ground (`Ragdolls.shootBody`): somebody
   * alive down there comes back to be hurt by the simulation.
   */
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
  /**
   * A shot striking a vehicle at world (x, y, height z), coming along
   * (dirX, dirY): sparks off the bodywork, or the glass bursting in (and
   * blood behind it when somebody sat there).
   */
  vehicleHit(x: number, y: number, z: number, dirX: number, dirY: number, glass: boolean, blood: boolean): void;
  /** The body a vehicle's driver or rider is drawn with (`AgentMeshes.driverBody`). */
  driverBody(vehicle: Vehicle, x: number, y: number): number | null;
  /** A two-wheeler its rider was shot off: the machine itself falling over and sliding to a stop. */
  dropVehicle(v: { id: number; archetype: Archetype; x: number; y: number; angle: number; color: number; dirX: number; dirY: number }): void;
  /** The height the terrain is drawn at — what anything laid on it must clear. */
  terrainHeightAt(x: number, y: number): number;
  /** The highest corner of the ground as drawn now (the mesh is flat between corners), read once per change of it. */
  landTop(): number;
  /** The universal grid (`world/grid.ts`) drawn over the whole map, on the ground, or not. */
  setGrid(on: boolean): void;
  /**
   * The grid's cells a road was just laid over light up and fade back, a
   * blink; the cells round them follow a little later and fainter, by `ring`
   * (0 the cells under the road, 1 next to them, ...). Cells by their lower
   * corner, world units.
   */
  flashGrid(cells: readonly { x: number; y: number; ring: number }[]): void;
  /** The roads just laid light up and fade back, a blink, over their whole width. */
  flashRoads(ids: readonly SegmentId[]): void;
  /**
   * The ground what is built stands on (`builtGroundAt`): the land before the
   * roads and the buildings shape it, and over the sea its surface and a
   * freeboard. The roads' heights (`buildRoadElevation`) and the buildings'
   * floors (`floorHeight`) are worked out on it, by the renderer and the
   * tools alike, so an edit's dry run and its drawing agree.
   */
  builtGroundAt(x: number, y: number): number;
  /**
   * The roads' heights an edit already solved for this network on the
   * natural terrain (the tunnel test, `commitRoadPath`): the next rebuild
   * takes them instead of solving the same network again.
   */
  offerElevation(elevation: RoadElevation, networkRevision: number): void;
  /**
   * The roads' heights last solved on the natural terrain, with the terrain
   * revision they were solved on (null before the first): an edit's tunnel
   * test starts from them while the land is the same (`commitRoadPath`).
   */
  roadsSolve(): { readonly elevation: RoadElevation; readonly terrainRevision: number } | null;
  /**
   * The top of what is drawn at a point: a deck where a road's casing covers
   * it, the terrain elsewhere. (`elevationAt` is the NEAREST road's height
   * wherever the point is, a field for previews, not a surface.)
   */
  surfaceHeightAt(x: number, y: number): number;
  /**
   * The height of the paving at a point - footway or carriageway of a road at
   * grade - or NaN off the roads. What a building's entrance opens onto.
   */
  pavedHeightAt(x: number, y: number): number;
  resize(): void;
  draw(net: Network, sim: SimWorld, alpha: number, delta: number, options?: DrawOptions): void;
  setQuality(level: QualityLevel | 'auto'): void;
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
): SceneHandle {
  // A plate's ecosystem read off the page (`ecologyPool.ts`) is drawn as it comes back.
  onEcologyRead(onAssetsReady);
  /**
   * The shadow map is drawn only when it can have changed. Set by anything
   * that puts a new caster in the scene or moves one the simulation does not
   * drive (a rebuild, an asset arriving, a quality tier change); the sun and
   * the traffic answer for themselves in the frame.
   */
  let shadowMoved = true;
  /** Frames since the shadow map was last drawn (`SHADOW_FAR_EVERY`). */
  let shadowFrame = 0;
  /**
   * Whether anything that moves is drawn into the shadow map: a visible
   * caster with instances outside what stands still - the town's world (but
   * its trains), the buildings, the ground and its grass, the signals.
   * Traffic, people, trains and a blow's debris are the rest. An object the
   * renderer adds later counts as moving until it is listed here.
   */
  const castsInto = (root: Object3D): boolean => {
    const stack: Object3D[] = [root];
    while (stack.length) {
      const o = stack.pop()!;
      if (!o.visible) continue;
      const mesh = o as Mesh & { isInstancedMesh?: boolean; count?: number };
      if (mesh.isMesh && mesh.castShadow && (!mesh.isInstancedMesh || (mesh.count ?? 0) > 0)) return true;
      for (const child of o.children) stack.push(child);
    }
    return false;
  };
  const movingCasters = (): boolean => {
    for (const root of scene.children) {
      if (root === world || root === buildings.group || root.name === 'traffic-signals' || stillRoots.has(root)) continue;
      if (castsInto(root)) return true;
    }
    return castsInto(transit.group);
  };
  /** The ground and its grass, which never move (`movingCasters`). */
  const stillRoots = new Set<Object3D>();
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
    // Reversed Z into a float depth buffer (`depthConvention.ts`): faces a
    // few millimetres apart are told apart at any distance. DO NOT drop it
    // for a near plane pushed out or offsets grown until the flicker hides.
    reversedDepthBuffer: true,
  });
  // One game frame has the scene, shadows and several postprocess renders.
  // The default reset on each `render()` left stats showing only the last quad.
  renderer.info.autoReset = false;
  // Checking every program's compile and link log makes each new shader wait
  // for the driver on the main thread (`getProgramInfoLog`: 0.4 s while the
  // town loads). three.js recommends turning it off in production and keeping
  // it on while developing (WebGLRenderer.debug.checkShaderErrors).
  renderer.debug.checkShaderErrors = import.meta.env.DEV;
  // The GPU time of every frame (docs/pesquisa/fase-0-medida.md 3.1).
  const gpuTimer = createGpuTimer(renderer);
  renderer.outputColorSpace = SRGBColorSpace;
  // A film curve (ACES): contrast, deep shade and bright light, the look of
  // the diorama the player holds up as the target (2026-10-07). Khronos PBR
  // Neutral is made for product viewers - hue kept, contrast low on purpose
  // (Khronos; the three.js forum's tone-mapping overview) - and drew the
  // land flat and washed out. The colours are set for this curve: ACES pulls
  // bright colours towards white, so the albedos carry the chroma.
  renderer.toneMapping = ACESFilmicToneMapping;
  // Three's ACES already scales its input by 1 / 0.6 (tonemapping_pars:
  // `color *= toneMappingExposure / 0.6`, Narkowicz's pre-exposure), so 1 is
  // the reference. At 1.3 the scene went in at 2.17 times and every white
  // wall and the grass blew out (the player, 2026-10-08: "extremamente
  // brilhante").
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  // PCFSoftShadowMap was REMOVED in three r186. Asking for it logged
  // "PCFSoftShadowMap has been removed. Using PCFShadowMap instead." on every
  // boot and silently gave us the hard filter anyway, so the softness the
  // scene was tuned for never existed. Name what we actually get.
  renderer.shadowMap.type = PCFShadowMap;
  slopeScaledShadowOffset();
  // Drawn once a frame, on request (see `post.render` below). Left automatic,
  // three redraws every shadow map on EVERY `renderer.render`, and the frame
  // has two scene renders with the sun in them - the main pass and the
  // ambient-occlusion pass's normal pass - so the whole shadow pass, every
  // caster in the city, was drawn twice a frame for the same picture.
  renderer.shadowMap.autoUpdate = false;

  // One shadow depth material per program variant. three draws every caster
  // without a depth material of its own with ONE shared material, and plain
  // meshes, instanced meshes and instanced meshes with per-instance colour
  // compile to three different programs of it: interleaved in the shadow pass,
  // three re-derived the program on nearly every draw (`getParameters`,
  // `setProgram` - the trap CLAUDE.md describes, inside three). Each variant
  // now has its own material, so each keeps its program.
  const depthVariants = {
    plain: new MeshDepthMaterial({ depthPacking: RGBADepthPacking }),
    instanced: new MeshDepthMaterial({ depthPacking: RGBADepthPacking }),
    tinted: new MeshDepthMaterial({ depthPacking: RGBADepthPacking }),
  };
  const ownDepth = new Set<MeshDepthMaterial>(Object.values(depthVariants));
  const plainOpaque = (material: Material): boolean => {
    const m = material as Material & { alphaTest: number; alphaMap?: unknown; map?: unknown; displacementMap?: unknown };
    // Anything three would give a depth material of its own (cut-outs,
    // displacement, coverage) keeps three's own choice.
    return !(m.alphaTest > 0 && (m.map || m.alphaMap)) && !m.displacementMap && !m.alphaToCoverage;
  };
  let shadowDepthFrame = 0;
  const assignShadowDepth = (root: Object3D): void => {
    root.traverse((object) => {
      const mesh = object as Mesh & { isInstancedMesh?: boolean; instanceColor?: unknown };
      if (!mesh.isMesh || !mesh.castShadow) return;
      const current = mesh.customDepthMaterial as MeshDepthMaterial | undefined;
      if (current && !ownDepth.has(current)) return;
      if (Array.isArray(mesh.material) || !plainOpaque(mesh.material)) return;
      const wanted = !mesh.isInstancedMesh
        ? depthVariants.plain
        : mesh.instanceColor ? depthVariants.tinted : depthVariants.instanced;
      if (current !== wanted) mesh.customDepthMaterial = wanted;
    });
  };

  let requested: QualityLevel | 'auto' = initialQuality;
  const governor = new QualityGovernor(requested === 'auto' ? 'high' : requested);
  let quality: QualitySettings = QUALITY[governor.current];

  const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
  const anisotropy = Math.min(quality.anisotropy, maxAnisotropy);

  let gridWanted = false;
  /** The blinks of cells under a road just laid (`flashGrid`), until each has faded; `time` seconds since each began. */
  const gridFlashes: { mesh: Mesh; start: number; end: number; time: number }[] = [];
  /**
   * ONE material for every blink, made once: a material per road laid was an
   * object made and disposed per edit (its program came from the cache, its
   * uniforms and bindings did not). Each blink's own time goes into the
   * shared uniform right before it is drawn (`onBeforeRender`, with
   * `uniformsNeedUpdate` so three uploads it for that draw).
   * NÃO voltar a criar um ShaderMaterial por lampejo.
   */
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
      // Over the ground whatever it does meanwhile: laid at the height the
      // ground had at the click, the cut and fill that follows the road rose
      // through it and broke it into pieces (the player, 2026-10-06).
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
  // The root never moves. Keep its identity matrix from forcing every static
  // world child to recompute a world matrix on every render pass.
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
  const wear = createWearField(MAP_SIZE);
  let lastWall = -1;
  applyWear(materials.asphalt, wear, MAP_SIZE, 0, 'asphalt');
  applyWear(materials.footway, wear, MAP_SIZE, 1, 'footway');
  materials.setDetail(quality.surfaceDetail);
  // Every prop model and material, built once. A rebuild writes only the
  // instance matrices.
  const sceneryKit: SceneryKit = createSceneryKit();
  // The map's ground, in plates (`flatAtlas.ts`).
  const terrain: TerrainSurface = createFlatAtlas(anisotropy);
  /**
   * The ground what is built stands on - the roads solved on it, the
   * buildings' floors worked out on it: the natural land as drawn, before any
   * road shaped it.
   */
  const builtGroundAt = (x: number, y: number): number => terrain.naturalRenderedHeightAt(x, y);
  // The perspective view looks at the ground and stays over it (`IsoRig.setGround`).
  rig.setGround((x, y) => terrain.renderedHeightAt(x, y));
  // NO GPU grass field (`grassField.ts`): the player had it taken off
  // (2026-10-06, "melhor tirar e usar uma textura"), and it was still made -
  // its blades, its mask over the whole map, 384 x 384 heights - and updated
  // every frame, hidden; its mask walked every building and lot of the town
  // at each of their revisions. The ground's own grass texture covers the map
  // (`GRASS_FIELD` stays at its default, off). DO NOT make it again unseen.
  if (import.meta.env.DEV) Object.assign(window, { __scene: scene, __gl: renderer });
  scene.add(...terrain.meshes);
  for (const mesh of terrain.meshes) stillRoots.add(mesh);

  const world = new Group();
  world.name = 'world';
  // Roads, plants, poles, furniture, forests: placed once, never moved (`stillTree.ts`).
  holdStill(world);
  scene.add(world);

  let roads: RoadSurfaces | null = null;
  /** The roads' structures, cell by cell (`structureCells.ts`), made with the first world. */
  let details: StructureCells | null = null;
  /**
   * What the player placed on the footways and the long grass, kept item by
   * item from the diary (`streetFurnitureLayer.ts`): one layer for the map,
   * in the world once.
   */
  const furniture = createStreetFurniture(sceneryKit);
  world.add(furniture.group, furniture.grass);
  let utilities: PoleLayer | null = null;
  /** The pole tool's planned run, and the plan it was built for (rebuilt only when that changes). */
  /** Vehicle exhaust and dust (`exhaust.ts`): one particle cloud for the map. */
  const exhaust = createExhaust();
  scene.add(exhaust.points);
  const shakeOffset = new Vector3();
  /**
   * What shots and blows leave behind - bodies, blood, explosions, broken
   * buildings (`playEffects.ts`) - loaded the first time the dock's Actions or
   * walking the city want them (`SceneHandle.effects`): until somebody shoots
   * or drops a bomb none of it is downloaded, made or run in a frame.
   */
  let fx: PlayEffects | null = null;
  let fxLoading: Promise<void> | null = null;
  /** The effects asked for in idle time once the world stands (`draw`). */
  let fxPreload = false;
  // The effects' two lights - the muzzle's flash and the blast's - in the
  // scene from the start, dark until used. A point light is part of every lit
  // material's program (three's `numPointLights`): made with the effects on
  // the first shot, they recompiled every shader of the scene at once and the
  // game stopped for over ten seconds (the player, 2026-10-08).
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

  // What each rebuild keeps for the next: the tiles of every surface an edit
  // does not reach, keyed by the solved roads and the ground they read - only
  // the roads a road surface can read (`SURFACE_READ_REACH`): keyed by every
  // road the index could hand a query at any distance, a street drawn
  // rebuilt tiles hundreds of units away.
  // And from one session to the next (P21): the tiles of the network last
  // built are kept in the browser (`derivedCache.ts`, under the fingerprint of
  // the code that makes them) and read back at the opening - every tile of the
  // town was built again on every opening, some 1.3 s of the test city's.
  const tilesPrefix = ROAD_TILES_HASH ? `roadtiles:${ROAD_TILES_HASH}:` : null;
  /** The kept tiles have been read (or there are none to read). */
  let storedRead = tilesPrefix === null;
  /** What the store holds now, by `storedKey`. */
  const storedKeys = new Set<string>();
  /** Tiles built since the last build was kept, to be written. */
  const toKeep = new Map<string, TileBundle>();
  const surfaceReuse: SurfaceReuse = {
    tiles: new Map(),
    dependsOn: (minX, minY, maxX, maxY) => new Digest()
      .add(elevation?.digest(minX, minY, maxX, maxY, SURFACE_READ_REACH) ?? 0)
      .add(terrain.digest(minX, minY, maxX, maxY))
      .value(),
    paint: new Map(),
    chunks: new Map(),
    retired: [],
    stored: new Map(),
    keep: (key, bundle) => { if (tilesPrefix) toKeep.set(key, bundle); },
  };
  if (tilesPrefix && ROAD_TILES_HASH) {
    forgetOtherDerived('roadtiles', ROAD_TILES_HASH);
    void readDerivedAll<TileBundle>(tilesPrefix).then((kept) => {
      for (const [key, bundle] of kept) {
        surfaceReuse.stored!.set(key, bundle);
        storedKeys.add(key);
      }
    }).finally(() => { storedRead = true; });
  }
  /**
   * After a build: the store made to hold the network just built - its new
   * tiles written, the tiles no network uses any more forgotten - in idle
   * time, a few tiles a transaction (MDN, IndexedDB: values are copied by the
   * structured clone, on this thread).
   */
  const keepTiles = (): void => {
    surfaceReuse.stored!.clear();
    if (!tilesPrefix) return;
    const current = new Set<string>();
    for (const [pass, tiles] of surfaceReuse.tiles) for (const digest of tiles.keys()) current.add(storedKey(pass, digest));
    const gone = [...storedKeys].filter((key) => !current.has(key));
    for (const key of gone) storedKeys.delete(key);
    forgetDerivedKeys(tilesPrefix, gone);
    const fresh = [...toKeep].filter(([key]) => current.has(key) && !storedKeys.has(key));
    toKeep.clear();
    for (const [key] of fresh) storedKeys.add(key);
    const write = (): void => {
      const batch = new Map(fresh.splice(0, 8));
      if (batch.size) writeDerivedMany(tilesPrefix, batch);
      if (fresh.length) idle(write);
    };
    if (fresh.length) idle(write);
  };
  const idle = (fn: () => void): void => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 4000 });
    else setTimeout(fn, 50);
  };

  /**
   * The world being rebuilt for the last edit (`rebuildWorld`), a slice a
   * frame. A step that yields 'wait' is waiting on something off the thread
   * (shaders compiling): nothing more is pumped that frame.
   */
  let worldJob: Generator<'wait' | void, void, void> | null = null;
  /** The roads' heights an edit solved ahead (`offerElevation`). */
  let offeredElevation: { elevation: RoadElevation; revision: number; terrain: number } | null = null;
  /** The roads' surface tiles shaped on the other cores (`roadTilePool.ts`). */
  const roadTiles = new RoadTilePool();
  /** The job was started in this frame (`pumpWorld` waits for the next). */
  let worldJobFresh = false;
  /** The opening's town (or a map opened) is held until it is whole (`revealGate.ts`). */
  const reveal = new RevealGate();
  let openingSince: number | null = null;
  /**
   * While nothing is shown (`opened` false) the world is built this much a
   * frame: no frame is presented, so none needs to stay smooth, and the load
   * takes the frame (Unity's `allowSceneActivation = false`).
   */
  const HIDDEN_SLICE_MS = 250;

  /**
   * The world of an edit is built up to this much a frame: at 10 ms the old
   * road stayed on screen for up to a second after it was deleted or drawn,
   * the ground round it changing block by block meanwhile (the player,
   * 2026-10-06: "um delay feio, onde ela se degrada"). At 28 ms it is in
   * place in a few frames, each still well under a stall.
   */
  const WORLD_SLICE_MS = 28;
  /**
   * The last steps' costs, ms: the next step is started only if the dearest of
   * them still fits in the slice - the estimate Chromium's deadline scheduler
   * uses for a draw (`proxy_timing_history.cc`: the 100th percentile of a
   * rolling window). Checked only after a step, a 20 ms surface tile started
   * at 27 ms made a frame of 60 ms after a road edit in the test city (P3).
   */
  const stepCosts = new Float64Array(8);
  let stepCursor = 0;
  /** Builds the world of the last edit for a few milliseconds; it puts itself in place once complete. */
  const pumpWorld = (): void => {
    if (!worldJob) return;
    // Not in the frame of the edit itself, which has already paid for the
    // edit and the roads' heights: its first slice made that frame 10 ms longer.
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
    else onAssetsReady();
  };
  let networkRevision = -1;
  let terrainRevision = -1;
  let builtTriangles = 0;
  let rebuildMs = 0;
  let rebuilds = 0;
  let terrainMs = 0;

  const deckHeight = (
    _world: SimWorld,
    x: number,
    y: number,
    segment: SegmentId | undefined,
  ): number => {
    if (!elevation) return terrain.renderedHeightAt(x, y);
    return segment === undefined ? elevation.at(x, y) : elevation.onSegment(segment, x, y);
  };

  /** See `SceneHandle.pavedHeightAt`. */
  const pavedHeightAt = (x: number, y: number): number => {
    if (!elevation || !elevation.has(GROUND_ONLY)) return NaN;
    const road = elevation.roadAt(x, y, GROUND_ONLY);
    const rt = road.type >= 0 ? ROAD_TYPES[road.type] : undefined;
    if (!rt) return NaN;
    // `half` is this road's own casing (its lanes may be set individually):
    // the footway ends a casing band inside it and starts a footway further in.
    // Each side its own footway (docs/VIAS.md V1): `half` reaches the wider one.
    const walk = (road.across >= 0 ? road.sidewalkLeft : road.sidewalkRight) ?? road.sidewalk ?? rt.sidewalk;
    const footway = road.half - (casingHalf(rt) - sidewalkHalf(rt)) - ((road.sidewalk ?? rt.sidewalk) - walk);
    const across = Math.abs(road.across);
    if (across > footway) return NaN;
    const deck = elevation.at(x, y, GROUND_ONLY);
    return across > footway - walk ? deck + (worldNet ? footwayRiseAt(worldNet, x, y) : FOOTWAY_RISE) : deck;
  };

  const agents: AgentMeshes = createAgentMeshes(deckHeight, onAssetsReady,
    // A walker off the streets stands on what is drawn there: a building's
    // terrace or yard paving where there is one, the terrain elsewhere (they
    // sank to the knees in a raised terrace).
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
  const crowdProjection = new Matrix4();
  const crowdBounds = new Sphere(new Vector3(), 8);
  const pedestrianVisible = (x: number, y: number, height: number): boolean => {
    crowdBounds.center.set(x, height + 3, -y);
    return crowdFrustum.intersectsSphere(crowdBounds);
  };
  // How tall a person stands on the screen, canvas pixels: feet and head
  // through the view-projection (either camera); seen from straight above,
  // never less than a share of their height across, their shoulders.
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
  /**
   * CSS pixels a world unit across the screen at (x, y, z) - the viewport's
   * zoom, there: a vehicle's level of detail, against the zoom bands it was
   * drawn by.
   */
  const screenScale = (x: number, y: number, z: number): number => {
    pixelFoot.set(x, z, -y);
    pixelOther.copy(pixelFoot).add(cameraRight).applyMatrix4(crowdProjection);
    pixelFoot.applyMatrix4(crowdProjection);
    return Math.hypot((pixelOther.x - pixelFoot.x) * cssHalfW, (pixelOther.y - pixelFoot.y) * cssHalfH);
  };
  /** Half the canvas's CSS size, read once a frame (`draw`). */
  let cssHalfW = 1, cssHalfH = 1;
  // A vehicle is tested with its own reach, grown by its height towards the
  // sun's side: an off-screen truck near the edge still casts a shadow onto it.
  const vehicleBounds = new Sphere(new Vector3(), 1);
  const vehicleVisible = (x: number, y: number, height: number, radius: number): boolean => {
    vehicleBounds.center.set(x, height + radius * 0.3, -y);
    vehicleBounds.radius = radius;
    return crowdFrustum.intersectsSphere(vehicleBounds);
  };
  scene.add(...agents.meshes);
  const signals: SignalHeads = createSignalHeads(scene, deckHeight);

  // Modular buildings: their own layer, behind their own gate (see
  // `render/buildings/layer.ts`), so a building edit never re-solves the roads.
  const buildings = createBuildingLayer();
  scene.add(buildings.group);
  // The town's meshes keep their arrays only until they are on the GPU
  // (`mesh/gpuOnly.ts`): a restored WebGL context, whose buffers three
  // uploads again, finds them filled again from their sources first - those
  // drawn, the road blocks kept for the next build and the buildings' cells
  // kept or put together ahead off the scene.
  renderer.domElement.addEventListener('webglcontextrestored', () => {
    refillArrays(scene);
    for (const { mesh } of surfaceReuse.chunks?.values() ?? []) refillArrays(mesh);
    buildings.refill();
  });
  /** The buildings' garden plants, and the buildings and ground they were planted for. */
  let gardens: Gardens | null = null;
  const coverKit = createGroundCoverKit();
  // The countryside's trees are hand-made models (`natureTrees.ts`), loaded
  // once; until they are, the procedural ones stand in. Busy (drawing) until
  // the first forest of them is built.
  let natureTreeKit: NatureTreeKit | null = null;
  /**
   * The plants and stones drawn cell by cell (`plantCells.ts`): the painted rocks and scrub, the
   * rivers' stones and the woods' card trees where the low-poly ones are not grown (`coverCells`); the
   * ecosystem's card trees in the same case (`natureCards`); and, once the models are in, the
   * ecosystem's trees, the painted woods' and the planted ones.
   */
  let coverCells: PlantCells | null = null;
  let natureCards: PlantCells | null = null;
  let natureForest: PlantCells | null = null;
  let paintedForest: PlantCells | null = null;
  let plantedForest: PlantCells | null = null;
  /** The trees the player planted, and which of them stand (`CandidateKeep`), for the trees' revision. */
  let plantedKeep: CandidateKeep<RoadDoc['trees'][number]> | null = null;
  let plantedFor = -1;
  let natureTreesPending = true;
  /** Whether the camera's pull in front of a building is still moving (`isoViewport.ts` `settle`): draw again. */
  let cameraEasing = false;
  /** The town's solids as filed for the camera, for the light shut out of the streets (`canyonLight.ts`). */
  let townSolids: (() => CameraSolids) | null = null;
  /**
   * The placements' two steps (`natureSweep`/`natureKeep`, `coverSweep`/
   * `coverKeep`): each sweep with the key it was made for, the inputs the
   * last keep read, and what it kept.
   */
  let natureSweepState: NatureSweep | null = null;
  /** The sweep being worked towards (its key), whether plates still wait for it, and a count of the sweeps the trees were kept from. */
  let natureSweepWant = '';
  let natureSweepPending = false;
  /** Which of the ecosystem's swept trees stand, kept tree by tree (`candidateKeep.ts`). */
  let natureKeep: CandidateKeep<Candidate> | null = null;
  let coverSweepState: CoverSweep | null = null;
  /** The rock colours and the card trees the cover cells were last drawn for: either moved, every cell drawn again. */
  let coverLook: { readonly geology: number; readonly standIns: boolean } | null = null;
  /** Which of the painted covers' and the rivers' places stand, kind by kind. */
  let coverKeeps: { readonly forest: CandidateKeep<Candidate>; readonly scrub: CandidateKeep<Candidate>; readonly rocks: CandidateKeep<Candidate>; readonly shore: CandidateKeep<ShoreCandidate> } | null = null;
  /**
   * What the plants' and stones' tests read, from the diary: a change there tests again only the places
   * it reached (`CandidateKeep.refresh`). `vegetationRedraw`: the trees' models came (or failed), every
   * kept place drawn again.
   */
  const vegetationRead = new JournalCursor(['roads', 'buildings', 'clearings', 'terrain', 'elevation', 'ground']);
  let vegetationRedraw = true;
  /** The network the keeps test against (`draw`'s). */
  let keepNet: Network | null = null;
  /** The elements laid with the brush (`elements.ts`): their models, loaded once, and the layer built for the map. */
  let elementKit: ElementKit | null = null;
  let elementLayer: ElementLayer | null = null;
  let elementsFor = '';
  void loadElementKit(anisotropy).then((kit) => { elementKit = kit; elementsFor = ''; }, (error: unknown) => {
    console.warn('[elements] models not loaded', error);
  });
  /**
   * The weather drawn (`world/weather.ts`): the rain, the lightning, how far
   * the wind has carried the clouds, and whether any of it moves.
   */
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
      // Its programs built before the first forest is drawn - its shadow's
      // too, wind-swayed (`uploads.ts` shadowStandIn): built by the first
      // shadow pass, they stopped the opening for 3 s (profile of
      // 2026-10-10). A loader hands an object to the frame once compiled.
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
  /** Where a cover was painted (the only paints that raise a density), by paint revision. */
  let forestAreaFor = -1;
  let forestArea: Rect | null = null;
  const forestAreaOf = (doc: RoadDoc): Rect | null => {
    if (forestAreaFor !== doc.paintRevision) {
      forestAreaFor = doc.paintRevision;
      forestArea = null;
      for (const dab of doc.terrainPaint) {
        if (isCoverKind(dab.kind)) forestArea = unionRect(forestArea, [dab.x - dab.radius, dab.y - dab.radius, dab.x + dab.radius, dab.y + dab.radius]);
      }
    }
    return forestArea;
  };
  // One representative per material and mesh program variant is enough for
  // compileAsync. Passing the whole scene compiled every repeated instance,
  // including objects hidden outside the view, during the first town frame.
  const compiledVariants = new WeakMap<Material, Set<string>>();
  let compileCheckedAt = 0;
  let compiling = false;
  /** The look for new materials in progress and their representative objects. */
  const scanStack: Object3D[] = [];
  const compileSamples: Object3D[] = [];
  const SCAN_PER_FRAME = 1500;
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
  // Room lights for the floors cut open: a fixed set, so switching them on and
  // off never changes the scene's light count (which recompiles every shader).
  const roomLights: PointLight[] = [];
  for (let i = 0; i < ROOM_LIGHTS; i++) {
    const light = new PointLight(0xffd6a0, 0, m(8), 2);
    light.name = 'room-light';
    light.castShadow = false;
    scene.add(light);
    roomLights.push(light);
  }
  let lampsKey = '';
  let tallestFor = -1;
  /** The sky's mesh (`environment.ts`), found once by name (`draw`). */
  let skyMesh: Object3D | null = null;
  let lastDark = -1;
  let tallestTop = 0;
  const tallestBox = new Box3();
  const viewDirection = new Vector3();
  /** The building revision the ground was last graded for. */
  let gradedFor = -1;
  /**
   * What the ground under the buildings is graded from (`buildingPads`): each
   * building's built footprints, its floor and its open lots - not its
   * storeys, its facades or its rooms. A storey added to a building re-graded
   * the ground of the whole town and re-planted every garden; now the ground
   * is graded again only when a site changed.
   */
  /** The ground the buildings were last graded on (frozen while a stroke is held). */
  let buildingGround = '';
  /**
   * Where and when the drawn ground changed: what stands on it is set again
   * only there (`groundChanges.ts`). Read from the document's diary - the
   * roads' heights solved again and the ground cut and filled, both written
   * there with their rectangles - not kept in a second record beside it.
   */
  let groundDiary: ChangeJournal | null = null;
  const GROUND_KINDS: readonly DerivedChangeKind[] = ['elevation', 'ground'];
  /** The serial of the latest change of the ground (not of the diary: a zone drawn is no change of the ground), and how far the diary was read for it. */
  let groundVersion = 0, groundScanned = 0;
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
  };
  /** The gardens' plants, building by building, on the ground they stand on (`gardenLists.ts`). */
  const plantLists = gardenLists(groundChanges, (b) => bankBox(b), (b) => gardenPlants([b], terrain.renderedHeightAt));
  /** Where the ground changed since a serial, from the same diary (`cameraSolids.ts` `GroundSince`). */
  const groundSince: GroundSince = {
    get version() { return groundChanges.version; },
    rectsSince(since) {
      const entries = groundDiary?.since(since, GROUND_KINDS);
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
  /**
   * The buildings' solids for the camera's eye (`world/buildings/cameraSolids.ts`): a building filed again when
   * the diary names it or the ground moved where its floor reads it. NOT its bank (`bankBox`, 40 m and more
   * round it): every site graded in a growing town floored again the dozens of buildings round it.
   */
  /**
   * Where the buildings or the ground under them changed since the canyon
   * light last asked (`canyonLight.ts`): the diary's rectangles; null when it
   * cannot say (a load, entries forgotten). DO NOT key the canyon on a
   * revision of the whole town again: it laid its whole window at every building.
   */
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
    // The ground moved under a building's floor (it reads the ground round it) lifts the whole building:
    // its rectangle grown by a building's reach.
    const grow = (r: ChangeRect, d: number): ChangeRect => [r[0] - d, r[1] - d, r[2] + d, r[3] + d];
    return entries.flatMap((e) => e.kind === 'buildings' ? e.rects! : e.rects!.map((r) => grow(r, CANYON_GROUND_REACH)));
  };
  const cameraSolidsKept = cameraSolidsKeeper((b) => floorHeight(b, builtGroundAt, pavedHeightAt), floorBox, FLOOR_READ_REACH);
  /**
   * The roads watched for vanishing from the picture (seen once, 2026-10-09:
   * a few seconds after a bomb the streets showed as grass, then came back;
   * not reproduced since). Once a second: the road meshes in the scene, and
   * the land drawn under a few road points never above their paving. Either
   * failing is written to the health log (F9) once, with the state of the
   * rebuild, so it is caught with its cause if it comes back.
   */
  let roadsWatchedAt = 0;
  let roadsWatchCursor = 0;
  let roadsReported = false;
  const watchRoads = (net: Network): void => {
    const now = performance.now();
    // Not while the world is being rebuilt: until the job lands the new roads
    // have no picture yet by design (a long rebuild had the first road drawn
    // reported missing every time).
    if (now - roadsWatchedAt < 1000 || !reveal.opened || net.doc.segments.size === 0 || worldJob !== null) return;
    roadsWatchedAt = now;
    let vertices = 0;
    roads?.group.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh && mesh.visible) vertices += mesh.geometry.getAttribute('position')?.count ?? 0;
    });
    let buried: { x: number; y: number; land: number; paved: number } | null = null;
    const ribbons = [...net.ribbons.values()];
    for (let k = 0; k < 4 && ribbons.length; k++) {
      const ribbon = ribbons[(roadsWatchCursor++) % ribbons.length]!;
      const p = ribbon.full.sampleAt(ribbon.full.length / 2).p;
      const paved = pavedHeightAt(p.x, p.y), land = terrain.renderedHeightAt(p.x, p.y);
      // Under the land on purpose in a tunnel.
      if (net.doc.segment(ribbon.id)?.structure === 'tunnel') continue;
      if (Number.isFinite(paved) && land > paved + m(0.3)) { buried = { x: p.x, y: p.y, land, paved }; break; }
    }
    const missing = !roads || !roads.group.parent || vertices === 0;
    if ((missing || buried) && !roadsReported) {
      roadsReported = true;
      console.error('roads missing from the picture', JSON.stringify({
        missing, buried, vertices, inWorld: !!roads?.group.parent, worldJob: worldJob !== null,
        terrainRevision: net.doc.terrainRevision, revision: net.revision,
      }));
    } else if (!missing && !buried) roadsReported = false;
  };
  /**
   * Cuts and fills the ground to the roads AND to the buildings: a level
   * platform under each building and a grassed bank round it. A road keeps the
   * ground it has claimed; a platform takes the rest.
   */
  /** Each building's platform, the town's, and the sites as last graded (`world/buildings/siteGrading.ts`). */
  const sitesGraded = siteGrading(builtGroundAt, pavedHeightAt, TERRAIN_CELL * 1.5, (b) => bankBox(b));
  /**
   * The box a building's bank reaches, once per record (records are never
   * changed in place): asked for every building in town by the layer's
   * ground test, the banks' area and the gardens on every building grown -
   * 1 300 boxes per building (audit M3a).
   */
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
  /**
   * The buildings whose bank a change of the ground after `serial` reached,
   * found by place (`buildings.near` over each change grown by the bank's
   * reach, then the bank's own box); null when the diary cannot say (the
   * whole map, or forgotten). DO NOT walk the town for it: every building's
   * bank was made again at each building grown, the town each frame of a
   * city's growth.
   */
  const buildingsOnGroundSince = (doc: RoadDoc, serial: number): Building[] | null => {
    const rects = groundSince.rectsSince(serial);
    if (!rects) return null;
    const out = new Map<BuildingId, Building>();
    for (const r of rects) {
      for (const b of doc.buildings.near(r[0] - BANK_REACH, r[1] - BANK_REACH, r[2] + BANK_REACH, r[3] + BANK_REACH)) {
        const box = bankBox(b);
        if (box[0] <= r[2] && box[2] >= r[0] && box[1] <= r[3] && box[3] >= r[1]) out.set(b.id, b);
      }
    }
    return [...out.values()];
  };
  /** The ground serial the buildings were last told of (`buildingGround`). */
  let buildingGroundSeen = -1;
  /**
   * Where two solves of the roads differ: the blocks of the map whose ground
   * the roads shape differently. A street drawn changes a few blocks; a road
   * whose reach spans the whole map changes every block, and the whole ground
   * is cut and filled again, as before.
   */
  const SHAPE_BLOCK = 160;
  /**
   * What a block of ground reads of a solve, digested: at each corner of the
   * terrain grid in it - the only points the ground has - the height and
   * weight the roads pull it to (`shapeAt`, against the natural ground there,
   * as `shapeToRoads` asks), and on a road the deck's own height and class,
   * which what stands on a deck reads. A cached result is reused when the
   * inputs its build reads are the same, and only then (Bazel's action
   * cache): the solve's per-area digest also read which profiles there were
   * and how their stations were numbered, so a street splitting an avenue
   * changed every block along it with no height there changing - 42 blocks
   * of the test town for a road of 50 m, 6 roads moved by up to 6 cm.
   * Heights to a thousandth of a unit, as the solve's own digest had them.
   */
  const groundRead = new WeakMap<RoadElevation, Map<number, number>>();
  const blockRead = (solve: RoadElevation, x0: number, y0: number): number => {
    let known = groundRead.get(solve);
    if (!known) groundRead.set(solve, known = new Map());
    const key = x0 * 65_536 + y0;
    const kept = known.get(key);
    if (kept !== undefined) return kept;
    const digest = new Digest();
    const quantum = (h: number): number => Math.round(h * 1000);
    for (let x = Math.ceil((x0 + TERRAIN_HALF) / TERRAIN_CELL) * TERRAIN_CELL - TERRAIN_HALF; x <= x0 + SHAPE_BLOCK; x += TERRAIN_CELL) {
      for (let y = Math.ceil((y0 + TERRAIN_HALF) / TERRAIN_CELL) * TERRAIN_CELL - TERRAIN_HALF; y <= y0 + SHAPE_BLOCK; y += TERRAIN_CELL) {
        const shaped = solve.shapeAt(x, y, terrain.naturalRenderedHeightAt(x, y));
        digest.add(quantum(shaped.height)).add(quantum(shaped.weight));
        const road = solve.roadAt(x, y);
        if (road.type >= 0 && Math.abs(road.across) <= road.half) digest.add(road.type).add(quantum(solve.at(x, y)));
        else digest.add(-1);
      }
    }
    const value = digest.value();
    known.set(key, value);
    return value;
  };
  const changedBlocks = (before: RoadElevation, after: RoadElevation): [number, number, number, number][] => {
    const out: [number, number, number, number][] = [];
    // Only blocks a road that differs reaches can differ (`differences`):
    // every block of the map used to be digested twice on every edit.
    const where = after.differences?.(before) ?? null;
    if (where && !where.length) return out;
    // Every plate's own blocks.
    for (const plate of MAP_REGIONS) {
      for (let x = plate.cx - plate.half; x < plate.cx + plate.half; x += SHAPE_BLOCK) {
        for (let y = plate.cy - plate.half; y < plate.cy + plate.half; y += SHAPE_BLOCK) {
          const x1 = x + SHAPE_BLOCK, y1 = y + SHAPE_BLOCK;
          if (where && !where.some((r) => r.minX <= x1 && r.maxX >= x && r.minY <= y1 && r.maxY >= y)) continue;
          if (blockRead(before, x, y) !== blockRead(after, x, y)) out.push([x, y, x1, y1]);
        }
      }
    }
    return out;
  };
  /** A terrain region (`terrainRegion`) back as the world box it covers, a cell round. */
  const regionRect = (region: TerrainRegion): Rect => terrain.rectOf(region);
  /** A world box as the terrain grid corners it covers. */
  const terrainRegion = (box: readonly [number, number, number, number]): TerrainRegion => terrain.regionOf(box);
  /**
   * `region`: a brush dab while the stroke is held - only the ground under it
   * is cut and filled again, against the platforms as they stood when the
   * stroke began; the rest waits for the stroke to end (`settle`).
   */
  /**
   * The ground cut and filled again only in `blocks` (the roads changed
   * there, the land did not): the platforms of the buildings whose banks
   * reach them are worked out again - their floors read the footway - and
   * every block is re-shaped on its own.
   */
  /**
   * `shapeBlocks` in steps (`worldSteps`): each touched building's platform on
   * its own, then the ground a few blocks at a time - in one go it was 60-150
   * ms of every road edit in the default town (docs/performance.md #10).
   */
  function* shapeBlocksSteps(net: Network, blocks: readonly [number, number, number, number][]): Generator<void, void, void> {
    // The buildings whose bank reaches a block the roads changed, found by place. DO NOT walk
    // `buildings.all()` for them, nor every building for a platform not known yet (`ensure`, a
    // building a step): the town twice for each road drawn; `rebuild` works out the platforms it lacks.
    const reached = new Map<BuildingId, Building>();
    for (const q of blocks) {
      for (const b of net.doc.buildings.near(q[0] - BANK_REACH, q[1] - BANK_REACH, q[2] + BANK_REACH, q[3] + BANK_REACH)) {
        const box = bankBox(b);
        if (box[0] <= q[2] && box[2] >= q[0] && box[1] <= q[3] && box[3] >= q[1]) reached.set(b.id, b);
      }
    }
    for (const b of reached.values()) {
      sitesGraded.refresh(b);
      yield;
    }
    gradedFor = net.doc.buildings.revision;
    // The sites that changed with the edit (a building the road razed) are
    // graded here too, in the slices, not in the edit's own frame.
    const sites = sitesGraded.changedSites(net.doc.buildings);
    sitesGraded.rebuild(net.doc.buildings);
    yield;
    // Each block in quarters, a quarter a step: a whole block was 18 ms of
    // terrain in one step, past the frame's allowance (`core/frameWork.ts`).
    const quarters = (q: readonly [number, number, number, number]): [number, number, number, number][] => {
      const mx = (q[0] + q[2]) / 2, my = (q[1] + q[3]) / 2;
      return [[q[0], q[1], mx, my], [mx, q[1], q[2], my], [q[0], my, mx, q[3]], [mx, my, q[2], q[3]]];
    };
    const regions = blocks.flatMap(quarters).map(terrainRegion);
    if (sites) regions.push(...sites.map(terrainRegion));
    // A block a step: three were 33 ms, past the frame's allowance (`core/frameWork.ts`).
    const BATCH = 1;
    let shaping = 0;
    for (let i = 0; i < regions.length; i += BATCH) {
      const at = performance.now();
      shapeGround(net, regions.slice(i, i + BATCH), false, true);
      shaping += performance.now() - at;
      yield;
    }
    derived(net, 'ground', regions.map(regionRect), 'chão cortado e aterrado até as vias', worldCause,
      { ms: shaping, detail: `${regions.length} regiões` });
  }


  const shapeGround = (net: Network, regions: TerrainRegion | readonly TerrainRegion[] | null = null, sites = false, padsReady = false): void => {
    const list: readonly TerrainRegion[] | null = regions === null ? null
      : typeof regions[0] === 'number' ? [regions as TerrainRegion] : regions as readonly TerrainRegion[];
    if (list && !list.length) return;
    const region = list;
    // The ground is cut and filled here, and only here: what stands on it reads
    // where from the diary - once per call; a road edit's quarter blocks are
    // written together when the last is shaped (`shapeBlocksSteps`).
    if (!padsReady) derived(net, 'ground', list ? list.map(regionRect) : null, sites ? 'chão dos lotes nivelado' : 'chão cortado e aterrado', net.doc.changes.version);
    const roads = net.doc.segments.size > 0 ? elevation : null;
    if (!padsReady && (!region || !sitesGraded.pads || sites)) {
      gradedFor = net.doc.buildings.revision;
      // The roads or the land moved: every platform is worked out afresh.
      if (!sites) sitesGraded.forget(net.doc.buildings);
      sitesGraded.rebuild(net.doc.buildings);
    }
    const pads = net.doc.buildings.size > 0 ? sitesGraded.pads : null;
    if (!pads) {
      terrain.shapeToRoads(roads, region);
      return;
    }
    terrain.shapeToRoads({
      shapeBounds: () => [...(roads?.shapeBounds() ?? []), ...pads.shapeBounds()],
      shapeAt(x, y, ground) {
        const road = roads ? roads.shapeAt(x, y, ground) : { height: ground, weight: 0 };
        const pad = pads.shapeAt(x, y, ground);
        if (pad.weight <= 0) return road;
        if (road.weight <= 0) return pad;
        return { height: pad.height + (road.height - pad.height) * road.weight, weight: 1 };
      },
    }, region);
  };

  /** `doc.utilityRevision` the poles and the furniture were last brought up to. */
  let utilityRevision = -1;
  /** What moves a pole or its parts: the poles and wires, the roads (its kerb), the roads' heights and the ground under it. */
  const POLE_KINDS: readonly ChangeKind[] = ['utilities', 'roads', 'elevation', 'ground', 'terrain'];
  /** The diary's serial of `POLE_KINDS` the pole layer was brought up to. */
  let poleSerial = -1;
  /**
   * The pole layer brought up to the diary (`poleLayer.ts`): the poles in
   * the rectangles of the utilities written since, and those a road, its
   * heights or the ground moved within `POLE_REACH` of, placed again with
   * their neighbours and wires; nothing else is touched. A change of the
   * whole map (a load, the whole ground shaped) builds the layer whole.
   * `groundAt` is the ground the world is being put in place on.
   */
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
  /**
   * The poles and the placed things, outside a world being built: a pole
   * edit moves only `doc.utilityRevision` (see `RoadDoc`), the ground the
   * buildings are graded on only the diary's `ground`.
   */
  const rebuildUtilities = (net: Network): void => {
    if (!elevation) return;
    utilityRevision = net.doc.utilityRevision;
    const at = performance.now();
    syncUtilities(net, poleGroundAt(elevation, terrain.renderedHeightAt, net));
    performance.measure('hitch:utilities/poles', { start: at, end: performance.now() });
  };

  /** The city's clock, read each frame: the planted trees and shrubs grow with it (`plantGrowth`). */
  let cityMinutes = Number.NaN;
  /**
   * The street furniture and the signs brought up to the diary, once the
   * world stands (`draw`): the furniture item by item (`streetFurnitureLayer.ts`,
   * nothing done when nothing it reads changed), its growing plants once a
   * city hour. NOT a rebuild of every placed thing of the map at each
   * landscaping edit, at each road edit reaching one, and each hour a tree
   * grew (`rebuildFurniture`, `growPlants`, removed).
   */
  /**
   * The world the placed things stand on, once it stands (`draw`): what the engine's 'draw' phase
   * reads. The furniture and the signs are products of the engine (`core/engine.ts`), brought up to
   * the diary there, their work in its ledger.
   */
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
    // Only the signs whose ground a change reached (`signLayer.ts`). DO NOT build every sign of the
    // map again on a serial of the roads, the land or the landscaping: every edit anywhere did.
    refresh: (): number => {
      if (!placedOn || !elevation) return 0;
      if (!signs.group.parent) world.add(signs.group);
      return signs.sync(placedOn, elevation);
    },
  }, 'draw');

  engine.register({
    name: 'barriers',
    // Walls, fences and hedges: only those the diary says changed, or whose ground moved (`barriers.ts`).
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
    // Tracks, stations and stops: only those the diary says changed, or whose ground, roads or buildings did
    // (`transit.ts`). DO NOT build the whole transport again on its revision or the ground under it.
    refresh: (): number => {
      const net = placedOn;
      if (!net) return 0;
      if (!transit.group.parent) { world.add(transit.group); transit.setXray(transitXray); }
      const before = transit.triangles;
      // A metro entrance stands off the streets and out of the buildings: the buildings at the point only
      // (`BuildingStore.near`).
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

  /** Blocks whose ground a dropped rebuild had not shaped yet (`null`: the whole map). */
  let pendingBlocks: [number, number, number, number][] | null = [];
  /**
   * The land a brush moved since the world was last built (`'all'`: anywhere -
   * an undo, a map loaded, several stamps at once): the dirty region of the
   * heightmap (Unity `TerrainData.DirtyHeightmapRegion`, synced once at the
   * edit's end). A stroke's end rebuilt the whole map's ground and every road
   * tile in one frame (479-520 ms); its own box is all that moved.
   */
  let landDirty: Rect | 'all' | null = null;
  /** The shaping blocks a world box reaches, on the grid `changedBlocks` uses. */
  const blocksOver = (box: Rect): [number, number, number, number][] => {
    const out: [number, number, number, number][] = [];
    for (const plate of MAP_REGIONS) {
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
      // A world being built builds the poles too (`worldSteps`): built here as
      // well, every road drawn made the poles and the furniture of the whole
      // map twice, the second time in one frame (52-63 ms on the player's map).
      if (worldJob === null && (utilityRevision !== net.doc.utilityRevision || poleSerial !== net.doc.changes.serialOf(...POLE_KINDS))) {
        const atUtilities = performance.now();
        rebuildUtilities(net);
        performance.measure('hitch:road-edit/utilities alone', { start: atUtilities, end: performance.now() });
      }
      return;
    }
    buildWorld(net);
  };
  /**
   * The roads' heights solved again and the world's rebuild started (`worldSteps`).
   * @rebuild Called by `rebuildWorld` when the roads' or the land's revision moved.
   */
  const buildWorld = (net: Network): void => {
    const started = performance.now();
    // Only the roads changed (the land did not): the ground is cut and filled
    // again only where the solve of the roads differs.
    const landStill = terrainRevision === net.doc.terrainRevision && elevation !== null;
    const previousElevation = elevation;
    networkRevision = net.revision;
    terrainRevision = net.doc.terrainRevision;

    // ONE solve for the whole network, shared by every consumer below. Solving
    // it per structure, or per band, is how two surfaces came to disagree about
    // where the same junction was.
    //
    // Against the NATURAL ground, never the shaped one: the terrain is about to
    // be cut and filled to meet these roads, and feeding the next solve its own
    // previous answer would let the two drift a little further apart on every
    // rebuild.
    // Solved already by the edit, on this network and this land (`offerElevation`).
    const offered = offeredElevation;
    offeredElevation = null;
    elevation = offered && offered.revision === net.revision && offered.terrain === terrainRevision
      ? offered.elevation
      // On land that has not moved, from the last solve: only the connected
      // pieces of the network the edit changed are solved again
      // (`buildRoadElevation`, docs/VIAS.md V0).
      : buildRoadElevation(net, builtGroundAt, landStill ? previousElevation : null);
    performance.measure('hitch:road-edit/elevation', { start: started, end: performance.now() });
    // Now the ground comes to meet the roads: embankments and cuttings instead
    // of the vertical face the verge skirt used to hang off its own edge, and —
    // from the same rule, where a road is buried deeply enough — tunnels.
    // Only the blocks its solve changed, with those a dropped rebuild left.
    // (`padsCache` used to be required here too: on a map with no buildings
    // it is always null, so every street drawn there re-shaped the whole map.)
    // A brush stroke: the blocks of the land it moved, with those where the
    // roads' solve differs (a road over that land rose or fell with it). Out
    // of the stroke's box the natural ground is the same, so the comparison
    // of the two solves there still holds.
    const land = landDirty;
    landDirty = null;
    const landBlocks = !landStill && land !== null && land !== 'all' ? blocksOver(land) : null;
    let changed: [number, number, number, number][] | null = null;
    const atBlocks = performance.now();
    if (previousElevation && (landStill || landBlocks)) {
      changed = changedBlocks(previousElevation, elevation);
      if (landBlocks) {
        const seen = new Set(changed.map((b) => `${b[0]},${b[1]}`));
        for (const b of landBlocks) if (!seen.has(`${b[0]},${b[1]}`)) changed.push(b);
      }
    }
    performance.measure('hitch:road-edit/changed blocks', { start: atBlocks, end: performance.now() });
    // In the diary: the roads' heights solved again where they differ, after the edit that moved them.
    worldCause = derived(net, 'elevation', changed, 'alturas das vias resolvidas', net.doc.changes.version,
      { ms: performance.now() - started, detail: changed ? `${changed.length} blocos de ${SHAPE_BLOCK} u` : 'mapa inteiro' }) || net.doc.changes.version;
    const blocks = changed && pendingBlocks ? [...pendingBlocks, ...changed] : null;
    // The roads' own heights (the footway, the carriageway) moved where the
    // solve did: the 'elevation' entry just written is what the things on the
    // ground read (`groundChanges`).
    const local = blocks !== null && blocks.length * SHAPE_BLOCK * SHAPE_BLOCK < MAP_SIZE * MAP_SIZE * 0.25;
    pendingBlocks = local ? blocks : null;
    // The land itself changed: at once. After a road edit, and for the first
    // world when the game opens: a few milliseconds a frame (`pumpWorld`) -
    // built in the frame of the edit, it was a stall of 100-500 ms on every
    // road drawn in the default town (docs/performance.md #10), and the
    // opening drew nothing until the whole town was built in one frame. The
    // world as it was (at the opening, the bare land) stays drawn until the
    // new one is complete. A job an edit overtakes is dropped.
    // A map being opened is built behind its curtain, in slices too: the
    // old world is not drawn meanwhile, nothing is (`beginLoad`).
    // A change of much of the map while the game is open (a generated city, a map opened over another)
    // is sliced too, its tiles shaped by the workers (`roadTilePool.ts`). DO NOT build it in one go: the
    // roads of a generated city were built in the frame of the change, on the page, and the workers never
    // ran (2026-10-15).
    worldJob = worldSteps(net, local ? blocks : null, started, true);
    worldJobFresh = true;
  };

  /**
   * What `worldSteps` builds before it is put in place at once. `sliced`: run
   * a slice a frame (`pumpWorld`), so it may wait for its shaders.
   * @rebuild Started by `buildWorld`; its slices run only while a rebuild is in progress.
   */
  function* worldSteps(net: Network, blocks: [number, number, number, number][] | null, started: number, sliced: boolean): Generator<'wait' | void, void, void> {
    const solve = elevation!;
    if (blocks === null) shapeGround(net);
    else if (blocks.length || gradedFor !== net.doc.buildings.revision) yield* shapeBlocksSteps(net, blocks);
    pendingBlocks = [];
    yield;
    // The tiles kept from the last session, read while the game started: a
    // sliced build waits for them a little (never an edit's frame spinning).
    if (sliced && !storedRead) {
      const since = performance.now();
      while (!storedRead && performance.now() - since < KEPT_TILES_WAIT_MS) yield 'wait';
    }
    // Sliced, the tiles are shaped by the workers while the frames go on (`roadTilePool.ts`); built in
    // one go (an edit's frame), on the page: nothing there may wait.
    const freshRoads = yield* roadSurfaceSteps(net, solve, materials, terrain.renderedHeightAt, surfaceReuse, terrain.vergeMaterial,
      sliced ? roadTiles : null);
    keepTiles();
    derived(net, 'surfaces', freshRoads.rebuilt, 'superfícies das vias refeitas', worldCause,
      { ms: freshRoads.workMs, detail: `${freshRoads.built} tiles feitos, ${freshRoads.reused} aproveitados` });
    // The structures' details, the poles and the street furniture are each
    // kept as they are when the edit's blocks reach none of their own things
    // (their heights, ground and kerbs moved only there) and, for the
    // structures, when the edit raised or buried no road of its own: a street
    // drawn anywhere built every viaduct, pole and bench of the map again
    // (docs/performance.md #13).
    // Only the cells of structures the edit reached (`structureCells.ts`), not every viaduct of the map.
    const atdetails = performance.now();
    details ??= createStructureCells(materials, terrain.vergeMaterial);
    const freshDetails = details.prepare(net, solve, terrain.renderedHeightAt, blocks);
    performance.measure('hitch:road-edit/details', { start: atdetails, end: performance.now() });
    yield;
    // The overhead utility network. It is drawn from the document directly
    // rather than from the Network, because a pole line is not derived from
    // the roads - it can be drawn across open ground with no road near it.
    //
    // But a pole that IS beside a road stands on the FOOTWAY, not on the
    // ground beside it. The terrain is shaped to meet the road, so the two
    // differ only by the kerb - and a pole sunk 0.36 into the pavement it is
    // meant to stand on is exactly the "poles do not sit on the footway"
    // complaint. The lamp columns in `scenery.ts` already do this; the poles
    // were the one piece of street furniture reading the bare ground.
    // The poles' revision this world is built at: one that moves after this
    // step is brought up when the world is in place.
    const utilityBuilt = net.doc.utilityRevision;
    yield;

    // The new pieces' shaders compiled before they are drawn - in parallel
    // where the driver can (`compileAhead`, KHR_parallel_shader_compile) - and
    // the swap waits for them, as an engine holds a draw until its pipeline
    // state is ready (Unreal's PSO precaching): drawn first, each new program
    // stopped its frame while the driver built it.
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

    // Everything in place at once: the world as it was goes - only what is
    // replaced here. `world.clear()` used to empty the whole group, and the
    // walls, the transport, the gardens and the forest (in it too, rebuilt only
    // where the ground changes under them) vanished after a road edit.
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

  /**
   * The road shaders compiled before the first road is drawn. Each material
   * compiles its program the first time something uses it, and that is a
   * stall of the frame it happens in - the first road on an empty map froze
   * the game for most of a second (the profile of 2026-10-05: 0.8 s in
   * `getProgramInfoLog`). Engines warm their shaders ahead for this (three's
   * `compileAsync`, with KHR_parallel_shader_compile; Unreal's PSO cache):
   * a small junction is built off-screen with the very builders and shared
   * materials of `rebuildWorld`, compiled in the background, and thrown away.
   */
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
      void compileAhead(group).then(() => {
        for (const part of parts) part.dispose();
      });
    } catch (error) {
      console.warn('road shader warm-up skipped', error);
    }
  };

  /**
   * The shaders a blow first needs - a broken building's pieces (its kit's
   * materials on plain meshes), the explosion's debris, soot, fire and spray -
   * compiled ahead, in the background: compiled when the first blow landed,
   * they stalled that frame for most of a second.
   */
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
    const mats = [...Object.values(kit.shell), ...Object.values(kit.material), kit.furniture().material, kit.massing];
    for (const mat of mats) {
      const mesh = new Mesh(tiny, mat);
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
      group.add(mesh);
    }
    // In the scene for its lights, but never drawn: drawn before the parallel
    // compile was done, each of these meshes stalled its frame waiting for
    // its program (3.4 s of stalls on an empty map, the profile of
    // 2026-10-05) - the very stall the warm-up is for. `compile` reads hidden
    // objects too.
    group.visible = false;
    scene.add(group);
    void compileAhead(group).then(() => { scene.remove(group); tiny.dispose(); });
    // And every part as the layer draws it, instanced, with its shadow
    // (`partWarmMeshes`): made only when a near cell has some, each compiled
    // in the frame it first showed - stalls in the middle of a pan.
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

  /**
   * The tools' previews compiled ahead, as the roads' and the blows' are (a
   * pipeline cache, Unreal's PSO precaching: what may be drawn is compiled in
   * the background before it is): the building ghost, the track being laid,
   * the lots overlay each built their programs in the frame a tool first
   * showed them - a stall on the first use of each tool.
   */
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
        // And as a building grown on a lot draws it: its window panes carry
        // their rooms' light slots (an attribute of their own), a program
        // the preview never builds - compiled in the frame of the first
        // building grown on a painted lot.
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

  const applyQuality = (level: QualityLevel): void => {
    quality = QUALITY[level];
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
    // NO world rebuild here: nothing the world's build makes reads the tier
    // (the woods' density is in the nature sweep's key). DO NOT force one with
    // `networkRevision = -1`: every change of the tier built the whole map's
    // roads, ground and structures again for the scenery that read it, an
    // empty grass field (`buildScenery`, removed).
    // A new tier redraws the shadow map whatever the frame would have said.
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
  }
  resize();

  const target = new Vector3();
  let fps = 60;
  /** Wall-clock seconds, for the wind; independent of the simulation speed. */
  let windClock = 0;
  let lastWidth = 0;
  let lastHeight = 0;

  // Development only: the production build replaces the flag with false and
  // drops the inspector with it.
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
  const shadowCentre = new Vector3();
  /**
   * The trees of the painted forest (`world/terrainPaint.ts` 'forest'): one
   * candidate a cell of FOREST_SPACING under the painted area, jittered by a
   * hash of the cell so a stroke elsewhere never moves them, kept with the
   * odds the painted density gives; never on a road, a footway or a building.
   * A low bush of the understorey with some. Species, height and spread from
   * the same hash. Low-poly trees (`groundCover.ts`, 33 to 72 triangles): the
   * garden trees they replace were 1 700 with their leaf cards.
   */
  // A tree every twelve metres at the most where a wood is painted: the
  // player wants few trees, not woods filling the map (2026-10-08).
  const FOREST_SPACING = m(12);
  /** A cell's hash in 0..1: the same wherever a placement asks it, so an edit elsewhere never moves a plant. */
  const cellHash = (a: number, b: number, salt: number): number => {
    let h = Math.imul(a | 0, 374_761_393) ^ Math.imul(b | 0, 668_265_263) ^ Math.imul(salt, 2_246_822_519);
    h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
    return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
  };
  /**
   * PLACEMENTS IN TWO STEPS (a dirty flag per input, Nystrom's "Dirty Flag":
   * one coarse flag reprocesses what did not change). The SWEEP finds where a
   * plant or a stone may stand - from the land, the paint, the water and the
   * ecosystem, over the whole map or the painted area - and is done again
   * only when those change. The KEEP is a pass over what the sweep found:
   * clear of the roads, the buildings and the clearings, on the ground as it
   * is drawn. A road, a building, a town growing or ageing moves only the
   * keep; the sweep and the forests' meshes were made again on each of them.
   */
  interface Candidate {
    readonly x: number;
    readonly y: number;
    readonly size: number;
    readonly yaw: number;
    readonly seed: number;
    readonly species: ForestSpecies;
  }
  /** A stone of a river's bed or bank: kept by its height over the water, read on the ground as drawn. */
  interface ShoreCandidate extends Candidate {
    readonly level: number;
    /** Its cell's draw against the odds of its height over the water. */
    readonly draw: number;
  }
  /**
   * Low scrub (`world/terrainPaint.ts` 'scrub'): close-set low-poly bushes of
   * a metre to two and a half, no trees - the mata baixa of a hillside or a
   * field gone wild. One candidate a cell of SCRUB_SPACING kept by the root
   * of the painted density (one ordinary stroke already makes a thicket) and
   * clumped by a slow noise into thickets and clearings; never on a road or
   * under a building.
   */
  const SCRUB_SPACING = m(2.4);
  /** The cell ranges [i0, i1, j0, j1] of a grid of `spacing` that the painted covers reach, one a plate; none when nothing is painted. */
  const paintedCells = (doc: RoadDoc, spacing: number): [number, number, number, number][] => {
    const area = forestAreaOf(doc);
    if (!area) return [];
    // On one lattice anchored at the first plate's corner, within each plate
    // the painting reaches.
    const out: [number, number, number, number][] = [];
    for (const plate of MAP_REGIONS) {
      const first = Math.ceil((plate.cx - plate.half + TERRAIN_HALF) / spacing);
      const last = Math.floor((plate.cx + plate.half + TERRAIN_HALF) / spacing) - 1;
      const firstY = Math.ceil((plate.cy - plate.half + TERRAIN_HALF) / spacing);
      const lastY = Math.floor((plate.cy + plate.half + TERRAIN_HALF) / spacing) - 1;
      const i0 = Math.max(first, Math.floor((area[0] + TERRAIN_HALF) / spacing)), i1 = Math.min(last, Math.floor((area[2] + TERRAIN_HALF) / spacing));
      const j0 = Math.max(firstY, Math.floor((area[1] + TERRAIN_HALF) / spacing)), j1 = Math.min(lastY, Math.floor((area[3] + TERRAIN_HALF) / spacing));
      if (i0 <= i1 && j0 <= j1) out.push([i0, i1, j0, j1]);
    }
    return out;
  };
  /** -1..1 value noise of about 25 m: where scrub gathers into thickets. */
  const scrubClump = (x: number, y: number): number => {
    const s = m(25);
    const gx = x / s, gy = y / s;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const fx = gx - x0, fy = gy - y0;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const h = (a: number, b: number): number => {
      let v = Math.imul(a, 374_761_393) ^ Math.imul(b, 668_265_263) ^ 0x51b;
      v = Math.imul(v ^ (v >>> 13), 1_274_126_177);
      return ((v ^ (v >>> 16)) >>> 0) / 2_147_483_648 - 1;
    };
    const top = h(x0, y0) + (h(x0 + 1, y0) - h(x0, y0)) * sx;
    const bottom = h(x0, y0 + 1) + (h(x0 + 1, y0 + 1) - h(x0, y0 + 1)) * sx;
    return top + (bottom - top) * sy;
  };
  /**
   * What grows of itself on a map with an ecosystem (`world/ecology.ts`):
   * trees and bushes from the field's densities, gathered by a slow noise
   * into copses and thickets with open grass between, as Horizon Zero Dawn
   * places its plants from density maps (Guerrilla, "GPU-Based Procedural
   * Placement"). One candidate a cell of NATURE_SPACING, jittered by a hash
   * of the cell so an edit elsewhere never moves a plant; the odds scaled so
   * the whole map stays within its budget; never in water, on a cliff, a
   * road, a footway or under a building. The low-poly trees and bushes of
   * the painted covers (`groundCover.ts`, under 130 triangles each).
   */
  const NATURE_SPACING = WOODS_SPACING;
  /**
   * Trees the ecosystem grows at full vegetation quality (the forests take
   * most). Few: the woods were 26 000 trees filling the countryside, and the
   * player asked for few (2026-10-08) - the masses stay, thinned evenly.
   */
  const NATURE_TREES = 2_500;
  /** The ecosystem's sweep: where a tree may grow, the budget the tier allows, and the room a forest of them needs. */
  interface NatureSweep {
    readonly key: string;
    readonly trees: readonly Candidate[];
    readonly budget: number;
    room: number[] | null;
    /** Plates left to sweep (one is swept a frame): the sweep runs again next frame while any is. */
    readonly pending?: number;
    /** Each plate's run of `trees` (kept plate by plate, `natureKeep`). */
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
  /**
   * Each plate's land, as a serial moved only when a change of the terrain reached that plate (the
   * diary's 'terrain' rectangles), and the latest serial: what a plate's sweep reads of the land. DO NOT
   * key every plate's sweep on the document's terrain revision: a dab of the brush anywhere swept every
   * plate of the map again (some 35 ms a plate).
   */
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
    // One plate's density swept a frame at most while the game is seen (each
    // was some 35 ms): a plate the view brings in grows its trees a frame or
    // two after it, never all the plates' sweeps in one frame (profiled
    // 2026-10-11). Behind the opening's curtain, as many as its slice holds:
    // there is no frame to keep smooth, and the town is shown only once its
    // trees are in (`RevealGate`) - one a frame held the curtain for seconds.
    let sweptNew = false, pending = 0;
    const sweepFrom = performance.now();
    // THE TREE MAP, as Horizon Zero Dawn's Placement_Trees (Guerrilla, GDC
    // 2017): one density per place, decoded by a curve into bands - the
    // inner forest, its edge, scattered trees - and below them open
    // ground. Woods gather in masses and the open country stays open, as in
    // the diorama the player holds up (2026-10-07); evenly scattered single
    // trees read as confetti over the whole map. The density: the
    // ecosystem's canopy and trees, broad patches of a slow noise, and the
    // slopes and valleys (woods hold the hillsides; the plains are the
    // fields a town is built on).
    // Plate by plate, each read in its own coordinates; the lattice's cells numbered over the whole
    // world, so no two plates grow the same wood.
    const cells = Math.floor((TERRAIN_HALF * 2) / NATURE_SPACING);
    const plates: NaturePlate[] = [];
    let treeSum = 0;
    const d = WOODS_SLOPE_STEP;
    // What a plate's density reads besides its own ecology: its own land (`plateLand`) and the
    // vegetation setting.
    const vegetation = quality.vegetation;
    for (const part of terrain.parts) {
      const field = part.surface.ecology();
      if (!field) continue;
      // Kept from the last sweep while its own ecology and the land are as
      // they were: every plate brought in full or let go swept all the others
      // again (half a second over a camera's turn).
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
      // The land's own slope, before the roads cut and fill it: a wood
      // holds a hillside, not the bank of a street (and a street drawn no
      // longer moves the woods round it).
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
            // The patches drawn out to clear masses: woods on the plains too, as
            // capões, and clean meadows between them.
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
    // As many plates' budgets as the plates in full cover, the woods as thick
    // on each: the budget shared by area. Only the plates kept in full are
    // swept (`flatAtlas.ts`): a sum over the few plates made them denser the
    // closer the view, and one budget over nine plates spent it all on the
    // first plates swept, the last bare (2026-10-10, 2026-10-11).
    const plateArea = (2 * TERRAIN_HALF) ** 2;
    const base = NATURE_TREES * Math.min(1, quality.vegetation / 2_600);
    const budget = base * Math.max(1, (plates.length * plateArea) / m(1_920) ** 2);
    const plannedSum = (treeSum / Math.max(1, plates.length)) * (m(1_920) ** 2 / plateArea);
    // In steps of 2 %: a plate brought in nudges the average, and every
    // plate's trees were picked again for a change no eye can see.
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
          // Tall in the heart of a wood, crowns meeting into one canopy;
          // lower at its edge; short and crooked out in the open.
          const inner = band[o] === 3, edge = band[o] === 2;
          const h = inner ? m(11) + m(8) * cellHash(gi, gj, 45) : edge ? m(8) + m(6) * cellHash(gi, gj, 45) : m(5.5) + m(4) * cellHash(gi, gj, 45);
          const roll = cellHash(gi, gj, 46);
          const species = inner ? (roll < 0.6 ? 'broadleafTall' : 'broadleaf') : roll < 0.25 ? 'broadleafTall' : 'broadleaf';
          // Which of the low-poly trees (`natureTrees.ts`): oaks and cypresses
          // most, a palm now and then out in the open.
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
  /**
   * The clearings' index (`world/trees.ts` clearingIndex), made again only when
   * the clearings changed: it reads nothing else. DO NOT make it at every keep -
   * a keep runs at every road, building and terrain edit (its key), and made
   * the index of every clearing of the map again each time.
   */
  let clearingsFor = -1;
  let clearingsDoc: RoadDoc | null = null;
  let clearings: ((x: number, y: number) => boolean) | null = null;
  const clearingsOf = (doc: RoadDoc): ((x: number, y: number) => boolean) => {
    if (!clearings || clearingsDoc !== doc || clearingsFor !== doc.clearingRevision) {
      clearingsDoc = doc;
      clearingsFor = doc.clearingRevision;
      clearings = clearingIndex(doc.treeClearings);
    }
    return clearings;
  };
  /** Water, a cliff, a road or a building: nothing of the ecosystem grows there. */
  const natureOpen = (net: Network, x: number, y: number, z: number): boolean => {
    const plate = regionAt(x, y);
    if (Math.abs(x - plate.cx) > plate.half - m(2) || Math.abs(y - plate.cy) > plate.half - m(2)) return false;
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
  /**
   * The stones: where rocks were painted, one candidate a cell of
   * ROCK_SPACING kept by the density (boulders of half a metre to two and a
   * half), and along every body of water - in the shallows, on the line and
   * up the bank - a scatter of smaller stones, as a river bed and its banks
   * have. Never on a road or under a building.
   */
  const ROCK_SPACING = m(3.2);
  const RIVER_ROCK_SPACING = m(3);
  /** The painted covers' and the rivers' sweep (`coverSweep`): where each kind may stand. */
  interface CoverSweep {
    readonly key: string;
    /** The painted woods' trees. */
    readonly forest: readonly Candidate[];
    readonly scrub: readonly Candidate[];
    /** Painted stones, then the rivers' (kept in that order, under one cap). */
    readonly rocks: readonly Candidate[];
    readonly shore: readonly ShoreCandidate[];
    room: number[] | null;
  }
  const coverSweep = (doc: RoadDoc, key: string): CoverSweep => {
    // The trees of the painted forest (`world/terrainPaint.ts` 'forest').
    const forest: Candidate[] = [];
    {
      for (const [i0, i1, j0, j1] of paintedCells(doc, FOREST_SPACING)) for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const cx = -TERRAIN_HALF + (i + 0.5) * FOREST_SPACING, cy = -TERRAIN_HALF + (j + 0.5) * FOREST_SPACING;
          const density = terrain.forestAt(cx, cy);
          if (density < 0.04 || cellHash(i, j, 1) > density * 0.92) continue;
          const x = cx + (cellHash(i, j, 2) - 0.5) * FOREST_SPACING * 0.9, y = cy + (cellHash(i, j, 3) - 0.5) * FOREST_SPACING * 0.9;
          const h = m(10) + m(8) * cellHash(i, j, 4) * (0.6 + 0.4 * density);
          // A wood is green: broadleaf with some conifers. No ipê (its crown a
          // bare block, no leaves) and no blob bushes under the trees (the
          // player, 2026-10-07: "árvore feia", "cocozinhos").
          const roll = cellHash(i, j, 13);
          const species = roll < 0.45 ? 'broadleaf' : roll < 0.82 ? 'broadleafTall' : 'conifer';
          const kind = roll < 0.5 ? 'oak' : roll < 0.9 ? 'cypress' : 'palm';
          forest.push({ x, y, size: h, yaw: cellHash(i, j, 5) * Math.PI * 2, seed: seedOfKind(kind, cellHash(i, j, 6)), species });
        }
      }
    }
    // Low scrub ('scrub'). Only the cells under the painted covers: the whole
    // map's grid was some 640 000 cells and stalled every dab of a stroke.
    const scrub: Candidate[] = [];
    {
      for (const [i0, i1, j0, j1] of paintedCells(doc, SCRUB_SPACING)) for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const cx = -TERRAIN_HALF + (i + 0.5) * SCRUB_SPACING, cy = -TERRAIN_HALF + (j + 0.5) * SCRUB_SPACING;
          const density = terrain.coverAt('scrub', cx, cy);
          if (density < 0.04) continue;
          const clump = 0.35 + 0.65 * Math.max(0, Math.min(1, (scrubClump(cx, cy) + 0.15) * 1.6));
          if (cellHash(i, j, 21) > Math.sqrt(density) * clump) continue;
          const x = cx + (cellHash(i, j, 22) - 0.5) * SCRUB_SPACING * 0.95, y = cy + (cellHash(i, j, 23) - 0.5) * SCRUB_SPACING * 0.95;
          scrub.push({ x, y, size: m(1.5) + m(2) * cellHash(i, j, 24) * clump, yaw: cellHash(i, j, 26) * Math.PI * 2, seed: cellHash(i, j, 27), species: 'broadleaf' });
        }
      }
    }
    // The painted stones ('rocks').
    const rocks: Candidate[] = [];
    {
      for (const [i0, i1, j0, j1] of paintedCells(doc, ROCK_SPACING)) for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const cx = -TERRAIN_HALF + (i + 0.5) * ROCK_SPACING, cy = -TERRAIN_HALF + (j + 0.5) * ROCK_SPACING;
          const density = terrain.coverAt('rocks', cx, cy);
          if (density < 0.04 || cellHash(i, j, 41) > Math.sqrt(density) * 0.7) continue;
          const x = cx + (cellHash(i, j, 42) - 0.5) * ROCK_SPACING * 0.9, y = cy + (cellHash(i, j, 43) - 0.5) * ROCK_SPACING * 0.9;
          // Mostly modest stones, now and then a big boulder.
          const roll = cellHash(i, j, 44);
          const size = roll > 0.88 ? m(2.2) + m(2) * cellHash(i, j, 45) : m(0.6) + m(1.5) * roll;
          rocks.push({ x, y, size, yaw: cellHash(i, j, 46) * Math.PI * 2, seed: cellHash(i, j, 47), species: 'broadleaf' });
        }
      }
    }
    // Along every body of water - in the shallows, on the line and up the
    // bank - the places a stone may lie: kept by their height over the water.
    const shore: ShoreCandidate[] = [];
    const water = terrain.waterArea();
    if (water) {
      const reach = m(12);
      const i0 = Math.floor((water.minX - reach + TERRAIN_HALF) / RIVER_ROCK_SPACING), i1 = Math.ceil((water.maxX + reach + TERRAIN_HALF) / RIVER_ROCK_SPACING);
      const j0 = Math.floor((water.minY - reach + TERRAIN_HALF) / RIVER_ROCK_SPACING), j1 = Math.ceil((water.maxY + reach + TERRAIN_HALF) / RIVER_ROCK_SPACING);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const x = -TERRAIN_HALF + (i + cellHash(i, j, 51)) * RIVER_ROCK_SPACING, y = -TERRAIN_HALF + (j + cellHash(i, j, 52)) * RIVER_ROCK_SPACING;
          const level = terrain.shoreLevelAt(x, y);
          if (level === null) continue;
          const size = m(0.6) + m(1.6) * cellHash(i, j, 54) ** 1.6;
          shore.push({ x, y, level, draw: cellHash(i, j, 53), size, yaw: cellHash(i, j, 55) * Math.PI * 2, seed: cellHash(i, j, 56), species: 'broadleaf' });
        }
      }
    }
    return { key, forest, scrub, rocks, shore, room: null };
  };
  /** A cover's place: never on a road or under a building. */
  const coverFree = (x: number, y: number): boolean => !onCarriageway(keepNet!, { x, y }) && !buildings.covers(x, y);
  /** The keeps of a cover sweep, kind by kind: the woods out of the clearings, a river's stone by its height over the water. */
  const coverKeepsOf = (sweep: CoverSweep): NonNullable<typeof coverKeeps> => {
    const plain = (c: Candidate): number | null => (coverFree(c.x, c.y) ? terrain.renderedHeightAt(c.x, c.y) : null);
    return {
      forest: new CandidateKeep(sweep.forest, (c) => (coverFree(c.x, c.y) && !clearingsOf(keepNet!.doc)(c.x, c.y) ? terrain.renderedHeightAt(c.x, c.y) : null)),
      scrub: new CandidateKeep(sweep.scrub, plain),
      rocks: new CandidateKeep(sweep.rocks, plain),
      shore: new CandidateKeep(sweep.shore, (c) => {
        const ground = terrain.renderedHeightAt(c.x, c.y);
        const above = ground - c.level;
        // Thickest at the waterline, thinning up the bank and into the deep.
        const odds = above < -m(2.5) ? 0.06 : above < -m(0.3) ? 0.3 : above < m(0.6) ? 0.45 : above < m(2) ? 0.22 : above < m(4) ? 0.07 : 0;
        return c.draw <= odds && coverFree(c.x, c.y) ? ground : null;
      }),
    };
  };
  const handle: SceneHandle = {
    // Asked for by the Actions (a shot, a bomb) and the weapons lab: the
    // effects, and now the physics the bodies fall with (`warmPhysics`). The
    // idle preload below makes the effects only.
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
      // Drawn by the ground's own material (`TERRAIN_GRID`): always on it,
      // over the whole map, in world units.
      TERRAIN_GRID.value = [GRID_CELL, on ? 0.08 : 0, MAP_HALF];
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
        // Kept by the atlas as its plates' ground moves: walking every plate's
        // corners was 40 ms, on the first move of the pointer after every
        // change of the land.
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
    beginLoad() {
      reveal.begin();
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
      // The road at grade and the decks are asked apart: where an overpass
      // crosses a street, the street's centreline is the nearer of the two.
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
      cityMinutes = sim.city.minutes(sim);
      const wallNow = performance.now();
      const wallDt = lastWall < 0 ? 0 : Math.min(0.1, (wallNow - lastWall) / 1000);
      // The bodies, guts and debris on their own clock (the weapons lab slows,
      // stops and steps it, `setEffectsSpeed` / `stepEffects`).
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
      // A brush stroke in progress: every dab used to re-solve the whole road
      // network and re-mesh every road, tree and tuft of grass near it - 450 ms
      // a dab on the player map, so painting was a slideshow. While the stroke
      // is held only the ground follows the brush, cut and filled to the roads
      // as they already stand; the roads catch up once, when it ends.
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
      // Only the ground round the sites that changed is graded again (growing
      // a building re-graded the whole map and every platform: a hitch for
      // every building the zones grew, the profile of 2026-10-05).
      // While a road edit is prepared in slices its steps grade the sites (`shapeBlocksSteps`).
      // Each site on its own (`changedSites`): the buildings a frame of a generated city grew, wherever
      // they stand, cut and fill the ground round each of them, not the box round them all.
      if (!worldJob && gradedFor !== net.doc.buildings.revision) {
        gradedFor = net.doc.buildings.revision;
        const changed = sitesGraded.changedSites(net.doc.buildings);
        if (changed) shapeGround(net, changed.map(terrainRegion), true);
      }
      // What stands on the ground - the buildings, the walls, the transport,
      // the gardens - waits while an edit's world is still being built: each
      // slice of it cuts and fills a quarter block, and each layer was built
      // again on every frame of it (and the buildings' own queue started over),
      // though only the ground the swap puts in place is the one they stand
      // on. The old ones are drawn meanwhile, as the old roads are.
      const groundSettled = !stroking && !worldJob;
      // The street furniture, the signs, the barriers and the transport on the world as it stands (the engine's
      // 'draw' products): what the diary says changed under them.
      if (groundSettled) { placedOn = net; engine.refresh('draw'); }
      // The buildings follow the ground once a stroke is over, not on every
      // dab of it: re-grading 600 buildings per dab took seconds a dab.
      // Only when the ground changed under some building's own bank, and then
      // each building samples its ground again only if a change reached it.
      if (groundSettled && groundChanges.version !== buildingGroundSeen) {
        const moved = buildingGroundSeen < 0 ? null : buildingsOnGroundSince(net.doc, buildingGroundSeen);
        if (moved === null || moved.length > 0) buildingGround = String(groundChanges.version);
        buildingGroundSeen = groundChanges.version;
      }
      // At the opening the buildings come once the first world (the roads,
      // the ground cut and filled to them) is in: emitted on the bare land
      // they were all emitted again on the shaped one.
      // A map opened behind the curtain: not on the old map's ground while
      // its own world is still being built - they were emitted twice, on
      // the ground going and then on the one coming.
      if (roads !== null && (reveal.opened || !worldJob)) {
        buildings.hidden = !reveal.opened;
        // Buildings put together or streamed in (HLOD, `layer.ts`) are new
        // casters: the shadow map is drawn again.
        if (buildings.update(net.doc, terrain.renderedHeightAt, buildingGround, pavedHeightAt, builtGroundAt,
          (b, since) => groundChanges.touches(Number(since), bankBox(b)),
          (since) => (since === '' ? null : buildingsOnGroundSince(net.doc, Number(since))))) shadowMoved = true;
        if (buildings.pending) onAssetsReady();
      }
      // The countryside's trees are grown once the first world is in, not
      // while the opening builds it (`loadNatureTrees`).
      if (!natureTreesStarted && roads !== null && !worldJob) startNatureTrees();
      // The Actions' effects (`playEffects.ts`) made in idle time once the
      // world stands, not on the first shot: then the shot waited for them to
      // download and be built before it struck.
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
      // THE PLANTS AND STONES (`coverSweep`/`coverKeep`, `natureSweep`/
      // `natureKeep`, the planted trees): swept again when the land, the
      // paint, the water, the ecosystem or the tier change; kept again when
      // the roads, the ground under the buildings, the clearings or the
      // drawn ground do - a pass over the places already found - and drawn
      // again only when what is kept is not the same, into the meshes they
      // have. Not in the middle of a stroke, and not while an edit's world is
      // still being built: the old one is drawn meanwhile, and the ground the
      // plants stand on is only final when it is swapped in.
      if (!stroking && !worldJob) {
        keepNet = net;
        // What the tests read that changed since the last look, and where (null: the diary cannot say).
        const entries = vegetationRead.read(net.doc.changes);
        let rects: ChangeRect[] | null = entries === null ? null : [];
        for (const entry of entries ?? []) {
          if (entry.rects === null) { rects = null; break; }
          rects!.push(...entry.rects);
        }
        const moved = rects === null || rects.length > 0;
        // The stones, the scrub and the painted woods.
        const coverSweepKey = `${terrain.forestRevision}:${terrain.waterRevision}`;
        let coverFresh = false;
        if (coverSweepState?.key !== coverSweepKey) {
          const at = performance.now();
          coverSweepState = coverSweep(net.doc, coverSweepKey);
          coverKeeps = coverKeepsOf(coverSweepState);
          coverFresh = true;
          performance.measure('hitch:cover/sweep', { start: at, end: performance.now() });
        }
        // The painted woods' trees are the countryside's (`natureTrees.ts`); the old card trees only if those cannot be grown.
        const standIns = !natureTreeKit && !natureTreesPending;
        // The stones take the colour of the painted rock under them.
        const geology = terrain.geologyChanges.version;
        const coverWhole = coverFresh || vegetationRedraw || coverLook?.geology !== geology || coverLook?.standIns !== standIns;
        if (coverKeeps) {
          const at = performance.now();
          const keeps = coverKeeps;
          if (coverFresh || moved) for (const keep of [keeps.forest, keeps.scrub, keeps.rocks, keeps.shore] as CandidateKeep<Candidate>[]) keep.refresh(coverFresh ? null : rects, KEEP_REACH);
          // The cells whose places changed, of every kind (the painted woods' are read by the cover's card trees and by the forest).
          const changed = new Set<number>();
          let whole = coverWhole;
          for (const keep of [keeps.forest, keeps.scrub, keeps.rocks, keeps.shore] as CandidateKeep<Candidate>[]) {
            const cells = keep.takeChangedCells();
            if (cells === null) whole = true; else for (const cell of cells) changed.add(cell);
          }
          const allCells = (): Set<number> => new Set([...keeps.forest.cellKeys(), ...keeps.scrub.cellKeys(), ...keeps.rocks.cellKeys(), ...keeps.shore.cellKeys()]);
          if (whole || changed.size) {
            coverCells ??= (() => {
              const made = createCoverCells(coverKit, 'ground-cover', {
                rocksIn: (cell) => [...coverKeeps!.rocks.standingIn(cell), ...coverKeeps!.shore.standingIn(cell)]
                  .map(({ c, z }) => ({ x: c.x, y: c.y, z, size: c.size, yaw: c.yaw, seed: c.seed, rock: terrain.geologyAt(c.x, c.y) })),
                scrubIn: (cell) => coverKeeps!.scrub.standingIn(cell).map(({ c, z }) => ({ x: c.x, y: c.y, z, size: c.size, yaw: c.yaw, seed: c.seed })),
                treesIn: (cell) => (!natureTreeKit && !natureTreesPending ? coverKeeps!.forest.standingIn(cell).map(({ c, z }) => ({ ...c, z })) : []),
              });
              world.add(made.group);
              return made;
            })();
            coverCells.sync(whole ? null : changed, allCells());
            if (natureTreeKit) {
              paintedForest ??= (() => {
                const made = createTreeCells(natureTreeKit, 'painted-forest', (cell) => coverKeeps!.forest.standingIn(cell).map(({ c, z }) => ({ ...c, z })));
                world.add(made.group);
                return made;
              })();
              paintedForest.sync(whole ? null : changed, keeps.forest.cellKeys());
            }
          }
          coverLook = { geology, standIns };
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
          // While plates wait their sweep (one a frame), the trees standing
          // stay; they are kept again once, when the sweep is whole - kept on
          // every frame of it, 17 to 27 ms each, it was a hitch a frame
          // (2026-10-11). With none standing yet, the first plates' at once.
          if (!natureSweepPending || !natureSweepState) natureSweepState = swept;
          performance.measure('hitch:nature/sweep', { start: at, end: performance.now() });
        }
        if (natureSweepState) {
          const sweep = natureSweepState;
          const fresh = natureKeep?.list !== sweep.trees;
          if (fresh) natureKeep = new CandidateKeep(sweep.trees, natureStands);
          const keep = natureKeep!;
          const at = performance.now();
          if (fresh || moved) keep.refresh(fresh ? null : rects, KEEP_REACH);
          const cells = keep.takeChangedCells();
          const whole = cells === null || vegetationRedraw;
          if (whole || cells!.size) {
            const changed = whole ? null : cells;
            if (natureTreeKit) {
              natureForest ??= (() => {
                const made = createTreeCells(natureTreeKit, 'nature-forest', (cell) => natureKeep!.standingIn(cell).map(({ c, z }) => ({ ...c, z })));
                world.add(made.group);
                return made;
              })();
              natureForest.sync(changed, keep.cellKeys());
              // Grown (or nothing to grow): no longer drawing while waiting for them.
              natureTreesPending = false;
            }
            // The old card trees only if the new ones could not be grown: shown while they load, they were
            // the first trees the player saw and then changed under them (2026-10-07).
            natureCards ??= (() => {
              const made = createCoverCells(coverKit, 'nature-cards', {
                rocksIn: () => [], scrubIn: () => [],
                treesIn: (cell) => (!natureTreeKit && !natureTreesPending ? natureKeep!.standingIn(cell).map(({ c, z }) => ({ ...c, z })) : []),
              });
              world.add(made.group);
              return made;
            })();
            natureCards.sync(changed, keep.cellKeys());
          }
          performance.measure('hitch:nature', { start: at, end: performance.now() });
        }
        // The trees the player planted (`world/trees.ts`), with the woods' own
        // models: none on a road or under a building, each on the ground as
        // drawn.
        if (natureTreeKit) {
          const fresh = !plantedKeep || plantedFor !== net.doc.treeRevision;
          if (fresh) {
            plantedFor = net.doc.treeRevision;
            plantedKeep = new CandidateKeep(net.doc.trees, (t) => (onCarriageway(keepNet!, t) || buildings.covers(t.x, t.y) ? null : terrain.renderedHeightAt(t.x, t.y)));
          }
          const keep = plantedKeep!;
          if (fresh || moved) keep.refresh(fresh ? null : rects, KEEP_REACH);
          const cells = keep.takeChangedCells();
          if (cells === null || cells.size || vegetationRedraw) {
            plantedForest ??= (() => {
              const made = createTreeCells(natureTreeKit, 'planted-forest', (cell) => plantedKeep!.standingIn(cell)
                .map(({ c, z }) => ({ x: c.x, y: c.y, z, size: c.height, yaw: c.yaw, seed: c.seed, species: 'broadleaf' as const })));
              world.add(made.group);
              return made;
            })();
            plantedForest.sync(cells === null || vegetationRedraw ? null : cells, keep.cellKeys());
          }
        }
        vegetationRedraw = false;
      }
      // Discover new shader variants across frames, including hidden objects
      // that may become visible as the player moves. Three's compileAsync
      // traverses everything passed to it regardless of visibility, so only
      // the representative meshes are submitted, with the real scene supplying
      // lights and environment through its targetScene parameter.
      if (!compiling) {
        if (scanStack.length === 0 && performance.now() - compileCheckedAt > 2000) {
          compileCheckedAt = performance.now();
          scanStack.push(scene);
        }
        for (let n = 0; n < SCAN_PER_FRAME && scanStack.length; n++) {
          const o = scanStack.pop()!;
          const material = (o as Mesh).material as Material | Material[] | undefined;
          if (material) for (const m of Array.isArray(material) ? material : [material]) {
            const mesh = o as Mesh & { isInstancedMesh?: boolean; instanceColor?: unknown; isSkinnedMesh?: boolean };
            const variant = mesh.isSkinnedMesh ? 'skinned'
              : mesh.isInstancedMesh ? mesh.instanceColor ? 'instanced-color' : 'instanced'
                : o.type;
            let known = compiledVariants.get(m);
            if (!known) { known = new Set(); compiledVariants.set(m, known); }
            if (!known.has(variant)) { known.add(variant); compileSamples.push(o); }
          }
          for (const child of o.children) scanStack.push(child);
        }
        if (scanStack.length === 0 && compileSamples.length > 0) {
          const warm = new Group();
          // Shown in the copy: three's compile walks only what is visible, and
          // a mesh hidden until it has something to draw (a piece's water) is
          // compiled here, before it first shows.
          // And each one's shadow program, which three's compile never builds
          // (`uploads.ts` shadowStandIn).
          const shadows = new Group();
          for (const sample of compileSamples) {
            const copy = compileCopy(sample);
            copy.visible = true;
            warm.add(copy);
            const standIn = (sample as Mesh).isMesh ? shadowStandIn(sample as Mesh) : null;
            if (standIn) shadows.add(standIn);
          }
          if (shadows.children.length) void compileAhead(shadows, true).then(() => shadows.clear());
          compileSamples.length = 0;
          compiling = true;
          // For the target the scene is drawn into (`drainCompiles`).
          const previous = renderer.getRenderTarget();
          renderer.setRenderTarget(post.target);
          void renderer.compileAsync(warm, rig.camera, scene).catch(() => {}).finally(() => {
            warm.clear();
            compiling = false;
          });
          renderer.setRenderTarget(previous);
        }
      }

      // The perspective camera kept out of the buildings (`IsoRig.setSolids`):
      // only the buildings the diary names, or where the ground moved under
      // their floor, are filed again (`cameraSolidsKeeper`); NOT the town at
      // every building grown or every road solved.
      if (cameraSolidsKept.follow(net.doc.buildings, groundSince)) {
        rig.setSolids((x, y) => cameraSolidsKept.solids().floorAt(x, y), (x, y) => cameraSolidsKept.solids().roofAt(x, y));
        townSolids = () => cameraSolidsKept.solids();
      }
      // The light the buildings shut out of the streets round the view (`canyonLight.ts`).
      post.followTown(rig.target.x, -rig.target.z, townSolids, canyonChanges(net.doc.changes));
      const detailed = rig.viewport.zoom >= quality.detailCutoffZoom;
      const plantMap = rig.viewport.zoom < PLANT_MAP_ZOOM;
      // Keep the full facade at street zoom: the planar far mesh loses frames
      // on side-facing windows. Only its thin shadows can disappear earlier.
      buildings.setFar(rig.viewport.zoom < perM(7.5));
      // Facade detail only within ~500 m of the eye (`cullDetails`). The
      // orthographic camera stands 5000 units back by construction, so from
      // its own place no cell was ever near and the frames and railings were
      // never drawn: measured from the eye a perspective lens would need for
      // the same scale (as the air is, `eyeShift`).
      {
        const eye = rig.camera.position;
        let k = 1;
        if (!rig.perspective) {
          const halfH = canvas.clientHeight / Math.max(1e-3, 2 * rig.viewport.zoom);
          k = halfH / Math.tan((PERSPECTIVE_FOV * Math.PI) / 360) / Math.max(1e-3, eye.distanceTo(rig.target));
        }
        const t = rig.target;
        const ex = t.x + (eye.x - t.x) * k, ey = -(t.z + (eye.z - t.z) * k), ez = t.y + (eye.y - t.y) * k;
        // The far level of the buildings by the error on the screen, in CSS
        // pixels (Cesium's screen-space error divides by the pixel ratio).
        const pxAtMetre = canvas.clientHeight / (2 * Math.tan(((rig.perspective ? (rig.camera as PerspectiveCamera).fov : PERSPECTIVE_FOV) * Math.PI) / 360));
        // In the view from above a metre spans the same pixels wherever it
        // stands, so the error alone would keep every cell of the town in
        // detail: only the cells within the ground the screen takes in (and
        // a margin) are, the rest stand as their masses (HLOD, `layer.ts`).
        let reach = Infinity;
        if (!rig.perspective) {
          const halfH = canvas.clientHeight / Math.max(1e-3, 2 * rig.viewport.zoom);
          const halfW = (halfH * canvas.clientWidth) / Math.max(1, canvas.clientHeight);
          reach = Math.hypot(halfW, halfH / Math.max(0.3, Math.sin(rig.viewport.elevation))) * 1.25 + m(120);
        }
        buildings.levelOfDetail(ex, ey, ez, pxAtMetre, rig.perspective ? null : rig.viewport.zoom, reach);
        buildings.cullDetails(ex, ey, ez, pxAtMetre, rig.perspective ? null : rig.viewport.zoom);
      }
      buildings.setShadowFar(rig.viewport.zoom < FACADE_SHADOW_ZOOM);
      if (roads) roads.group.visible = true;
      if (details) details.group.visible = true;
      watchRoads(net);
      // The plants' leaf cards (`scenery.ts`/`gardens.ts` name them `...-cards`)
      // are left out at the map zoom. DO NOT test `-leaves`: no mesh is named
      // so, and the cards were drawn at every zoom.
      for (const mesh of furniture.meshes) {
        mesh.visible = quality.detailProps && detailed && (!plantMap || !isLeafCards(mesh));
      }
      for (const mesh of gardens?.meshes ?? []) {
        mesh.visible = detailed && (!plantMap || !isLeafCards(mesh));
      }
      gardens?.setNear(rig.viewport.zoom >= PLANT_NEAR_ZOOM);
      // After `visible` is set (the contract of `Scenery.setMap`), and only
      // when the map zoom is crossed or the layer is new: `gardens.setMap`
      // throws its cull away, and called every frame it culled every garden
      // of the town again on every frame with the camera still.
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
          // The road itself only: cut where its ends meet a junction (its
          // trims), not running into the road it joins.
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
      // The map stands on a plain dark blue: no sky and no land past its edge,
      // the map a block of land with its cut sides showing (the player,
      // 2026-10-06; 2026-10-10: the land and sky round the map read as a card
      // on a green plain).
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
      // The canvas's CSS size read once a frame, before the vehicles ask
      // `screenScale` (a box metric read forces layout - Paul Irish, "What
      // forces layout"; read per vehicle it cost 0.35 ms a frame).
      cssHalfW = renderer.domElement.clientWidth * 0.5;
      cssHalfH = renderer.domElement.clientHeight * 0.5;
      // Plants and street furniture outside the view are not drawn at all.
      furniture.cull(crowdFrustum, crowdProjection);
      signs.cull(crowdFrustum, crowdProjection);
      barriers.cull(crowdFrustum, crowdProjection);
      transit.cull(crowdFrustum, crowdProjection);
      for (const plants of [coverCells, natureCards, natureForest, paintedForest, plantedForest]) plants?.cull(crowdFrustum, crowdProjection);
      gardens?.cull(crowdFrustum, crowdProjection);
      transit.update(sim.city.transit.trains(), terrain.renderedHeightAt);
      agents.sync(sim, alpha, detailed, rig.viewport.zoom, {
        pedestrianDetail: quality.pedestrianDetail,
        pedestrianVisible,
        personPixels,
        screenScale,
        shadows: renderer.shadowMap.enabled,
        eye: cullCamera.position,
        vehicleVisible,
        occupantZoom: quality.occupantZoom,
        exhaust: (x, y, z, angle, length, speed, dusty) => {
          exhaust.emit(x, y, z, angle, length, speed, dusty);
          if (!dusty && Math.abs(speed) > 0.5) wear.wheels(x, y, angle, Math.min(length * 0.42, m(1.7)), wallDt);
        },
        // The bodies of shots and blows (`playEffects.ts`), once anybody has shot or struck.
        ...(fx ? { ragdolls: (citizens: Parameters<PlayEffects['frame']>[0]) => fx!.frame(citizens, sim, wallDt, fxDt) } : {}),
        hiddenPed: (id) => fx?.hides(id) ?? false,
      });
      exhaust.tick(windClock, renderer.domElement.height / 2);
      fx?.update(wallDt, fxDt);
      for (const ped of sim.pedViews) if (ped.v > 0.05) wear.feet(ped.x, ped.y, wallDt);
      wear.tick(wallDt);
      // The rooms cut open are lit from inside: brighter as the day goes.
      const key = cutSpec ? `${cutSpec.level}@${cutSpec.x},${cutSpec.y}:${sim.doc.buildings.revision}` : '';
      if (key !== lampsKey) {
        lampsKey = key;
        const lamps = roomLamps.lamps(sim, cutSpec, builtGroundAt, pavedHeightAt, ROOM_LIGHTS);
        roomLights.forEach((light, i) => {
          const at = lamps[i];
          light.userData['used'] = !!at;
          if (at) light.position.set(at.x, at.z, -at.y);
        });
      }
      // Falls off with the distance in world units: the same lamp in metres at any unit.
      for (const light of roomLights) light.intensity = cutSpec && light.userData['used'] ? 55 * TUNED_UNIT ** light.decay * (0.25 + 0.75 * lastDark) : 0;
      signals.sync(sim, detailed, crowdFrustum);

      target.copy(rig.target);
      const halfHeight = canvas.clientHeight / Math.max(0.001, rig.viewport.zoom * 2);
      const halfWidth = (halfHeight * canvas.clientWidth) / Math.max(1, canvas.clientHeight);
      // The screen's height covers more ground the lower the camera looks: the
      // shadows are fitted to the ground seen, not to the screen.
      // In perspective the far edge of the view takes in more ground than the
      // near: the shadows reach that far too.
      const reach = rig.perspective ? 1.6 : 1;
      const groundHalfDepth = (reach * halfHeight) / Math.max(0.3, Math.sin(rig.viewport.elevation));
      // The top of the tallest building, once per rebuild of the layer: the
      // shadows must reach as high as anything stands, or every terrace and
      // upper floor seen at close zoom lies outside the shadow map, in sun.
      if (tallestFor !== buildings.version) {
        tallestFor = buildings.version;
        tallestBox.setFromObject(buildings.group);
        tallestTop = tallestBox.isEmpty() ? 0 : tallestBox.max.y;
      }
      // Day and night, by the city's clock (`sim/city/city.ts`).
      // "Dia": four in the afternoon, the sun 29 degrees up - long enough
      // shadows to model the land, as the player's picture (2026-10-07).
      const fixedHour = skyMode === 'day' ? 16 * 60 : skyMode === 'night' ? 22 * 60 : null;
      const clock = fixedHour === null ? sim.city.minutes(sim) : fixedHour;
      {
        // THE WEATHER (`world/weather.ts`): the wind carries the clouds and
        // bends the plants and the smoke; the rain falls through the view;
        // lightning strikes at random, as often a minute as asked, and lights
        // the scene; an overcast sky dims the sun.
        const weather = net.doc.weather;
        const step = Math.min(0.1, Math.max(0, delta));
        const wind = windVector(weather, m(1));
        cloudDrift.x += wind.x * step;
        cloudDrift.y += wind.y * step;
        post.setCloudDrift(cloudDrift.x, cloudDrift.y);
        setWindWeather(wind.x, -wind.y, weather.wind);
        // The water: its waves run with the wind, rougher the harder it
        // blows; its foam; how fast the rivers run.
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
      // (`kit.ts` `awakeShare`) while the dark stays at 1 all night - one
      // uniform's value, read at the next upload, no program change.
      buildings.setNight(lastDark, clock / 60);
      rig.camera.getWorldDirection(viewDirection);
      // The shadows round the ground looked at. It answers whether the light
      // itself moved: the shadow map is drawn again only when it did, when a
      // caster moved, or when this view is close enough for a frame of a
      // caster's movement to be seen.
      const sunMoved = environment.follow(shadowCentre.copy(target), halfWidth, groundHalfDepth, viewDirection, Math.max(0, tallestTop - target.y), rig.camera.position.distanceTo(target));
      // What the simulation must show in full: people step round each other
      // only where they are seen, and big enough to see it (`SimWorld.focus`).
      {
        // In perspective, tilted towards the horizon, the camera sees far past
        // the circle round the centre of the view: its cone is given too, so
        // nobody is made or taken away anywhere it looks (the circle alone let
        // cars and people vanish down the street in full view).
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

      // The shadow pass, drawn when the map can have changed. Nothing in it
      // moves but the things standing on the ground, and those move only when
      // the simulation advances or the wind bends them: a paused, still day
      // draws the texels that are already there. Redrawing every frame cost
      // 3-5 ms of the GPU (measured 2026-10-13, 4096 texels, city of 1 348
      // buildings) - the single largest item in the frame after the town
      // itself, and one the brief already asked not to pay ("the shadow map
      // is redrawn only when a caster moved").
      if (renderer.shadowMap.enabled) {
        shadowFrame++;
        // The two-wheelers changed between casting and a soft disc: their shadows come or go now.
        if (agents.castersChanged) shadowMoved = true;
        // Moving only when something that moves is in the pass (`movingCasters`) or the wind
        // bends the trees: from the map the town stood still under its traffic's soft discs and
        // was drawn again every third frame all the same (2026-10-14).
        const moving = net.doc.weather.wind > 0 || (!sim.clock.paused && movingCasters());
        const every = rig.viewport.zoom >= SHADOW_FULL_ZOOM ? 1 : SHADOW_FAR_EVERY;
        if (shadowMoved || sunMoved || (moving && shadowFrame >= every) || shadowFrame >= SHADOW_SAFETY_FRAMES) {
          renderer.shadowMap.needsUpdate = true;
          shadowMoved = false;
          shadowFrame = 0;
        }
      }
      // It follows meshes a rebuild or an asset load adds, and instance
      // colours created on first use - twice a second: the scene is some
      // 1 900 objects with the crowd's pieces (0.2-0.3 ms a frame walked every
      // frame), and until a new mesh is reached three's own depth material
      // casts the same shadow.
      if (renderer.shadowMap.enabled && ++shadowDepthFrame % 30 === 1) assignShadowDepth(scene);
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
        // The relief's close window (terrainRelief.ts) round the ground the
        // view looks at, drawn a little towards the camera, where the ground
        // is nearest and largest on the screen; none from far out.
        const centre = rig.viewport.centre;
        const cam = rig.camera.position;
        const dx = cam.x - centre.x, dz = cam.z + centre.y;
        const across = Math.hypot(dx, dz);
        const pull = across > 1 ? Math.min(150, across * 0.3) / across : 0;
        reliefFocus.x = centre.x + dx * pull;
        reliefFocus.z = -centre.y + dz * pull;
        // Close: the screen's height under some 1800 units of ground, in
        // either camera (the orthographic one stands at a fixed distance).
        const halfHeight = renderer.domElement.clientHeight / Math.max(1e-3, 2 * rig.viewport.zoom);
        const close = halfHeight < 900;
        if (net.doc.gullyRevision !== gulliesFor) {
          gulliesFor = net.doc.gullyRevision;
          terrain.setGullies(net.doc.gullyDabs, net.doc.gullyAuto);
        }
        // The atlas keeps in full only the plates near what the view takes in (`flatAtlas.ts`).
        terrain.focus?.(centre.x, centre.y, halfHeight);
        terrain.bakeRelief(renderer, close ? reliefFocus : null);
      }
      {
        // The painted fog: its map again when the fog or the land under it
        // changed (never in the middle of a sculpting stroke).
        const doc = net.doc;
        // A fog stroke shows as it is painted; a land stroke waits for its end.
        const landHeld = !!options?.holdRoads && fogTerrainSeen !== doc.terrainRevision;
        const fogSerial = doc.changes.serialOf(...FOG_KINDS);
        if ((fogJournal !== doc.changes || fogSerial !== fogSeen) && !landHeld) {
          const startedAt = performance.now();
          // Only where the fog, the land or the ground under it changed (`createFogField`): DO NOT
          // raster the whole map at every dab of a brush.
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
        const f = doc.fogSettings;
        post.setPlacedClouds(doc.clouds);
        // The elements: again when they or the land under them change.
        const elementKey = `${doc.elementRevision}:${doc.terrainRevision}`;
        if (elementKit && elementKey !== elementsFor && !landHeld) {
          elementsFor = elementKey;
          if (elementLayer) {
            for (const mesh of elementLayer.meshes) world.remove(mesh);
            elementLayer.dispose();
            elementLayer = null;
          }
          const startedAt = performance.now();
          if (doc.elements.length > 0) {
            elementLayer = buildElementLayer(doc.elements, elementKit, (x, y) => terrain.renderedHeightAt(x, y));
            for (const mesh of elementLayer.meshes) world.add(mesh);
          }
          performance.measure('hitch:elements', { start: startedAt, end: performance.now() });
        }
        elementLayer?.emit(Math.min(0.1, Math.max(0, delta)), rig.camera.position, exhaust);
        post.setGroundFog(fogLayer?.any ? { texture: fogLayer.texture, low: fogLayer.low, high: fogLayer.high, density: f.density } : null);
        fogMoving = !!fogLayer?.any;
        placedCloudsShown = doc.clouds.length > 0 || !!elementLayer?.hasEffects;
      }
      // Rain thickens the air: a grey mist over the distance (`world/weather.ts`).
      const rainNow = net.doc.weather.rain;
      const air = rainNow > 0 ? { ...atmosphere, fog: Math.max(atmosphere.fog, rainNow * 0.2), fogHeight: Math.max(atmosphere.fogHeight, m(120)) } : atmosphere;
      // The orthographic camera stands far back by construction: the air is
      // measured from where the perspective camera stands at the same scale
      // (`isoViewport`: halfHeight / tan(fov / 2) from the view's centre).
      const eyeShift = rig.perspective ? 0
        : rig.camera.position.distanceTo(rig.target) - halfHeight / Math.tan((PERSPECTIVE_FOV * Math.PI) / 360);
      post.setAtmosphere(air, sunTowards.copy(environment.sun.position).sub(environment.sun.target.position), environment.skyColor,
        sunLight.copy(environment.sun.color).multiplyScalar(environment.sun.intensity), eyeShift);
      const atRender = performance.now();
      // The people's skeletons on the GPU (`people/crowdAnimation.ts`), before anybody draws them.
      agents.renderPalettes(renderer);
      // The opening's town is shown whole (Unity's `allowSceneActivation`: a
      // scene loaded in the background is activated once it is ready): until
      // its roads and its buildings are both in, nothing is presented and the
      // page stays as it is. Shown as it came, the roads stood alone for
      // seconds before the buildings arrived (the player, 2026-10-08).
      // A map opened later is held the same way (`beginLoad`), and the town
      // is whole only with its trees and the things on its footways too: the
      // roads came, then the zones, then the plants, then the buildings, each
      // on a frame of its own (the player, 2026-10-09).
      openingSince ??= performance.now();
      if (!reveal.opened) {
        const whole = roads !== null && !worldJob && !buildings.pending && natureTreesStarted && !natureTreesPending;
        const next = reveal.step(whole, performance.now());
        if (next === 'warm') {
          // One frame drawn unseen first: the new meshes go to the GPU
          // (three uploads a geometry when it is first drawn) behind the
          // curtain, not in the first frame the player sees.
          if (post.target) {
            renderer.setRenderTarget(post.target);
            renderer.render(scene, rig.camera);
            renderer.setRenderTarget(null);
          }
          onAssetsReady();
        } else if (next === 'show') {
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
    setQuality(level) {
      requested = level;
      const resolved = level === 'auto' ? governor.current : level;
      governor.set(resolved);
      applyQuality(resolved);
    },
    get quality() {
      return requested;
    },
    dispose() {
      roadTiles.dispose();
      // Everything the renderer made, the GPU's included: the layers, the
      // previews and the effects too (they were left out, and a renderer
      // made again - a map opened, the tier changed - left them all behind).
      fx?.dispose();
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

import { plantGrowth } from '@world/landscape';
import {
  AdditiveBlending,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  FrontSide,
  Frustum,
  InstancedMesh,
  Matrix4,
  Sphere,
  Vector3,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  ShaderMaterial,
  type BufferGeometry,
  Group,
  type Material,
  type MeshDepthMaterial,
} from 'three';

import { Rng } from '@core/rng';
import { angleOf } from '@core/vec2';
import type { Network } from '@world/network';
import type { RoadElevation } from '@world/elevation';
import { streetFurniture, type FurnitureItem, type FurnitureKind } from '@world/streetFurniture';
import { FOOTWAY_RISE } from '@world/roadTypes';
import { footwayRiseAt } from '@world/roads/footwayRise';
import { m, perM } from '@world/units';
import { buildGrass, type GrassField } from './grass';
import { applyWind, windDepthMaterial, type WindResponse } from './wind';
import { leafCardMaterials } from './lowPolyTrees';
import { lightPoolTexture } from './lightLevels';
import {
  BUSH_KINDS,
  TREE_SPECIES,
  benchGeometry,
  binGeometry,
  bushParts,
  grassTuftGeometry,
  hydrantGeometry,
  lampGeometry,
  lampLensGeometry,
  LAMP_HEIGHT,
  LAMP_OUTREACH,
  postboxGeometry,
  phoneGeometry,
  drainGeometry,
  treeParts,
  treePitGeometry,
  trianglesOf,
  wildflowerGeometry,
  type BushKind,
  type TreeSpecies,
} from './propGeometry';

export { LAMP_HEIGHT, LAMP_OUTREACH } from './propGeometry';

/**
 * Everything standing on the ground that is not a road: street furniture,
 * street trees, vegetation and grass.
 *
 * There used to be a gantry arch at every map-edge stub, to mark where traffic
 * entered. It was a piece of scenery nobody asked for standing in the middle of
 * open country, and it is gone: a road that ends simply ends.
 *
 * Vegetation is here for a reason beyond decoration. An isometric view of an
 * open plain gives the eye nothing to judge distance or scale by, so the scene
 * reads as a flat map however good the ground material is. Objects of a KNOWN
 * height, scattered at a known density, are what turn the same image into a
 * landscape: they cast shadows across the terrain, they occlude one another with
 * distance, and they make a hill's far side legible.
 *
 * WHERE the furniture stands is not decided here: `world/streetFurniture.ts`
 * owns the layout, because the pedestrians have to walk around the same list.
 *
 * Everything is instanced — one draw call per model, whatever the count — and
 * every mesh carries a real bounding sphere so the frustum can reject it.
 * Models and materials live in a `SceneryKit` built once; a rebuild only
 * writes instance matrices.
 */

/** Street trees are pollarded smaller than a tree in open ground. */
const STREET_TREE_MIN = m(6.5);
const STREET_TREE_RANGE = m(3);

/** How each kind of plant answers the wind; see `wind.ts`. */
const TREE_WIND: WindResponse = { sway: 0.045, flutter: 0.009 };
const BUSH_WIND: WindResponse = { sway: 0.05, flutter: 0.014 };
const GRASS_WIND: WindResponse = { sway: 0.22, flutter: 0.04 };

/** Radius of the bright core under a street lamp (the cone's foot). */
export const LAMP_POOL_RADIUS = m(4.6);
/**
 * The light a street lamp lays on the road: not a spotlight's disc but the
 * long patch of a road luminaire's spread (the IES "type II/III"
 * distributions), some 1.6 mounting heights each way along the road and the
 * carriageway's width across it, so the pools of neighbouring lamps overlap
 * and the whole road is lit, as street lighting is designed to be (ABNT NBR
 * 5101, CIE 115: an overall uniformity of about 0.4). Discs of 4.6 m left the
 * road dark between the lamps (the player, 2026-10-13: "a via toda fica
 * iluminada, não é?").
 */
const POOL_ALONG = 1.6;
/**
 * A lamp's visible cone of light, drawn as Volumetric Light Beam draws one
 * (saladgamer.com/vlb-doc/comp-lightbeam-sd/): an open cone, additive, its
 * light falling off down its length and softened at its edges by the angle
 * it is seen at, its apex cut at the size of the source.
 */
/** The cone's radius at the ground: the bright core of the pool. */
export const LAMP_BEAM_RADIUS = LAMP_POOL_RADIUS * 0.8;
/** Radius of the cut apex, over the radius at the ground: the lens (about 0.28 m of 3.7). */
const BEAM_SOURCE = 0.075;
/** Sides and segments of the cone (VLB: 18 sides; 3 segments at least, for a smooth falloff). */
const BEAM_SIDES = 18;
const BEAM_SEGMENTS = 4;
/**
 * Brightness of the air lit at the lens, at full dark: well below a lit
 * surface, as light scattered by clear night air is, so the road reads
 * through it; its brightest (0.26 at the lens) stays under the bloom threshold.
 */
const BEAM_INTENSITY = 0.4;
/** How hard the cone's edges are seen from the side (VLB's Side Thickness): higher, softer. */
const BEAM_SIDE_SOFTNESS = 1.6;
/**
 * VLB's Fade Out: the cone dims from `BEAM_FADE[0]` from the eye and is gone
 * at `BEAM_FADE[1]`. Air lit by a lamp shows close by; from over the
 * neighbourhood each cone, seen down its length, was a pale drop the size of
 * a house over every lamp in town (2026-10-11), where a night photograph
 * from above shows the pools on the ground only.
 */
const BEAM_FADE = [m(60), m(140)] as const;

/**
 * The street lights' colour: white LED, some 4500 K. The orange of sodium
 * lamps (0xffc98a) is gone from Brazilian streets - 90 % of São Paulo's
 * public lighting was LED in 2021 (Prefeitura de São Paulo, "Parque de
 * iluminação da cidade") - and with every window as warm the night town was
 * one yellow (the player, 2026-10-13).
 */
const STREET_LED = 0xffe2c4;

/**
 * The cone's material. Front faces only: the far side of an open cone added
 * again doubled the light down its middle. The light along it is VLB's
 * "Blend" of linear and quadratic falloff, from the lens (1) to the ground
 * (0); across it, the cosine between the surface and the eye, so the
 * silhouette fades out instead of ending in a line.
 */
function beamMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    name: 'street-light-beam',
    uniforms: {
      uColor: { value: new Color(STREET_LED) },
      uIntensity: { value: 0 },
    },
    vertexShader: `
      varying float vAlong;
      varying vec3 vNormalW;
      varying vec3 vToEye;
      varying float vFade;
      void main() {
        vAlong = -position.y;
        mat4 model = modelMatrix;
      #ifdef USE_INSTANCING
        model = modelMatrix * instanceMatrix;
      #endif
        vec4 world = model * vec4(position, 1.0);
        // A scaled cone's normals: through the inverse transpose of its scale.
        vec3 s = vec3(length(model[0].xyz), length(model[1].xyz), length(model[2].xyz));
        vNormalW = normalize(mat3(model) * (normal / (s * s)));
        vToEye = isOrthographic ? vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]) : cameraPosition - world.xyz;
        vFade = isOrthographic ? 1.0 : 1.0 - smoothstep(${BEAM_FADE[0].toFixed(3)}, ${BEAM_FADE[1].toFixed(3)}, length(vToEye));
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uIntensity;
      varying float vAlong;
      varying vec3 vNormalW;
      varying vec3 vToEye;
      varying float vFade;
      void main() {
        if (vFade <= 0.0) discard;
        float t = clamp(vAlong, 0.0, 1.0);
        float fall = mix(1.0 - t, (1.0 - t) * (1.0 - t), 0.5);
        float facing = abs(dot(normalize(vNormalW), normalize(vToEye)));
        gl_FragColor = vec4(uColor * (uIntensity * vFade * fall * pow(facing, ${BEAM_SIDE_SOFTNESS.toFixed(2)})), 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: FrontSide,
    visible: false,
  });
}

export interface SceneryKit {
  readonly trees: Record<TreeSpecies, BufferGeometry>;
  readonly bushes: Record<BushKind, BufferGeometry>;
  /** Each plant's foliage cards (`lowPolyTrees.ts`), drawn with the same instances; none on a conifer. */
  readonly cards: Partial<Record<TreeSpecies | BushKind, BufferGeometry>>;
  readonly treeCards: MeshStandardMaterial;
  readonly treeCardsDepth: MeshDepthMaterial;
  readonly shrubCards: MeshStandardMaterial;
  readonly shrubCardsDepth: MeshDepthMaterial;
  readonly furniture: Record<Exclude<FurnitureKind, 'streetTree' | 'shrub'>, BufferGeometry>;
  readonly lampLens: BufferGeometry;
  readonly treePit: BufferGeometry;
  readonly tuft: BufferGeometry;
  readonly flower: BufferGeometry;
  readonly foliage: MeshStandardMaterial;
  readonly foliageDepth: MeshDepthMaterial;
  readonly shrubs: MeshStandardMaterial;
  readonly shrubsDepth: MeshDepthMaterial;
  readonly grass: MeshStandardMaterial;
  readonly flowers: MeshStandardMaterial;
  readonly props: MeshStandardMaterial;
  readonly glow: MeshBasicMaterial;
  /** The warm pool of light under a street lamp, seen only after dark. */
  readonly pool: BufferGeometry;
  readonly poolGlow: MeshBasicMaterial;
  /**
   * The cone of light from a street lamp's lens down to its pool, seen only
   * after dark: a unit cone, apex (cut at the lens's size) at the origin,
   * base of radius 1 at y = -1; scaled by the radius at the ground (x, z)
   * and the drop (y).
   */
  readonly beam: BufferGeometry;
  readonly beamGlow: ShaderMaterial;
  /** Where a street lamp's lens is, from its column's foot: out over the road and up. */
  readonly lens: { readonly reach: number; readonly height: number };
  /** Lamps lit as night falls: 0 by day, 1 at night. */
  setNight(dark: number): void;
  /**
   * How thick the air is, 0 clear to 1 rain or fog: a lamp's cone of light is
   * seen only in air that scatters it. In a clear night only the lit ground
   * shows (the cones over a dry street, 2026-10-13).
   */
  setHaze(haze: number): void;
  dispose(): void;
}

/** Builds every model and material once, at renderer start. */
export function createSceneryKit(): SceneryKit {
  const treeModels = TREE_SPECIES.map((s) => [s, treeParts(s)] as const);
  const bushModels = BUSH_KINDS.map((k) => [k, bushParts(k)] as const);
  const trees = Object.fromEntries(treeModels.map(([s, p]) => [s, p.body])) as Record<TreeSpecies, BufferGeometry>;
  const bushes = Object.fromEntries(bushModels.map(([k, p]) => [k, p.body])) as Record<BushKind, BufferGeometry>;
  const cards: Partial<Record<TreeSpecies | BushKind, BufferGeometry>> = {};
  for (const [kind, parts] of [...treeModels, ...bushModels]) if (parts.cards) cards[kind] = parts.cards;
  // Each plant model's sphere, once: what the instances' culling grows (`gardens.ts`, `build`).
  for (const g of [...Object.values(trees), ...Object.values(bushes), ...Object.values(cards)]) g?.computeBoundingSphere();
  const treeCardKit = leafCardMaterials(TREE_WIND, 'tree');
  const shrubCardKit = leafCardMaterials(BUSH_WIND, 'bush');
  const furniture = {
    lamp: lampGeometry(),
    bin: binGeometry(),
    bench: benchGeometry(),
    hydrant: hydrantGeometry(),
    postbox: postboxGeometry(),
    phone: phoneGeometry(),
    drain: drainGeometry(),
  };
  const lampLens = lampLensGeometry();
  lampLens.computeBoundingBox();
  const lensBox = lampLens.boundingBox!;
  const lens = { reach: (lensBox.min.x + lensBox.max.x) / 2, height: (lensBox.min.y + lensBox.max.y) / 2 };
  const treePit = treePitGeometry();
  const tuft = grassTuftGeometry();
  const flower = wildflowerGeometry();

  // The trunk and the crown's shaded heart, faceted, under the foliage cards:
  // the countryside's trees exactly (`lowPolyTrees.ts`), one style in the game.
  const foliage = new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, flatShading: true, envMapIntensity: 0.35 });
  applyWind(foliage, TREE_WIND, 'tree');
  const shrubs = new MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0, flatShading: true, envMapIntensity: 0.35 });
  applyWind(shrubs, BUSH_WIND, 'bush');
  const grass = new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, side: DoubleSide });
  applyWind(grass, GRASS_WIND, 'grass');
  const flowers = new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0, side: DoubleSide });
  applyWind(flowers, GRASS_WIND, 'flower');
  const props = new MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.28 });
  const glow = new MeshBasicMaterial({ color: 0xffeec0, toneMapped: false });
  const pool = new CircleGeometry(1, 28);
  pool.rotateX(-Math.PI / 2);
  const poolGlow = new MeshBasicMaterial({
    map: lightPoolTexture(), color: STREET_LED, transparent: true, opacity: 0, blending: AdditiveBlending,
    depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  const beam = new CylinderGeometry(BEAM_SOURCE, 1, 1, BEAM_SIDES, BEAM_SEGMENTS, true);
  beam.translate(0, -0.5, 0);
  const beamGlow = beamMaterial();
  let night = 0;
  let haze = 0;
  const lightBeams = (): void => {
    (beamGlow.uniforms['uIntensity'] as { value: number }).value = BEAM_INTENSITY * night * haze;
    beamGlow.visible = night * haze > 0.02;
  };
  const foliageDepth = windDepthMaterial(TREE_WIND, 'tree');
  const shrubsDepth = windDepthMaterial(BUSH_WIND, 'bush');
  const geometries: BufferGeometry[] = [
    ...Object.values(trees),
    ...Object.values(bushes),
    ...Object.values(cards) as BufferGeometry[],
    ...Object.values(furniture),
    lampLens,
    treePit,
    tuft,
    flower,
    pool,
    beam,
  ];
  const materials: Material[] = [foliage, shrubs, grass, flowers, props, glow, foliageDepth, shrubsDepth, poolGlow, beamGlow,
    treeCardKit.material, treeCardKit.depth, shrubCardKit.material, shrubCardKit.depth];
  return {
    trees,
    bushes,
    cards,
    treeCards: treeCardKit.material,
    treeCardsDepth: treeCardKit.depth,
    shrubCards: shrubCardKit.material,
    shrubCardsDepth: shrubCardKit.depth,
    furniture,
    lampLens,
    treePit,
    tuft,
    flower,
    foliage,
    foliageDepth,
    shrubs,
    shrubsDepth,
    grass,
    flowers,
    props,
    glow,
    pool,
    poolGlow,
    beam,
    beamGlow,
    lens,
    setNight(dark) {
      night = dark;
      // The lens burns brighter than white at night, so it blooms.
      glow.color.setHex(0xffeec0).multiplyScalar(1 + 2.6 * dark);
      // Overlapping pools add up (additive): each one fainter, the road evenly lit.
      poolGlow.opacity = 0.32 * dark;
      poolGlow.visible = dark > 0.02;
      lightBeams();
    },
    setHaze(next) {
      haze = Math.max(0, Math.min(1, next));
      lightBeams();
    },
    dispose() {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
}

/**
 * The instanced meshes of trees and bushes - each kind's body and its foliage
 * cards on the same placements, one model at every zoom - added to `meshes`
 * and to `plants`.
 */
function plantMeshes(prefix: string, trees: Map<TreeSpecies, Placement[]>, bushes: Map<BushKind, Placement[]>, kit: SceneryKit,
  meshes: InstancedMesh[], plants: [InstancedMesh, BufferGeometry, BufferGeometry][]): void {
  const add = (mesh: InstancedMesh | null, model: BufferGeometry, cards = false): void => {
    if (!mesh) return;
    // The crown's heart throws the plant's shadow; alpha-cut cards in the
    // shadow pass cost 70 ms a frame.
    if (cards) mesh.castShadow = false;
    meshes.push(mesh);
    plants.push([mesh, model, model]);
  };
  for (const species of TREE_SPECIES) {
    const placed = trees.get(species) ?? [];
    add(build(`${prefix}trees-${species}`, kit.trees[species], kit.foliage, placed, kit.foliageDepth, kit.trees[species]), kit.trees[species]);
    const cards = kit.cards[species];
    if (cards) add(build(`${prefix}trees-${species}-cards`, cards, kit.treeCards, placed, kit.treeCardsDepth, cards), cards, true);
  }
  for (const kind of BUSH_KINDS) {
    const placed = bushes.get(kind) ?? [];
    add(build(`${prefix}bushes-${kind}`, kit.bushes[kind], kit.shrubs, placed, kit.shrubsDepth, kit.bushes[kind]), kit.bushes[kind]);
    const cards = kit.cards[kind];
    if (cards) add(build(`${prefix}bushes-${kind}-cards`, cards, kit.shrubCards, placed, kit.shrubCardsDepth, cards), cards, true);
  }
}

/**
 * One of every plant as the gardens draw them, with and without a tint of
 * their own (an instance colour is a program variant), and each as its shadow
 * pass draws it (its depth material), for compiling their programs ahead
 * (three's `compileAsync`: objects to be added later are precompiled before
 * they are drawn). The first lots painted grew gardens whose programs were
 * built in that frame: some 600 ms on the first stroke of the zone brush.
 */
export function plantSamples(kit: SceneryKit): { readonly group: Group; readonly depth: Group; dispose(): void } {
  const meshes: InstancedMesh[] = [];
  for (const tint of [undefined, new Color(1, 1, 1)]) {
    const one: Placement[] = [{ x: 0, y: 0, z: 0, yaw: 0, sx: 1, sy: 1, sz: 1, ...(tint ? { tint } : {}) }];
    plantMeshes('sample-', new Map(TREE_SPECIES.map((s) => [s, one])), new Map(BUSH_KINDS.map((k) => [k, one])), kit, meshes, []);
  }
  const group = new Group(), depth = new Group();
  for (const mesh of meshes) {
    group.add(mesh);
    if (!mesh.customDepthMaterial) continue;
    const shadow = new InstancedMesh(mesh.geometry, mesh.customDepthMaterial, 1);
    shadow.instanceMatrix.copy(mesh.instanceMatrix);
    if (mesh.instanceColor) shadow.instanceColor = mesh.instanceColor;
    depth.add(shadow);
  }
  return { group, depth, dispose() { for (const mesh of meshes) mesh.dispose(); } };
}

export interface Scenery {
  readonly meshes: readonly InstancedMesh[];
  /** Grass tufts and wildflowers, shown only at close zoom. */
  readonly grass: Group;
  readonly triangles: number;
  /**
   * Swaps every plant between its close-up model and its map-zoom model. A
   * geometry reference per mesh; nothing is rebuilt.
   */
  setNear(near: boolean): void;
  /**
   * The map zoom (`PLANT_MAP_ZOOM`): the leaf cards are not drawn at all, a
   * shrub or a length of hedge being a pixel or two; the crown under them
   * gives its colour and shape. Called every frame, after `visible` is set.
   */
  setMap(map: boolean): void;
  /**
   * Keeps only the instances the camera can see, or whose shadow it can.
   * `view` is the camera's projection times its inverse world matrix; nothing
   * is done while it is unchanged.
   */
  cull(frustum: Frustum, view: Matrix4): void;
  /**
   * Drops every tree and shrub whose trunk stands where `covered` says -
   * under a building (docs/buildings.md section 5) - from the instance cull.
   * Nothing is rebuilt; the next `cull` simply skips them. Null clears it.
   */
  exclude(covered: ((x: number, y: number) => boolean) | null): void;
  dispose(): void;
}

/**
 * How far outside the view an instance is still drawn, world units: the
 * longest shadow a tree can throw into the picture from beyond its edge.
 */
export const SHADOW_REACH = m(28);

/**
 * Every instance of one mesh, kept apart from what is drawn.
 *
 * Each species used to be ONE instanced mesh spread over the whole map, so
 * its bounding sphere was the map and nothing was ever off screen: zoomed in
 * on a crossroads, every bush on the map went to the GPU in close-up detail,
 * three times over (picture, shadow map, occlusion) - four million triangles
 * a frame, most of them outside the window. The instances in view are copied
 * to the front of the buffer when the camera moves, and only those are drawn.
 */
interface Instances {
  readonly matrices: Float32Array;
  readonly colours: Float32Array | null;
  /** Per instance: centre x, y, z and radius, in the scene's frame. */
  readonly spheres: Float32Array;
  readonly count: number;
  /** One sphere round every instance, so a mesh wholly out of view is skipped at once. */
  readonly bounds: { x: number; y: number; z: number; r: number };
}

/** Zoom at and above which plants are drawn with their close-up models. */
export const PLANT_NEAR_ZOOM = perM(3.5);
/** Below this zoom the plants' leaf cards are left out (`Scenery.setMap`). */
export const PLANT_MAP_ZOOM = perM(2.5);

interface Placement {
  x: number;
  y: number;
  z: number;
  yaw: number;
  sx: number;
  sy: number;
  sz: number;
  tint?: Color;
}

function build(
  name: string,
  geometry: BufferGeometry,
  material: Material,
  placements: readonly Placement[],
  depth?: MeshDepthMaterial,
  near?: BufferGeometry,
): InstancedMesh | null {
  if (placements.length === 0) return null;
  const mesh = new InstancedMesh(geometry, material, placements.length);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // Culled per instance instead (`Scenery.cull`): a sphere round the whole
  // map rejects nothing, and it would go stale when the model is swapped.
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  // The shadow pass bends with the wind too, or the shadows would lie still
  // under moving trees.
  if (depth) mesh.customDepthMaterial = depth;
  const object = new Object3D();
  let tinted = false;
  placements.forEach((placement, index) => {
    object.position.set(placement.x, placement.z, -placement.y);
    object.rotation.set(0, placement.yaw, 0);
    object.scale.set(placement.sx, placement.sy, placement.sz);
    object.updateMatrix();
    mesh.setMatrixAt(index, object.matrix);
    if (placement.tint) {
      mesh.setColorAt(index, placement.tint);
      tinted = true;
    }
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (tinted && mesh.instanceColor) {
    mesh.instanceColor.setUsage(DynamicDrawUsage);
    mesh.instanceColor.needsUpdate = true;
  }
  mesh.computeBoundingSphere();

  // Every instance's bounding sphere, from the larger of the model's reach
  // and the plant's close-up model's (`setNear` swaps them).
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const reach = Math.max(geometry.boundingSphere?.radius ?? 1, near?.boundingSphere?.radius ?? 0);
  const centre = geometry.boundingSphere?.center ?? new Vector3();
  const spheres = new Float32Array(placements.length * 4);
  const point = new Vector3();
  const matrix = new Matrix4();
  for (let i = 0; i < placements.length; i++) {
    mesh.getMatrixAt(i, matrix);
    point.copy(centre).applyMatrix4(matrix);
    const p = placements[i] as Placement;
    spheres[i * 4] = point.x;
    spheres[i * 4 + 1] = point.y;
    spheres[i * 4 + 2] = point.z;
    spheres[i * 4 + 3] = reach * Math.max(p.sx, p.sy, p.sz);
  }
  instances.set(mesh, {
    matrices: Float32Array.from(mesh.instanceMatrix.array as Float32Array),
    colours: tinted && mesh.instanceColor ? Float32Array.from(mesh.instanceColor.array as Float32Array) : null,
    spheres,
    count: placements.length,
    bounds: boundsOf(spheres, placements.length),
  });
  return mesh;
}

const instances = new WeakMap<InstancedMesh, Instances>();
const probe = new Sphere();

/** One sphere round every instance's own sphere: the centre of them, and the reach to the farthest. */
function boundsOf(spheres: Float32Array, count: number): { x: number; y: number; z: number; r: number } {
  if (count === 0) return { x: 0, y: 0, z: 0, r: 0 };
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < count; i++) { x += spheres[i * 4]!; y += spheres[i * 4 + 1]!; z += spheres[i * 4 + 2]!; }
  x /= count; y /= count; z /= count;
  let r = 0;
  for (let i = 0; i < count; i++) {
    const dx = spheres[i * 4]! - x, dy = spheres[i * 4 + 1]! - y, dz = spheres[i * 4 + 2]! - z;
    r = Math.max(r, Math.hypot(dx, dy, dz) + spheres[i * 4 + 3]!);
  }
  return { x, y, z, r };
}

/** A near-white multiplier, so no two plants of one species are identical. */
export function foliageTint(rng: Rng): Color {
  const warm = rng.float();
  return new Color(0.9 + warm * 0.18, 0.93 + rng.float() * 0.12, 0.86 + (1 - warm) * 0.14);
}

/** Picks a species for a street tree: mostly planes, some flowering ipês. */
function streetSpecies(roll: number): TreeSpecies {
  if (roll < 0.55) return 'broadleafTall';
  if (roll < 0.78) return 'broadleaf';
  return roll < 0.89 ? 'ipeYellow' : 'ipePink';
}

export interface ScenerySettings {
  /** Grass clumps. */
  readonly grass: number;
}

/**
 * The ground cover of the open land: grass and wildflowers at close zoom.
 *
 * No trees or bushes are scattered over the terrain or along the roads any
 * more (the player's order of 2026-10-05): every tree on the map is one the
 * player planted with the landscaping tool, or one of a building's gardens.
 */
export function buildScenery(
  net: Network,
  elevation: RoadElevation,
  terrainAt: (x: number, y: number) => number,
  wetAt: (x: number, y: number) => boolean,
  settings: ScenerySettings,
  kit: SceneryKit,
): Scenery {
  // No grass grows by itself (the player's order of 2026-10-05): long grass
  // is placed with the landscaping tool and drawn with the street furniture.
  void settings;
  const grass: GrassField = buildGrass(net, elevation, terrainAt, wetAt, 0, kit);
  return {
    meshes: [],
    grass: grass.group,
    triangles: grass.triangles,
    setNear() {},
    setMap() {},
    cull(frustum, view) {
      if (grass.group.visible) grass.cull(frustum, view);
    },
    exclude() {},
    dispose() {
      grass.dispose();
    },
  };
}

/**
 * What the player placed on the footways (`world/streetFurniture.ts`): street
 * lights, benches, bins, hydrants, post boxes, street trees in their pits and
 * shrubs. Rebuilt on `doc.utilityRevision`, so placing a bench rebuilds this
 * and nothing else.
 */
export function buildStreetFurniture(net: Network, elevation: RoadElevation, kit: SceneryKit,
  terrainAt: (x: number, y: number) => number = () => 0, now = Number.NaN): Scenery {
  const furniture = new Map<string, Placement[]>();
  const put = (key: string, placement: Placement): void => {
    const list = furniture.get(key);
    if (list) list.push(placement);
    else furniture.set(key, [placement]);
  };
  const trees = new Map<TreeSpecies, Placement[]>(TREE_SPECIES.map((s) => [s, []]));
  const bushes = new Map<BushKind, Placement[]>(BUSH_KINDS.map((k) => [k, []]));
  const lens = kit.lens;

  // On the item's OWN road. The unfiltered field answers for whichever road is
  // nearest, and a lamp on a street passing under a viaduct was lifted onto the
  // deck above it.
  const deckAt = (item: FurnitureItem): number => elevation.onSegment(item.segment, item.x, item.y) + footwayRiseAt(net, item.x, item.y);
  for (const item of streetFurniture(net)) {
    const base = deckAt(item);
    // Local +X of a lamp reaches over the road; local -Z of a bench, a post
    // box or a hydrant turns its back on the road.
    const inward = angleOf({ x: -item.outward.x, y: -item.outward.y });
    const facing = angleOf({ x: item.outward.y, y: -item.outward.x });
    const at = { x: item.x, y: item.y, z: base, sx: 1, sy: 1, sz: 1 };
    switch (item.kind) {
      case 'lamp': {
        put('lamp', { ...at, yaw: inward });
        // The light falls over the road and the footway behind the lamp:
        // across, the carriageway's width; along it, POOL_ALONG mounting
        // heights each way. Local X of the pool runs across the road.
        const road = net.ribbons.get(item.segment)?.road;
        const across = Math.max(LAMP_POOL_RADIUS, (road ? road.width : m(7)) * 0.55 + m(2.5));
        const centre = Math.max(LAMP_OUTREACH * 0.85, across - m(3));
        put('pool', { x: item.x - item.outward.x * centre, y: item.y - item.outward.y * centre, z: base + m(0.012),
          yaw: inward, sx: across, sy: 1, sz: LAMP_HEIGHT * POOL_ALONG });
        // And the cone it is lit by, from the lens down to the road under it.
        put('beam', { x: item.x - item.outward.x * lens.reach, y: item.y - item.outward.y * lens.reach, z: base + lens.height,
          yaw: 0, sx: LAMP_BEAM_RADIUS, sy: lens.height + FOOTWAY_RISE, sz: LAMP_BEAM_RADIUS });
        break;
      }
      case 'bin':
        put('bin', { ...at, yaw: item.seed * Math.PI * 2 });
        break;
      case 'bench': {
        // Its seat faces where the layout says somebody sitting looks.
        const faces = item.faces ?? { x: -item.outward.x, y: -item.outward.y };
        put('bench', { ...at, yaw: angleOf({ x: -faces.y, y: faces.x }) });
        break;
      }
      case 'postbox':
      case 'hydrant':
      case 'phone':
      case 'drain':
        // Built facing -Z; turned so the phone's shell opens to the footway
        // and the drain's grate lies in the gutter on the road side.
        put(item.kind, { ...at, yaw: facing + Math.PI });
        break;
      case 'streetTree': {
        put('treePit', { ...at, yaw: angleOf(item.along) });
        // Planted young, it grows to its full height over a few days.
        const height = (STREET_TREE_MIN + item.seed * STREET_TREE_RANGE) * plantGrowth(item.planted, now);
        const rng = new Rng(Math.floor(item.seed * 0xffffff));
        (trees.get(streetSpecies(rng.float())) as Placement[]).push({
          x: item.x,
          y: item.y,
          z: base + m(0.03),
          yaw: rng.float() * Math.PI * 2,
          sx: height * (0.85 + rng.float() * 0.2),
          sy: height,
          sz: height * (0.85 + rng.float() * 0.2),
          tint: foliageTint(rng),
        });
        break;
      }
      case 'shrub': {
        const rng = new Rng(Math.floor(item.seed * 0xffffff));
        const height = (m(0.8) + rng.float() * m(0.4)) * plantGrowth(item.planted, now);
        (bushes.get(rng.float() < 0.4 ? 'bushFlowering' : 'bush') as Placement[]).push({
          x: item.x,
          y: item.y,
          z: base - m(0.05),
          yaw: rng.float() * Math.PI * 2,
          sx: height * 1.05,
          sy: height,
          sz: height * 1.05,
          tint: foliageTint(rng),
        });
        break;
      }
    }
  }

  const meshes = [
    build('street-lights', kit.furniture.lamp, kit.props, furniture.get('lamp') ?? []),
    build('street-light-lamps', kit.lampLens, kit.glow, furniture.get('lamp') ?? []),
    build('street-light-pools', kit.pool, kit.poolGlow, furniture.get('pool') ?? []),
    build('street-light-beams', kit.beam, kit.beamGlow, furniture.get('beam') ?? []),
    build('street-bins', kit.furniture.bin, kit.props, furniture.get('bin') ?? []),
    build('benches', kit.furniture.bench, kit.props, furniture.get('bench') ?? []),
    build('hydrants', kit.furniture.hydrant, kit.props, furniture.get('hydrant') ?? []),
    build('post-boxes', kit.furniture.postbox, kit.props, furniture.get('postbox') ?? []),
    build('phones', kit.furniture.phone, kit.props, furniture.get('phone') ?? []),
    build('drains', kit.furniture.drain, kit.props, furniture.get('drain') ?? []),
    build('tree-pits', kit.treePit, kit.props, furniture.get('treePit') ?? []),
  ].filter((mesh): mesh is InstancedMesh => mesh !== null);

  /** Each plant mesh with its two models, near first. */
  const plants: [InstancedMesh, BufferGeometry, BufferGeometry][] = [];
  plantMeshes('street-', trees, bushes, kit, meshes, plants);
  const leafMeshes = meshes.filter((mesh) => mesh.name.endsWith('-leaves'));
  // The lens is lit from inside; it neither casts nor takes a shadow.
  for (const mesh of meshes) {
    if (mesh.name === 'street-light-lamps' || mesh.name === 'tree-pits' || mesh.name === 'street-light-pools' || mesh.name === 'street-light-beams') mesh.castShadow = false;
    if (mesh.name === 'street-light-pools') { mesh.receiveShadow = false; mesh.renderOrder = 3; }
    if (mesh.name === 'street-light-beams') { mesh.receiveShadow = false; mesh.renderOrder = 4; }
  }

  let triangles = 0;
  for (const mesh of meshes) triangles += trianglesOf(mesh.geometry) * mesh.count;
  let culledFor: Matrix4 | null = null;
  let nearMode: boolean | null = null;
  let mapMode: boolean | null = null;

  // Long grass placed on open ground (Paisagismo > Mato).
  const meadows = [...net.doc.landscape.values()].filter((item) => item.kind === 'meadow');
  const meadow = buildGrass(net, elevation, terrainAt, () => false, 0, kit, meadows);
  triangles += meadow.triangles;

  return {
    meshes,
    grass: meadow.group,
    triangles,
    setNear(near) {
      if (nearMode === near) return;
      nearMode = near;
      for (const [mesh, close, far] of plants) mesh.geometry = near ? close : far;
    },
    setMap(map) {
      if (mapMode === map) return;
      mapMode = map;
      culledFor = null;
      for (const mesh of leafMeshes) mesh.visible = !map;
    },
    cull(frustum, view) {
      if (culledFor && culledFor.equals(view)) return;
      culledFor = (culledFor ?? new Matrix4()).copy(view);
      cullInstances(meshes, null, frustum, mapMode === true);
      meadow.cull(frustum, view);
    },
    exclude() {},
    dispose() {
      for (const mesh of meshes) mesh.dispose();
      meadow.dispose();
    },
  };
}

/** Copies the instances of each mesh the frustum can see (or see the shadow of) to the front, skipping `excluded`. */
function cullInstances(meshes: readonly InstancedMesh[], excluded: Map<InstancedMesh, Uint8Array> | null, frustum: Frustum, mapMode: boolean): void {
  for (const mesh of meshes) {
    if (mapMode && mesh.name.endsWith('-leaves')) continue;
    const all = instances.get(mesh);
    if (!all) continue;
    const matrices = mesh.instanceMatrix.array as Float32Array;
    const colours = all.colours && mesh.instanceColor ? mesh.instanceColor.array as Float32Array : null;
    // The whole mesh, before its instances one by one: a mesh entirely out of
    // view - most of them, most frames - used to have every instance tested
    // and its buffers rewritten to hold nothing. The sphere is the one built
    // over every instance (`build`), grown by the shadow reach the per-instance
    // test allows, so a miss here cannot hide an instance that test would keep.
    if (all.bounds) {
      probe.center.set(all.bounds.x, all.bounds.y, all.bounds.z);
      probe.radius = all.bounds.r + SHADOW_REACH;
      if (!frustum.intersectsSphere(probe)) {
        if (mesh.count !== 0) {
          mesh.count = 0;
          mesh.instanceMatrix.clearUpdateRanges();
          mesh.instanceMatrix.needsUpdate = true;
          if (colours && mesh.instanceColor) {
            mesh.instanceColor.clearUpdateRanges();
            mesh.instanceColor.needsUpdate = true;
          }
        }
        continue;
      }
    }
    let n = 0;
    const hidden = excluded?.get(mesh);
    for (let i = 0; i < all.count; i++) {
      if (hidden && hidden[i]) continue;
      const s = all.spheres;
      probe.center.set(s[i * 4] as number, s[i * 4 + 1] as number, s[i * 4 + 2] as number);
      probe.radius = (s[i * 4 + 3] as number) + SHADOW_REACH;
      if (!frustum.intersectsSphere(probe)) continue;
      const source = i * 16;
      const target = n * 16;
      for (let j = 0; j < 16; j++) matrices[target + j] = all.matrices[source + j]!;
      if (colours && all.colours) {
        const sourceColour = i * 3;
        const targetColour = n * 3;
        colours[targetColour] = all.colours[sourceColour]!;
        colours[targetColour + 1] = all.colours[sourceColour + 1]!;
        colours[targetColour + 2] = all.colours[sourceColour + 2]!;
      }
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.clearUpdateRanges();
    if (n > 0) mesh.instanceMatrix.addUpdateRange(0, n * 16);
    mesh.instanceMatrix.needsUpdate = true;
    if (colours && mesh.instanceColor) {
      mesh.instanceColor.clearUpdateRanges();
      if (n > 0) mesh.instanceColor.addUpdateRange(0, n * 3);
      mesh.instanceColor.needsUpdate = true;
    }
  }
}

import {
  AdditiveBlending,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  FrontSide,
  Frustum,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  ShaderMaterial,
  type BufferGeometry,
  Group,
  type Material,
  type MeshDepthMaterial,
} from 'three';

import type { Rng } from '@core/rng';
import type { FurnitureKind } from '@world/streetFurniture';
import { m, perM } from '@world/units';
import { applyWind, windDepthMaterial, type WindResponse } from './wind';
import { leafCardMaterials } from './lowPolyTrees';
import { lightPoolTexture } from './lightLevels';
import { pullTowardEye } from './depthConvention';
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
  postboxGeometry,
  phoneGeometry,
  drainGeometry,
  treeParts,
  treePitGeometry,
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
export const POOL_ALONG = 1.6;
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
    depthWrite: false, toneMapped: false,
  });
  pullTowardEye(poolGlow, 4, 4);
  const beam = new CylinderGeometry(BEAM_SOURCE, 1, 1, BEAM_SIDES, BEAM_SEGMENTS, true);
  beam.translate(0, -0.5, 0);
  // Their bounds once, here: the layers that instance them read them (`render/poleLayer.ts`).
  pool.computeBoundingSphere();
  beam.computeBoundingSphere();
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
 * One of every plant as the gardens and the street draw them, with and
 * without a tint of their own (an instance colour is a program variant), and
 * each as its shadow pass draws it (its depth material), for compiling their
 * programs ahead (three's `compileAsync`: objects to be added later are
 * precompiled before they are drawn). The first lots painted grew gardens
 * whose programs were built in that frame: some 600 ms on the first stroke of
 * the zone brush.
 */
export function plantSamples(kit: SceneryKit): { readonly group: Group; readonly depth: Group; dispose(): void } {
  const meshes: InstancedMesh[] = [];
  const models: [BufferGeometry, Material, MeshDepthMaterial][] = [];
  for (const species of TREE_SPECIES) {
    models.push([kit.trees[species], kit.foliage, kit.foliageDepth]);
    const cards = kit.cards[species];
    if (cards) models.push([cards, kit.treeCards, kit.treeCardsDepth]);
  }
  for (const kind of BUSH_KINDS) {
    models.push([kit.bushes[kind], kit.shrubs, kit.shrubsDepth]);
    const cards = kit.cards[kind];
    if (cards) models.push([cards, kit.shrubCards, kit.shrubCardsDepth]);
  }
  const group = new Group(), depth = new Group();
  for (const tinted of [false, true]) {
    for (const [geometry, material, depthMaterial] of models) {
      const mesh = new InstancedMesh(geometry, material, 1);
      mesh.setMatrixAt(0, new Matrix4());
      if (tinted) mesh.setColorAt(0, new Color(1, 1, 1));
      mesh.customDepthMaterial = depthMaterial;
      meshes.push(mesh);
      group.add(mesh);
      const shadow = new InstancedMesh(geometry, depthMaterial, 1);
      shadow.instanceMatrix.copy(mesh.instanceMatrix);
      if (mesh.instanceColor) shadow.instanceColor = mesh.instanceColor;
      depth.add(shadow);
    }
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
   * is done while it is unchanged. Call it after setting the meshes'
   * `visible`: a hidden mesh may be left as it was until it is shown.
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

/*
 * Each species used to be ONE instanced mesh spread over the whole map, so
 * its bounding sphere was the map and nothing was ever off screen: zoomed in
 * on a crossroads, every bush on the map went to the GPU in close-up detail,
 * three times over (picture, shadow map, occlusion). The instances in view
 * are copied to the front of the buffer when the camera moves, and only
 * those are drawn, found cell by cell down a quadtree of the ground
 * (`instanceRuns.ts`, `gardens.ts`).
 */

/** Zoom at and above which plants are drawn with their close-up models. */
export const PLANT_NEAR_ZOOM = perM(3.5);
/** Below this zoom the plants' leaf cards are left out (`Scenery.setMap`). */
export const PLANT_MAP_ZOOM = perM(2.5);

/** A near-white multiplier, so no two plants of one species are identical. */
export function foliageTint(rng: Rng): Color {
  const warm = rng.float();
  return new Color(0.9 + warm * 0.18, 0.93 + rng.float() * 0.12, 0.86 + (1 - warm) * 0.14);
}

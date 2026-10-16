import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  RedFormat,
  Scene,
  Sphere,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type InstancedMesh,
  type MeshDepthMaterial,
  type WebGLRenderer,
} from 'three';
import { FRAMES, FRAME_PX, IMPOSTOR_FRAMES_GLSL, IMPOSTOR_READ_GLSL, bakeMaterials, bakeShadowMaterials, frameBasis, hemiOctaDirection } from './impostorShaders';
import { BUSH_KINDS, TREE_SPECIES, type BushKind, type TreeSpecies } from './propGeometry';
import { applyWind, windDepthMaterial, type WindResponse } from './wind';

/**
 * THE NEAR PLANTS' FAR PICTURES: each tree and bush model taken once from 8 x 8 directions over the
 * upper hemi-octahedron (Ryan Brucks, "Octahedral Impostors", shaderbits.com, 2018; the far woods'
 * own pictures, `farForest.ts`), drawn as one quad an instance where the model would be a few pixels.
 * Under `THIN_PX` the pictures are thinned and the ones kept grown to keep the cover (Cook, Halstead,
 * Planck, Ryu, "Stochastic Simplification of Aggregate Detail", SIGGRAPH 2007): no plant is drawn
 * smaller than a couple of pixels, none thrown into the shadow map under a texel.
 */

/** A model to take pictures of: its body, its foliage cards, and whether the cards throw its shadow (a palm's fronds). */
export interface ImpostorModel {
  readonly body: BufferGeometry;
  readonly cards: BufferGeometry | null;
  readonly cardsCast: boolean;
}

/** Device pixels across under which a picture is thinned: a share kept, each grown back to this size. */
export const THIN_PX = 2;
/** The margin of the share kept, over which a plant shrinks away rather than vanishing. */
const THIN_MARGIN = 0.15;

/** A plant's pick (0..1): the bits of its place hashed, as `impostorPick` hashes them on the GPU (the same float32 bits, the same integer steps). */
export function impostorPick(x: number, y: number, z: number): number {
  pickFloats[0] = x; pickFloats[1] = y; pickFloats[2] = z;
  let h = Math.imul(pickBits[0]! ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h ^ pickBits[1]!, 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h ^ pickBits[2]!, 0x27d4eb2f) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return (h >>> 8) / 16_777_216;
}
const pickFloats = new Float32Array(3);
const pickBits = new Uint32Array(pickFloats.buffer);

/** The share of plants this many pixels across that the pictures keep, with its margin: a plant whose pick is under it may be drawn. */
export function thinWant(across: number): number {
  const keep = Math.min(1, (across / THIN_PX) ** 2);
  return keep * (1 + THIN_MARGIN);
}

const PICK_GLSL = /* glsl */ `
  float impostorPick(vec3 p) {
    uvec3 b = floatBitsToUint(p);
    uint h = (b.x ^ 0x9e3779b9u) * 0x85ebca6bu;
    h ^= h >> 13u;
    h = (h ^ b.y) * 0xc2b2ae35u;
    h ^= h >> 16u;
    h = (h ^ b.z) * 0x27d4eb2fu;
    h ^= h >> 15u;
    return float(h >> 8u) / 16777216.0;
  }
  /** How much a plant this many pixels across is grown (0: not drawn), the share kept by its pick. */
  float impostorThin(float across, float pick) {
    float keep = min(1.0, (across / uThin.x) * (across / uThin.x));
    float grow = clamp((keep * ${(1 + THIN_MARGIN).toFixed(3)} - pick) / max(keep * ${THIN_MARGIN.toFixed(3)}, 1e-6), 0.0, 1.0);
    return grow * inversesqrt(max(keep, 1e-6));
  }
`;

const VARYINGS = /* glsl */ `
  varying vec2 vFrameUv1;
  varying vec2 vFrameUv2;
  varying vec2 vFrameUv3;
  flat varying vec2 vFrame1;
  flat varying vec2 vFrame2;
  flat varying vec2 vFrame3;
  flat varying vec3 vWeights;
  flat varying vec2 vBlock;
`;

/** The vertex shader's declarations; `shadow`: the shadow pass's. */
const vertexPars = (shadow: boolean): string => /* glsl */ `
  ${IMPOSTOR_FRAMES_GLSL}
  attribute vec4 aSphere;
  attribute vec2 aBlock;
  uniform mat4 uCullView;
  uniform vec4 uThin;
  ${VARYINGS}
  ${shadow ? '' : 'flat varying mat3 vNormalToWorld;'}
  ${PICK_GLSL}
`;

/**
 * In place of three's `begin_vertex`: `transformed` is the picture's corner in the model's own frame
 * (three's instancing and the wind place it), facing the eye - or the light, in the shadow pass.
 */
const vertexMain = (shadow: boolean): string => /* glsl */ `
  vec3 transformed = vec3(0.0);
  {
    vec3 foot = instanceMatrix[3].xyz;
    mat3 shape = mat3(instanceMatrix);
    float scale = max(length(shape[0]), max(length(shape[1]), length(shape[2])));
    // Its size on the screen the instances were culled for, in device pixels: the cull's own measure (\`cellInstances.ts\`).
    vec4 cullClip = uCullView * vec4(foot, 1.0);
    float perUnit = length(vec3(uCullView[0][1], uCullView[1][1], uCullView[2][1])) * uThin.y / max(cullClip.w, 1e-4);
    float across = 2.0 * aSphere.w * scale * perUnit;
    float pick = impostorPick(foot);
    float grown = impostorThin(across, pick);
    ${shadow ? `
    // In the shadow map: one under a texel thinned again among the ones kept, the same way.
    float texels = 2.0 * aSphere.w * scale * grown * projectionMatrix[1][1] * uThin.z;
    float kept = min(1.0, (across / uThin.x) * (across / uThin.x)) * ${(1 + THIN_MARGIN).toFixed(3)};
    float keepShadow = min(1.0, texels * texels);
    float growShadow = clamp((keepShadow * ${(1 + THIN_MARGIN).toFixed(3)} - min(pick / max(kept, 1e-6), 1.0)) / max(keepShadow * ${THIN_MARGIN.toFixed(3)}, 1e-6), 0.0, 1.0);
    grown *= growShadow * inversesqrt(max(keepShadow, 1e-6));` : ''}
    if (grown > 0.0) {
      mat3 toModel = inverse(shape);
      vec3 eyeWorld = cameraPosition;
      if (projectionMatrix[2][3] == 0.0) eyeWorld = foot + vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]) * 1.0e5;
      vec3 eye = toModel * (eyeWorld - foot) - aSphere.xyz;
      vec3 dir = normalize(eye);
      // Never from below: the lowest pictures are level.
      dir = normalize(vec3(dir.x, max(dir.y, 0.0), dir.z) + vec3(0.0, 1e-5, 0.0));
      vec3 qx, qy;
      frameBasis(dir, qx, qy);
      vec3 corner = (qx * position.x + qy * position.y) * (2.0 * aSphere.w);
      vec3 ray = normalize(corner - eye);
      vec2 grid = hemiOctaEncode(dir) * (FRAMES - 1.0);
      vec2 cell = min(floor(grid), vec2(FRAMES - 2.0));
      vec2 f = clamp(grid - cell, 0.0, 1.0);
      vec3 w = vec3(min(1.0 - f.x, 1.0 - f.y), abs(f.x - f.y), min(f.x, f.y));
      vWeights = w / max(w.x + w.y + w.z, 1e-4);
      vFrame1 = cell;
      vFrame2 = cell + (f.x >= f.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
      vFrame3 = cell + vec2(1.0);
      vFrameUv1 = frameUv(vFrame1, eye, ray, aSphere.w);
      vFrameUv2 = frameUv(vFrame2, eye, ray, aSphere.w);
      vFrameUv3 = frameUv(vFrame3, eye, ray, aSphere.w);
      vBlock = aBlock;
      ${shadow
        ? '// Behind its own sphere from the light: the picture facing the eye is never in its own shadow.\n      corner -= dir * aSphere.w;'
        : 'vNormalToWorld = transpose(toModel);'}
      transformed = (aSphere.xyz + corner) * grown;
    }
  }
`;

const FRAGMENT_PARS = /* glsl */ `
  ${IMPOSTOR_READ_GLSL}
  uniform vec2 uBlocks;
  ${VARYINGS}
`;

/** Each picture's uv change across the pixel, on the atlas, taken before anything is discarded. */
const FRAGMENT_SLOPES = /* glsl */ `
  vec2 impostorAtlas = FRAMES * uBlocks;
  vec2 impostorDx1 = dFdx(vFrameUv1) / impostorAtlas, impostorDy1 = dFdy(vFrameUv1) / impostorAtlas;
  vec2 impostorDx2 = dFdx(vFrameUv2) / impostorAtlas, impostorDy2 = dFdy(vFrameUv2) / impostorAtlas;
  vec2 impostorDx3 = dFdx(vFrameUv3) / impostorAtlas, impostorDy3 = dFdy(vFrameUv3) / impostorAtlas;
`;
const readOf = (atlas: string): string => /* glsl */ `(
    impostorRead(${atlas}, vFrameUv1, vFrame1, vBlock, uBlocks, impostorDx1, impostorDy1) * vWeights.x
    + impostorRead(${atlas}, vFrameUv2, vFrame2, vBlock, uBlocks, impostorDx2, impostorDy2) * vWeights.y
    + impostorRead(${atlas}, vFrameUv3, vFrame3, vBlock, uBlocks, impostorDx3, impostorDy3) * vWeights.z)`;

/** In place of three's `map_fragment`: the pictures' colour, the cover kept as the mips thin it (`farForest.ts`). */
const COLOUR_MAP = /* glsl */ `
  ${FRAGMENT_SLOPES}
  vec4 impostorColour = ${readOf('uAlbedo')};
  {
    vec2 texel = vec2(textureSize(uAlbedo, 0));
    float lod = max(0.0, 0.5 * log2(max(dot(impostorDx1 * texel, impostorDx1 * texel), dot(impostorDy1 * texel, impostorDy1 * texel))));
    float cover = impostorColour.a * (1.0 + lod * 0.3);
    cover = clamp((cover - 0.5) / max(fwidth(cover), 1e-4) + 0.5, 0.0, 1.0);
    if (cover < 0.01) discard;
    // Stored premultiplied and gamma-encoded (\`bakeMaterials\`); the plant's own tint is three's instance colour.
    diffuseColor = vec4(diffuseColor.rgb * pow(impostorColour.rgb / max(impostorColour.a, 1e-4), vec3(2.2)), cover);
  }
`;

/** After three's `normal_fragment_begin`: the pictures' normal, from the model's frame to the view's. */
const COLOUR_NORMAL = /* glsl */ `
  {
    vec4 packed = ${readOf('uNormals')};
    vec3 n = normalize(packed.rgb / max(packed.a, 1e-4) * 2.0 - 1.0);
    normal = normalize(mat3(viewMatrix) * normalize(vNormalToWorld * n));
    nonPerturbedNormal = normal;
  }
`;

/** Before three's `alphatest_fragment` in the shadow pass: the outline that throws the shadow (the body's, `bakeShadowMaterials`). */
const SHADOW_CUT = /* glsl */ `
  {
    ${FRAGMENT_SLOPES}
    float impostorCover = ${readOf('uShadow')}.r;
    if (impostorCover < 0.5) discard;
    diffuseColor.a = impostorCover;
  }
`;

interface Picture {
  readonly centre: Vector3;
  readonly radius: number;
}

/** A model's sphere: round the box of its body and its cards reaching out from their centres. */
function pictureOf(model: ImpostorModel): Picture {
  const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
  const grow = (g: BufferGeometry, reach: number): void => {
    const p = g.getAttribute('position');
    for (let v = 0; v < p.count; v++) {
      min.set(Math.min(min.x, p.getX(v) - reach), Math.min(min.y, p.getY(v) - reach), Math.min(min.z, p.getZ(v) - reach));
      max.set(Math.max(max.x, p.getX(v) + reach), Math.max(max.y, p.getY(v) + reach), Math.max(max.z, p.getZ(v) + reach));
    }
  };
  grow(model.body, 0);
  if (model.cards) {
    const c = model.cards.getAttribute('aCorner');
    let corner = 0;
    for (let v = 0; v < c.count; v++) corner = Math.max(corner, Math.hypot(c.getX(v), c.getY(v)));
    grow(model.cards, corner);
  }
  // The sphere round the box: every view of the model fits its picture.
  return { centre: min.clone().add(max).multiplyScalar(0.5), radius: max.clone().sub(min).length() / 2 };
}

/** Blocks across and down for `n` models: the fewest texels, no side over 4 blocks (2,048 texels). */
function layoutOf(n: number): { x: number; y: number } {
  let best = { x: 4, y: Math.ceil(n / 4) };
  for (let x = 4; x >= 1; x--) {
    const y = Math.ceil(n / x);
    if (y <= 4 && x * y < best.x * best.y) best = { x, y };
  }
  return best;
}

export interface PlantImpostors {
  /** Each model's quad: four corners, its sphere and its block on the atlas in their attributes. */
  readonly quads: readonly BufferGeometry[];
  /** Each model's sphere radius, one unit tall: the size a plant's level is chosen by (`cellInstances.ts`). */
  readonly reach: readonly number[];
  readonly material: MeshStandardMaterial;
  readonly depth: MeshDepthMaterial;
  /** The view the instances were culled for and half the screen's height, device pixels: what the pictures thin by. */
  setView(view: Matrix4, halfHeight: number): void;
  /** Whether the pictures are taken (`takeWaitingPictures`): until then the plants are drawn whole. */
  ready(): boolean;
  /** A mesh drawn with the pictures: the shadow map's size read before its shadow. */
  attach(mesh: InstancedMesh): void;
  dispose(): void;
}

/** Picture sets not taken yet: taken at the next `takeWaitingPictures`. */
const waiting = new Set<(renderer: WebGLRenderer) => void>();

/** Takes the pictures of every set made since, between draws (`farForest.ts` `update`, as it takes its own): never inside a draw. */
export function takeWaitingPictures(renderer: WebGLRenderer): void {
  for (const take of [...waiting]) take(renderer);
}

/** The pictures of these models, taken at the next `takeWaitingPictures`; `key` names their programs. */
export function createPlantImpostors(models: readonly ImpostorModel[], wind: WindResponse, key: string): PlantImpostors {
  const pictures = models.map(pictureOf);
  const blocks = layoutOf(models.length);
  const block = FRAMES * FRAME_PX;
  // Two pictures per view, the colour and the normal; and the outline that throws the shadow.
  const atlas = new WebGLRenderTarget(blocks.x * block, blocks.y * block, { count: 2, depthBuffer: true, generateMipmaps: true });
  const outline = new WebGLRenderTarget(blocks.x * block, blocks.y * block, { format: RedFormat, depthBuffer: false, generateMipmaps: true });
  for (const t of [...atlas.textures, outline.texture]) { t.minFilter = LinearMipmapLinearFilter; t.magFilter = LinearFilter; }
  const uniforms = {
    uAlbedo: { value: atlas.textures[0]! },
    uNormals: { value: atlas.textures[1]! },
    uShadow: { value: outline.texture },
    uBlocks: { value: new Vector2(blocks.x, blocks.y) },
    uCullView: { value: new Matrix4() },
    // Pixels under which pictures thin; half the screen's height, device pixels; half the shadow map's, texels.
    uThin: { value: new Vector4(THIN_PX, 540, 2048, 0) },
  };

  const material = new MeshStandardMaterial({ roughness: 0.85, metalness: 0, envMapIntensity: 0.35, alphaToCoverage: true });
  // The quad faces the light in the shadow pass: three would draw only its back.
  material.shadowSide = DoubleSide;
  applyWind(material, wind, `${key}-impostor`);
  const windColour = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    windColour(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexPars(false)}`)
      .replace('#include <begin_vertex>', vertexMain(false));
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}\nuniform sampler2D uAlbedo;\nuniform sampler2D uNormals;\nflat varying mat3 vNormalToWorld;`)
      .replace('#include <map_fragment>', COLOUR_MAP)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>\n${COLOUR_NORMAL}`);
  };
  material.customProgramCacheKey = () => `plant-impostor-${key}`;

  const depth = windDepthMaterial(wind, `${key}-impostor`);
  const windDepth = depth.onBeforeCompile.bind(depth);
  depth.onBeforeCompile = (shader, renderer) => {
    windDepth(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexPars(true)}`)
      .replace('#include <begin_vertex>', vertexMain(true));
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}\nuniform sampler2D uShadow;`)
      .replace('#include <alphatest_fragment>', `${SHADOW_CUT}\n#include <alphatest_fragment>`);
  };
  depth.customProgramCacheKey = () => `plant-impostor-depth-${key}`;

  const quads = pictures.map((picture, k) => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
    const sphere = [picture.centre.x, picture.centre.y, picture.centre.z, picture.radius];
    g.setAttribute('aSphere', new BufferAttribute(new Float32Array([...sphere, ...sphere, ...sphere, ...sphere]), 4));
    const at = [k % blocks.x, Math.floor(k / blocks.x)];
    g.setAttribute('aBlock', new BufferAttribute(new Float32Array([...at, ...at, ...at, ...at]), 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    // The model's own sphere: what the instances are culled by.
    g.boundingSphere = new Sphere(picture.centre.clone(), picture.radius);
    return g;
  });

  let baked = false;
  /** The pictures taken, once, between draws (the far woods' own way, `farForest.ts` `takePictures`). */
  const bake = (renderer: WebGLRenderer): void => {
    baked = true;
    waiting.delete(bake);
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
    const scene = new Scene();
    const colours = bakeMaterials(), shadows = bakeShadowMaterials();
    const was = {
      target: renderer.getRenderTarget(), autoClear: renderer.autoClear, alpha: renderer.getClearAlpha(),
      shadows: renderer.shadowMap.autoUpdate, colour: renderer.getClearColor(new Color()),
    };
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    const direction = new Vector3(), tangent = new Vector3(), bitangent = new Vector3();
    for (const [target, pass] of [[atlas, 'colour'], [outline, 'shadow']] as const) {
      // Made with every mip level (three allocates them by `generateMipmaps` when the target is first set), made once after the last picture.
      target.scissorTest = false;
      target.viewport.set(0, 0, target.width, target.height);
      renderer.setRenderTarget(target);
      for (const t of target.textures) t.generateMipmaps = false;
      renderer.clear(true, true, true);
      target.scissorTest = true;
      const last = models.length * FRAMES * FRAMES - 1;
      let taken = 0;
      models.forEach((model, k) => {
        scene.clear();
        if (pass === 'colour') {
          scene.add(new Mesh(model.body, colours.body));
          if (model.cards) scene.add(new Mesh(model.cards, colours.cards));
        } else {
          scene.add(new Mesh(model.body, shadows.body));
          if (model.cards && model.cardsCast) scene.add(new Mesh(model.cards, shadows.cards));
        }
        const { centre, radius: r } = pictures[k]!;
        camera.left = -r; camera.right = r; camera.top = r; camera.bottom = -r;
        camera.near = 0.01 * r; camera.far = 4 * r;
        camera.updateProjectionMatrix();
        const bx = (k % blocks.x) * block, by = Math.floor(k / blocks.x) * block;
        for (let row = 0; row < FRAMES; row++) {
          for (let col = 0; col < FRAMES; col++) {
            hemiOctaDirection(col / (FRAMES - 1), row / (FRAMES - 1), direction);
            frameBasis(direction, tangent, bitangent);
            camera.position.copy(centre).addScaledVector(direction, 2 * r);
            camera.up.copy(bitangent);
            camera.lookAt(centre);
            camera.updateMatrixWorld();
            const x = bx + col * FRAME_PX, y = by + row * FRAME_PX;
            target.viewport.set(x, y, FRAME_PX, FRAME_PX);
            target.scissor.set(x, y, FRAME_PX, FRAME_PX);
            renderer.setRenderTarget(target);
            if (taken++ === last) for (const t of target.textures) t.generateMipmaps = true;
            renderer.render(scene, camera);
          }
        }
      });
      target.scissorTest = false;
      target.viewport.set(0, 0, target.width, target.height);
    }
    scene.clear();
    renderer.setRenderTarget(was.target);
    renderer.setClearColor(was.colour, was.alpha);
    renderer.autoClear = was.autoClear;
    renderer.shadowMap.autoUpdate = was.shadows;
    for (const m of [colours.body, colours.cards, shadows.body, shadows.cards]) m.dispose();
  };

  waiting.add(bake);
  const viewport = new Vector4();
  return {
    quads,
    reach: pictures.map((p) => p.radius),
    material,
    depth,
    setView(view, halfHeight) {
      uniforms.uCullView.value.copy(view);
      uniforms.uThin.value.y = halfHeight;
    },
    ready: () => baked,
    attach(mesh) {
      const shadow = mesh.onBeforeShadow.bind(mesh);
      mesh.onBeforeShadow = (renderer, ...rest) => {
        // The shadow map is the target being drawn: its height, texels.
        uniforms.uThin.value.z = renderer.getCurrentViewport(viewport).w / 2;
        shadow(renderer, ...rest);
      };
    },
    dispose() {
      waiting.delete(bake);
      for (const q of quads) q.dispose();
      material.dispose();
      depth.dispose();
      atlas.dispose();
      outline.dispose();
    },
  };
}

/** The trees' wind on their pictures (`scenery.ts` TREE_WIND, `natureTrees.ts` FOREST_WIND: the same breeze). */
export const PICTURE_WIND: WindResponse = { sway: 0.045, flutter: 0.009 };

/** Device pixels across under which a plant is drawn as its picture (the frames are `FRAME_PX` wide: never magnified past it). */
export const PICTURE_PX = 48;

/** The gardens' and the street's plants' pictures: the scenery's models, its trees then its bushes. */
export interface SceneryPictures {
  readonly set: PlantImpostors;
  treeAt(species: TreeSpecies): number;
  bushAt(kind: BushKind): number;
  /** Let go by a layer: the pictures go with the last one. */
  release(): void;
}

/** The plants of the scenery's kit the pictures are made of (`scenery.ts` SceneryKit): only these, so this file does not import the kit, which imports the poses that import the pictures. */
interface PlantModels {
  readonly trees: Readonly<Record<TreeSpecies, BufferGeometry>>;
  readonly bushes: Readonly<Record<BushKind, BufferGeometry>>;
  readonly cards: Readonly<Partial<Record<TreeSpecies | BushKind, BufferGeometry>>>;
}

const sceneryShared = new WeakMap<PlantModels, { set: PlantImpostors; users: number }>();
/** One set of pictures for the gardens and the street (`gardens.ts`, `streetFurnitureLayer.ts`): one atlas, one program. */
export function sceneryPictures(kit: PlantModels): SceneryPictures {
  let shared = sceneryShared.get(kit);
  if (!shared) {
    const models: ImpostorModel[] = [
      ...TREE_SPECIES.map((s) => ({ body: kit.trees[s], cards: kit.cards[s] ?? null, cardsCast: false })),
      ...BUSH_KINDS.map((k) => ({ body: kit.bushes[k], cards: kit.cards[k] ?? null, cardsCast: false })),
    ];
    sceneryShared.set(kit, shared = { set: createPlantImpostors(models, PICTURE_WIND, 'scenery'), users: 0 });
  }
  shared.users++;
  const held = shared;
  let released = false;
  return {
    set: held.set,
    treeAt: (species) => TREE_SPECIES.indexOf(species),
    bushAt: (kind) => TREE_SPECIES.length + BUSH_KINDS.indexOf(kind),
    release() {
      if (released) return;
      released = true;
      if (--held.users > 0) return;
      held.set.dispose();
      sceneryShared.delete(kit);
    },
  };
}

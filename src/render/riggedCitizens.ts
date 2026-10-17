import type { Severable } from '@sim/people/view';
import {
  BufferAttribute, BufferGeometry, Color, DataTexture, DynamicDrawUsage, FloatType, Group, InstancedBufferAttribute, InstancedMesh,
  Matrix4, MeshDepthMaterial, MeshStandardMaterial, Object3D, Quaternion, RGBAFormat,
  RGBADepthPacking, SkinnedMesh, Texture, Vector3, type WebGLRenderer,
} from 'three';
import { PIXAR, REALISTIC, type CartoonStyle } from './people/cartoon';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { personHash, type PartyView, type PedView } from '@sim/people/view';
import { DT } from '@sim/dt';
import { m, perM } from '@world/units';
import { CROWD, CROWD_IDS, CastingRegistry, type CastingContext, type Company } from './citizenCasting';
import { NO_HELMET, type RiderClipKey } from './riderPoses';
import { CITIZEN_ASSET_URLS, CITIZEN_LICENSES } from './citizenAssets';
import type { CitizenModel } from './citizenCasting';
import { cancelUploads, compileAhead, shadowStandIn, warmAhead } from './uploads';
import { bakeDeferredInWorker, bakeInWorker, bakeRig, buildPersonInWorker, releaseIdleBakeWorkers } from './bakePool';
import { assemblePerson, cookPerson } from './people/cookedPerson';
import { buildPersonScene } from './people/personBuild';
import { lodPool } from './people/lodPool';
import { providePeopleLod } from './people/lodPort';
import { loadCookedPerson, peopleCookHash } from './people/cookedLoad';
import { HELD, createHeldProps } from './people/heldProps';
import { applyFace, faceAt, type FaceWeights } from './people/faceExpression';
import { applySkinAppearance, createPersonLayers, loadSkinAppearance, releaseSkinAppearance, type SkinAppearance } from './people/skinAppearance';
import { loadRocketboxClips } from './citizenWalk';
import { type Gradient, shearMatrix } from './groundShear';
import { PACKED_BONE_FLOATS, SKIN_BONE_FLOATS, blendPackedFrames } from './citizenPalette';
import { GPU_PLAYS, appendClip, citizenAtlas, cpuPose, gpuPlays, type CitizenAtlas, type Play } from './citizenPlays';
import { createPalettePass, type PalettePass } from './people/crowdAnimation';
import { createGait, gaitHeading, gaitPlays, stepGait, type Gait, type GaitClips, type GaitPlay } from './citizenGait';
import {
  CARRY_AT, GAIT_AT, LIBRARY_AT, RIDER_AT, WALK, WALK_ELDER, WALK_SHUFFLE, afterFrame, bake, gaitClips,
  type CitizenClipKey, type ClipFrames, type Deferred, type Played, type RigNode,
} from './citizenBake';
import type { WalkSex } from './citizenWalk';
import { measureHitch } from '@core/hitch';

export type { CitizenClipKey } from './citizenBake';
export { CROWD_IDS } from './citizenCasting';
// The bodies built on this page simplify their levels in the page's pool (`lodPort.ts`).
providePeopleLod(lodPool);
const CAPACITY = 1000;
/** Instances a level's mesh starts with; it doubles with the figures drawn at that level (`growLevel`), up to `CAPACITY`. */
const LEVEL_START = 16;
/** One level of one part of a body: its own mesh, and each instance's palette row (`citizenRow`, read by the skinning). */
interface LevelMesh {
  readonly mesh: InstancedMesh;
  readonly rows: InstancedBufferAttribute;
  /** Figures written at this level this frame. */
  count: number;
  /** A slot's colour changed since the GPU took them (burnt, or a new buffer): DO NOT send every figure's colour every frame. */
  colourChanged: boolean;
}
/** A part of a body: its distinct levels' meshes, and which of them each level (`CITIZEN_LEVEL_ERROR`) is drawn with. */
interface CitizenPart {
  readonly levels: LevelMesh[];
  readonly at: number[];
}
interface CitizenBatch {
  resources: Set<{ dispose(): void }>;
  animationBytes: number;
  lastUsed: number;
  disposed: boolean;
  /** Every level mesh of every part (`parts`), as added to the group. */
  meshes: InstancedMesh[]; parts: CitizenPart[]; sources: SkinnedMesh[]; local: Matrix4[]; clips: ClipFrames[];
  /** The same baked clips, by the name the gait plays them by. */
  gait: GaitClips;
  /** Floats of a body's palette (16 a bone), and the bodies written this frame. */
  width: number; count: number;
  /** The skeletons blended on the GPU (`people/crowdAnimation.ts`): the clips' atlas, the pass, its rows; the skinning reads `uniform`. */
  atlas: CitizenAtlas; pass: PalettePass; rows: number; uniform: { value: Texture };
  /** Its first row in the palettes' shared target, read by the skinning. */
  readonly base: { value: number };
  /** A body's palette worked out on the CPU (held by a ragdoll, maimed, more plays than the pass takes). */
  readonly scratch: Float32Array;
  /** Rest joints for the pass's refit, all at the origin: the cooked bodies are drawn on their own joints. */
  readonly joints: DataTexture;
  readonly parents: Int16Array;
  /** This body's helmet in its head bone's frame (`riderPoses.helmetShape`), or null. */
  helmet: Matrix4 | null;
  /** Clips still to bake, on first use (`Deferred`), one at a time: in a worker, on the body's rig (`rigNodes`, made at the first). */
  deferred: Deferred;
  baking: Promise<void>;
  readonly sex: WalkSex;
  readonly scene: Object3D;
  rigNodes: readonly RigNode[] | null;
}

/** A walker's last pose as played (`capturedPose`): the clips, phases and weights, whether one frame was copied, the limbs lost. */
interface KeptPose {
  index: number;
  readonly palette: Float32Array;
  readonly transform: Matrix4;
  frame: number;
  readonly clips: ClipFrames[];
  readonly phases: number[];
  readonly weights: number[];
  single: boolean;
  lost: readonly Severable[] | null;
}

/** Bytes of a body's palettes: the CPU's override rows and the GPU's target, a row a body, and the clips' atlas. */
function paletteBytes(batch: CitizenBatch): number {
  return batch.rows * batch.width * 4 * 2 + (batch.atlas.anim.atlas.image.data as Float32Array).byteLength;
}

/** The company a walker is dressed with (`citizenCasting.codesFor`): their party's kind, or alone. */
function companyOf(party: Pick<PartyView, 'size' | 'archetype'>): Company {
  return party.size > 1 ? party.archetype : 'solo';
}

/** The error each level of a body is simplified to, as a share of the body's size */
export const CITIZEN_LEVEL_ERROR = [0, 0.008, 0.03, 0.12] as const;
/** The tallest a body is drawn (a tall adult, scaled up), world units: the size its error is measured against. */
const BODY_EXTENT = m(1.9);

/** The coarsest level of a body whose simplification error stays under one pixel at `zoom` */
export function citizenLevelAt(zoom: number): number {
  for (let level = CITIZEN_LEVEL_ERROR.length - 1; level > 0; level--) {
    if (CITIZEN_LEVEL_ERROR[level]! * BODY_EXTENT * zoom <= 1) return level;
  }
  return 0;
}

/** What a body does at `zoom`, apart from its mesh: 0 its face */
export function citizenBandAt(zoom: number): number {
  return zoom >= perM(20) ? 0 : zoom >= perM(5) ? 1 : zoom >= perM(3) ? 2 : 3;
}

/** The level a body is drawn at: level 0 wherever its face is shown */
export function citizenLevelFor(zoom: number): number {
  return citizenBandAt(zoom) === 0 ? 0 : citizenLevelAt(zoom);
}

/** The level of one figure whose 1.9 m (`BODY_EXTENT`) stands `pixels` canvas pixels tall on the screen, `ratio` of them a CSS pixel. */
export function citizenLevelOfFigure(pixels: number, ratio: number): number {
  return citizenLevelFor(pixels / (BODY_EXTENT * ratio));
}

/** Who a figure drawn by `drawClip` is and with whom: the casting context without the place. */
export interface ClipIdentity {
  readonly seed: number;
  readonly gender: 'f' | 'm';
  readonly ageClass: 'child' | 'adult' | 'elder';
  readonly company: Company;
  readonly companyId: number;
  readonly hasChild?: boolean;
}

/** A figure's palette row is its own (`citizenRow`): the figures of a body are drawn by level, each level a mesh of its own. */
const SKINNING = `
uniform sampler2D citizenBones;
uniform mat4 bindMatrix;
uniform mat4 bindMatrixInverse;
uniform float citizenBase;
attribute float citizenRow;
mat4 getBoneMatrix(const in float i) {
  int x = int(i)*4;
  int y = int(citizenRow) + int(citizenBase);
  return mat4(texelFetch(citizenBones,ivec2(x,y),0),
    texelFetch(citizenBones,ivec2(x+1,y),0),
    texelFetch(citizenBones,ivec2(x+2,y),0),
    texelFetch(citizenBones,ivec2(x+3,y),0));
}`;

const CHILD_SHIRTS = [0x000000, 0x479f94, 0xe5b25d, 0x9672b7] as const;

/** Whether somebody seated in a vehicle is talking now */
function seatedChat(seed: number, time: number): boolean {
  const hash = personHash(seed ^ 0x2f6b1d93);
  if ((hash & 3) === 0) return false; // a quiet traveller
  const cycle = 14 + (hash >>> 4 & 7) * 2;
  return ((time + (hash >>> 8 & 255) / 10) % cycle) < cycle * 0.3;
}

/** A body's colour over its own: none, or burnt black by a bomb. */
const UNBURNT = new Color(1, 1, 1);
const BURNT = new Color(0.075, 0.062, 0.055);

/** No expression: what a body drawn from a ragdoll palette shows (`drawPalette`). */
const NEUTRAL_FACE: FaceWeights = {};

/** Part `source`'s face at instance `slot` of its nearest level's mesh. */
function setFacialExpression(mesh: InstancedMesh, source: SkinnedMesh, slot: number, face: FaceWeights): void {
  const influences = source.morphTargetInfluences;
  const targets = source.morphTargetDictionary;
  if (!influences || !targets || !mesh.geometry.morphAttributes.position) return;
  applyFace(influences, targets, face);
  // three allocates an InstancedMesh's morph texture from `count`.
  const visible = mesh.count;
  if (mesh.morphTexture === null) mesh.count = CAPACITY;
  mesh.setMorphAt(slot, source);
  mesh.count = visible;
}

/** An empty array, for the face shapes three has copied into its own texture. */
const NO_SHAPE = new Float32Array(0);

/** DO NOT keep a body's face shapes dense in the page once drawn (~3 MB a body): three copied them into its morph texture at the first draw (WebGLMorphtargets, kept by geometry, read again only if the number of shapes changes) and keeps that copy for a restored context. */
export function dropFaceShapesOnceDrawn(mesh: InstancedMesh): void {
  const shapes = mesh.geometry.morphAttributes.position;
  if (!shapes?.length) return;
  const drop = mesh.onAfterRender;
  mesh.onAfterRender = function onceDrawn(this: InstancedMesh, ...args: Parameters<typeof drop>) {
    for (const shape of shapes) (shape as { array: ArrayLike<number> }).array = NO_SHAPE;
    mesh.onAfterRender = drop;
    drop.apply(this, args);
  };
}

/** Room for at least `needed` instances in a level's mesh (doubled), its written ones kept; its face's texture kept across. */
function growLevel(level: LevelMesh, needed: number): void {
  const mesh = level.mesh;
  let capacity = Math.max(1, mesh.instanceMatrix.count);
  while (capacity < needed) capacity *= 2;
  capacity = Math.min(CAPACITY, capacity);
  const matrices = new InstancedBufferAttribute(new Float32Array(capacity * 16), 16);
  matrices.array.set(mesh.instanceMatrix.array);
  matrices.setUsage(DynamicDrawUsage);
  const colours = new InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
  if (mesh.instanceColor) colours.array.set(mesh.instanceColor.array);
  colours.setUsage(DynamicDrawUsage);
  // DO NOT `dispose` the mesh to let its old buffers go: three's releaseStatesOfObject walks every geometry the renderer knows (WebGLBindingStates), ms a call; the old buffers stay on the GPU till the context goes (less than the new one's size).
  mesh.instanceMatrix = matrices;
  mesh.instanceColor = colours;
  level.colourChanged = true;
}

function markChildShirt(mesh: SkinnedMesh): void {
  const geometry = mesh.geometry;
  if (geometry.getAttribute('clothingMask')) return;
  const uv = geometry.getAttribute('uv');
  const skin = geometry.getAttribute('skinIndex');
  const weights = geometry.getAttribute('skinWeight');
  const count = geometry.getAttribute('position').count;
  const mask = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    if (!uv || uv.getX(i) < 0.32 || uv.getX(i) > 0.68) continue;
    let torso = 0;
    for (let k = 0; k < 4; k++) {
      const bone = mesh.skeleton.bones[skin.getComponent(i, k)];
      if (bone && /^Bip01_(Pelvis|Spine|Spine1|Spine2)$/.test(bone.name)) torso += weights.getComponent(i, k);
    }
    mask[i] = torso > 0.5 ? 1 : 0;
  }
  geometry.setAttribute('clothingMask', new BufferAttribute(mask, 1));
}

/** `base`: the body's first row in the palettes' shared target (`paletteTargets.ts`). */
export function skinMaterial(material: MeshStandardMaterial | MeshDepthMaterial, uniform: { value: Texture },
  mesh: SkinnedMesh, look = 0, base: { value: number } = { value: 0 }): void {
  material.defines = { ...material.defines, USE_SKINNING: '' };
  material.onBeforeCompile = shader => {
    shader.uniforms.citizenBones = uniform;
    shader.uniforms.citizenBase = base;
    shader.uniforms.bindMatrix = { value: mesh.bindMatrix };
    shader.uniforms.bindMatrixInverse = { value: mesh.bindMatrixInverse };
    shader.vertexShader = shader.vertexShader.replace('#include <skinning_pars_vertex>', SKINNING);
    if (look > 0 && material instanceof MeshStandardMaterial) {
      const tint = new Color(CHILD_SHIRTS[look]!);
      shader.vertexShader = `attribute float clothingMask; varying float vClothingMask;\n${shader.vertexShader}`
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n vClothingMask = clothingMask;');
      shader.fragmentShader = `varying float vClothingMask;\n${shader.fragmentShader}`;
      // The centre island of the Rocketbox child body atlas is the shirt.
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
        #include <map_fragment>
        #ifdef USE_MAP
        float shirtHigh = max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b));
        float shirtLow = min(diffuseColor.r, min(diffuseColor.g, diffuseColor.b));
        if (vClothingMask > 0.5 && shirtHigh - shirtLow > 0.09) {
          float shade = clamp(shirtHigh / 0.68, 0.35, 1.2);
          diffuseColor.rgb = vec3(${tint.r.toFixed(6)}, ${tint.g.toFixed(6)}, ${tint.b.toFixed(6)}) * shade;
        }
        #endif
      `);
    }
  };
  material.customProgramCacheKey = () => `citizen-skinning-v4-look${look}`;
}

export function createRiggedCitizens(models: readonly string[] = CROWD_IDS,
  onAssetsReady: () => void = () => {}) {
  const group = new Group();
  group.name = 'rigged-citizens';
  let casting = false;
  const batches = new Map<number, CitizenBatch>();
  const loading = new Map<number, Promise<void>>();
  const queuedLoads = new Map<number, { priority: boolean; wantedAt: number; resolve: () => void; reject: (error: unknown) => void }>();
  // An active load remains useful only while a body requests it in drawn frames.
  const wantedFrame = new Map<number, number>();
  /** When each body's load last failed: asked again only `RETRY_MS` later (a network or a cook hiccup passes). */
  const failed = new Map<number, number>();
  const RETRY_MS = 5000;
  let visualFrame = 0;
  let activeLoads = 0;
  const resources = new Set<{ dispose(): void }>();
  // The eyes, cards and garments of every body's materials, in two arrays of layers (`PersonLayers`).
  const personLayers = createPersonLayers();
  resources.add(personLayers);
  const disposeOwned = (owned: Set<{ dispose(): void }>): void => {
    cancelUploads([...owned].filter((resource): resource is Texture => resource instanceof Texture));
    for (const resource of owned) resource.dispose();
    owned.clear();
  };
  const motion = new WeakMap<PedView, Gait>();
  /** The pose each walker was last drawn in, by person id: what a ragdoll starts from when that person is struck */
  /** A limb lost: its lower half's bones */
  const maimBones = new WeakMap<CitizenBatch, Record<string, { bones: number[]; parent: number; joint: Vector3 } | null>>();
  const maimTmp = new Matrix4(), maimP = new Vector3();
  const maim = (batch: CitizenBatch, px: Float32Array, offset: number, limb: Severable): void => {
    let info = maimBones.get(batch);
    if (!info) {
      const source = batch.sources[0];
      info = {};
      if (source) {
        const bones = source.skeleton.bones;
        const parents = bones.map((b) => bones.indexOf(b.parent as never));
        for (const [key, name] of [['armL', 'Bip01_L_Forearm'], ['armR', 'Bip01_R_Forearm'], ['legL', 'Bip01_L_Calf'], ['legR', 'Bip01_R_Calf'], ['head', 'Bip01_Head']] as const) {
          const root = bones.findIndex((b) => b.name === name);
          if (root < 0) { info[key] = null; continue; }
          const set = [root];
          for (let i = 0; i < bones.length; i++) {
            let j = parents[i]!;
            while (j >= 0 && j !== root) j = parents[j]!;
            if (j === root) set.push(i);
          }
          const joint = new Vector3().setFromMatrixPosition(maimTmp.copy(source.skeleton.boneInverses[root]!).invert());
          info[key] = { bones: set, parent: parents[root]!, joint };
        }
      }
      maimBones.set(batch, info);
    }
    const which = info[limb];
    if (!which || which.parent < 0) return;
    maimTmp.fromArray(px, offset + which.parent * SKIN_BONE_FLOATS);
    maimP.copy(which.joint).applyMatrix4(maimTmp);
    for (const i of which.bones) {
      const o = offset + i * SKIN_BONE_FLOATS;
      px.fill(0, o, o + 16);
      px[o + 12] = maimP.x; px[o + 13] = maimP.y; px[o + 14] = maimP.z; px[o + 15] = 1;
    }
  };
  /** Somebody drawn bleeding (a limb lost): the caller drips blood where they walk. */
  let onBleed: ((id: number, x: number, y: number, z: number) => void) | null = null;
  /** What each walker played when last drawn, the palette blended from it only when a ragdoll asks (`capturedPose`). */
  const lastPose = new Map<number, KeptPose>();
  const plays: GaitPlay[] = [];
  const transform = new Object3D();
  // What people hold while they stop to do something (`heldProps.ts`).
  const held = createHeldProps();
  group.add(held.group);
  resources.add(held);
  const boxR = new Vector3(), boxL = new Vector3(), boxAt = new Vector3(), boxSize = new Vector3(), boxTurn = new Quaternion();
  const handMatrix = new Matrix4();
  const matrix = new Matrix4();
  const helmetBone = new Matrix4();
  let disposed = false;
  let detail = 2;
  let lod = 0;
  /** What bodies do at this zoom besides their mesh (`citizenBandAt`). */
  let band = 0;
  let frameNow = performance.now();
  // Keep a recently seen body ready for a return pan
  const IDLE_MS = 60_000;
  const evictInactive = (): void => {
    const now = performance.now();
    for (const [index, batch] of batches) {
      if (batch.count > 0 || now - batch.lastUsed < IDLE_MS) continue;
      batch.disposed = true;
      for (const mesh of batch.meshes) group.remove(mesh);
      group.userData.paletteBytes -= paletteBytes(batch);
      disposeOwned(batch.resources);
      group.userData.animationBytes -= batch.animationBytes;
      batches.delete(index);
      loading.delete(index);
      wantedFrame.delete(index);
    }
    group.userData.loadedModels = batches.size;
    if (batches.size === 0 && loading.size === 0) releaseIdleBakeWorkers();
  };
  const evictionTimer = typeof window === 'undefined' ? 0 : window.setInterval(evictInactive, 15_000);
  /** A batch's materials on what bodies do at the current zoom (`citizenBandAt`): the skin's detail. */
  const applyBand = (batch: CitizenBatch): void => {
    for (const mesh of batch.meshes) {
      const material = mesh.material;
      for (const m of Array.isArray(material) ? material : [material]) {
        const appearance = m.userData['appearanceDetail'] as { value: number } | undefined;
        if (appearance) appearance.value = band <= 1 ? 1 : 0;
      }
    }
  };
  /** This frame's measure of a figure on the screen (`AgentRenderOptions.personPixels`, canvas pixels), and canvas pixels a CSS pixel. */
  let figurePixels: ((x: number, y: number, z: number, height: number) => number) | null = null;
  let figureRatio = 1;
  /** The level a figure standing at (x, y, z) is drawn at: by its own size on the screen; the view's zoom where none is given. */
  const levelOf = (x: number, y: number, z: number): number =>
    figurePixels ? citizenLevelOfFigure(figurePixels(x, y, z, BODY_EXTENT), figureRatio) : lod;
  group.userData.availableModels = models.length;
  group.userData.models = models;
  group.userData.licenses = CITIZEN_LICENSES;

  /** A roster person (`people/roster.ts`) as a loaded asset would be */
  async function personAsset(model: CitizenModel, fresh = false,
    owned: Set<{ dispose(): void }> = resources): Promise<GLTF> {
    const person = model.person!;
    /** The person's scene with its skin's appearance (its textures, loaded here). */
    const dressed = async (scene: Object3D): Promise<GLTF | null> => {
      let mesh: SkinnedMesh | undefined;
      scene.traverse((o) => { if (o instanceof SkinnedMesh && !mesh) mesh = o; });
      if (!mesh) return null;
      const skin = await loadSkinAppearance(person);
      owned.add({ dispose: () => releaseSkinAppearance(skin) });
      mesh.geometry.userData['skinAppearance'] = skin;
      return { scene, parser: null } as unknown as GLTF;
    };
    // Cooked ahead (`cookedPerson.ts`, `npm run cook:people`): read back, not built - the realistic bodies
    const style = peopleStyle();
    const cooked = fresh || style !== REALISTIC ? null : await loadCookedPerson(model.id);
    const asCooked = cooked ? await dressed(cooked) : null;
    if (asCooked) return asCooked;
    const faces = new URLSearchParams(location.search).get('expressions') !== 'off';
    // DO NOT build a person on the page (R22): built in a worker and read back as a cooked one; here only where no worker can, or for the cook.
    const decoded = fresh ? null : await buildPersonInWorker(person, model.gender, style, faces);
    const fromWorker = decoded ? await dressed(assemblePerson(decoded)) : null;
    if (fromWorker) return fromWorker;
    // A body is built in one go, just after a frame is drawn.
    const scene = await buildPersonScene(person, model.gender, style, faces, afterFrame);
    return (await dressed(scene))!;
  }

  async function load(index: number): Promise<void> {
    const owned = new Set<{ dispose(): void }>();
    const added: InstancedMesh[] = [];
    let paletteAdded = 0;
    let committed: CitizenBatch | null = null;
    const releasePending = (): void => {
      for (const mesh of added) group.remove(mesh);
      disposeOwned(owned);
      if (paletteAdded > 0) group.userData.paletteBytes -= paletteAdded;
      paletteAdded = 0;
    };
    const abandonIfUnwanted = (): boolean => {
      // One missed frame can be a camera edge; two mean the visual demand left.
      if (!disposed && visualFrame - (wantedFrame.get(index) ?? -Infinity) < 2) return false;
      releasePending();
      loading.delete(index);
      wantedFrame.delete(index);
      return true;
    };
    try {
    const model = CROWD[index];
    const sex = model ? (model.gender === 'f' ? 'female' : 'male') : models[index]!.includes('female') ? 'female' : 'male';
    const asset = await (model?.person ? personAsset(model, false, owned) : (async () => {
      const url = CITIZEN_ASSET_URLS[model?.sourceId ?? models[index]!];
      if (!url) throw new Error(`Missing citizen asset: ${models[index]}`);
      return new GLTFLoader().loadAsync(url);
    })());
    // DO NOT decode the motion library here (~5 MB of JSON a sex) while a worker bakes every clip: only for what is baked here.
    const library = (): ReturnType<typeof loadRocketboxClips> => loadRocketboxClips(sex);
      asset.scene.traverse(o => {
        if (!(o instanceof SkinnedMesh)) return;
        owned.add(o.geometry);
        owned.add(o.skeleton);
        const materials = Array.isArray(o.material) ? o.material : [o.material];
        for (const material of materials) {
          owned.add(material);
          for (const value of Object.values(material)) if (value instanceof Texture) owned.add(value);
        }
      });
    if (abandonIfUnwanted()) return;
      const bakeAt = performance.now();
      // The core clips on another core (`bakePool.ts`); here only if no worker can.
      const given = await bakeInWorker(asset.scene, sex);
      if (abandonIfUnwanted()) return;
      const { clips, helmet, deferred } = await bake(asset.scene, sex, library, given ?? undefined);
      measureHitch('person-bake', bakeAt);
      if (abandonIfUnwanted()) return;
      let reference: SkinnedMesh | undefined;
      asset.scene.updateMatrixWorld(true);
      asset.scene.traverse(o => { if (o instanceof SkinnedMesh && !reference) reference = o; });
      if (!reference) throw new Error('Citizen model has no mesh');
      const bones = reference.skeleton.bones.length;
      const width = bones * SKIN_BONE_FLOATS;
      const rows = 16;
      // The pass blends each body's plays on the GPU (GPU Gems 3, ch. 2); on their own joints: no parent to refit through.
      const atlas = citizenAtlas(clips, bones);
      const joints = new DataTexture(new Float32Array(bones * 4), bones, 1, RGBAFormat, FloatType);
      joints.needsUpdate = true;
      const parents = new Int16Array(bones).fill(-1);
      const pass = createPalettePass(atlas.anim, parents, () => joints, rows);
      const uniform: { value: Texture } = { value: pass.texture };
      const base = { value: pass.base };
      const batch: CitizenBatch = { meshes: [], parts: [], sources: [], local: [], clips, gait: gaitClips(clips), width, rows,
        atlas, pass, uniform, base, scratch: new Float32Array(width), joints, parents, sex, scene: asset.scene, rigNodes: null,
        count: 0, helmet, resources: owned, animationBytes: 0,
        lastUsed: performance.now(), disposed: false,
        deferred, baking: Promise.resolve() };
      owned.add({ dispose: () => { batch.pass.dispose(); batch.atlas.anim.atlas.dispose(); batch.joints.dispose(); } });
      paletteAdded = paletteBytes(batch);
      group.userData.paletteBytes = (group.userData.paletteBytes ?? 0) + paletteAdded;
      const parts: SkinnedMesh[] = [];
      asset.scene.traverse(o => { if (o instanceof SkinnedMesh) parts.push(o); });
      for (const o of parts) {
        if (CROWD[index]?.look) markChildShirt(o);
        const variants = [o.geometry];
        // A built person carries its levels ready-made (`personRig.ts`).
        await (o.geometry.userData['lodReady'] as Promise<void> | undefined);
        const ready: unknown = o.geometry.userData['lodIndices'];
        const readyGroups = o.geometry.userData['lodGroups'] as { start: number; count: number; materialIndex: number }[][] | undefined;
        if (Array.isArray(ready)) for (const [level, indices] of (ready as BufferAttribute[]).entries()) {
          const geometry = new BufferGeometry();
          for (const name of Object.keys(o.geometry.attributes)) geometry.setAttribute(name, o.geometry.getAttribute(name));
          geometry.setIndex(indices);
          // A dressed body's garments are material groups: each level has its own ranges.
          for (const g of readyGroups?.[level] ?? []) geometry.addGroup(g.start, g.count, g.materialIndex);
          // No face on the coarser levels: a face is drawn only at the nearest
          geometry.boundingBox = o.geometry.boundingBox;
          geometry.boundingSphere = o.geometry.boundingSphere;
          variants.push(geometry);
          owned.add(geometry);
        }
        const lodIndices: unknown = o.geometry.userData['roadcraftLods'];
        if (Array.isArray(lodIndices)) for (const accessor of lodIndices) {
          const indices = await asset.parser.getDependency('accessor', accessor) as BufferAttribute;
          const geometry = new BufferGeometry();
          for (const name of Object.keys(o.geometry.attributes)) geometry.setAttribute(name, o.geometry.getAttribute(name));
          geometry.setIndex(indices);
          geometry.boundingBox = o.geometry.boundingBox;
          geometry.boundingSphere = o.geometry.boundingSphere;
          variants.push(geometry);
          owned.add(geometry);
        }
        if (abandonIfUnwanted()) return;
        const original = Array.isArray(o.material) ? o.material : [o.material];
        const materials = original.map((source, materialIndex) => {
          const material = (source as MeshStandardMaterial).clone();
          material.color.setHex(0xffffff); // Preserve authored skin; never tint the whole citizen.
          // A roster person's colours are its vertices' (`personRig.ts`).
          material.roughness = 0.88;
          material.metalness = 0;
          skinMaterial(material, uniform, o, materialIndex === 0 ? (CROWD[index]?.look ?? 0) : 0, base);
          const skin = o.geometry.userData['skinAppearance'] as SkinAppearance | undefined;
          if (skin) applySkinAppearance(material, o.geometry, skin, personLayers);
          owned.add(material);
          return material;
        });
        const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
        const source = original[0] as MeshStandardMaterial;
        depth.map = source.map;
        depth.alphaTest = source.alphaTest;
        skinMaterial(depth, uniform, o, 0, base);
        owned.add(depth);
        // A mesh per distinct level: each figure is drawn at the level its own size on the screen allows (`levelOf`).
        const distinct = [...new Set(variants)];
        const part: CitizenPart = { levels: [], at: CITIZEN_LEVEL_ERROR.map((_, k) => distinct.indexOf(variants[Math.min(k, variants.length - 1)]!)) };
        for (const geometry of distinct) {
          const mesh = new InstancedMesh(geometry, Array.isArray(o.material) ? materials : materials[0]!, LEVEL_START);
          // InstancedMesh does not initialise this array itself; only the nearest level has the face.
          if (o.morphTargetInfluences && geometry.morphAttributes.position) mesh.morphTargetInfluences = [...o.morphTargetInfluences];
          // A colour per body from the start (white): a body burnt black by a bomb is the same program, its colour near black
          mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(LEVEL_START * 3).fill(1), 3);
          mesh.instanceColor.setUsage(DynamicDrawUsage);
          const rows = new InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
          rows.setUsage(DynamicDrawUsage);
          geometry.setAttribute('citizenRow', rows);
          mesh.name = `citizen-${models[index]}-${o.name}@${part.levels.length}`;
          mesh.count = 0;
          // Hidden until it has somebody to draw (`finish` shows it then).
          mesh.visible = false;
          mesh.frustumCulled = false;
          mesh.instanceMatrix.setUsage(DynamicDrawUsage);
          mesh.castShadow = true;
          // Small animated figures do not receive shadow maps
          mesh.receiveShadow = false;
          mesh.customDepthMaterial = depth;
          owned.add(mesh);
          dropFaceShapesOnceDrawn(mesh);
          part.levels.push({ mesh, rows, count: 0, colourChanged: true });
          batch.meshes.push(mesh);
          group.add(mesh);
          added.push(mesh);
        }
        batch.parts.push(part);
        batch.sources.push(o);
        batch.local.push(o.matrixWorld.clone());
      }
      // Its shaders built before it is drawn (`uploads.ts`) - the programs it is really drawn with: a body far off has no face
      const warm = new Group();
      const shadows = new Group();
      const temporary: InstancedMesh[] = [];
      batch.parts.forEach((part, i) => {
        const mesh = part.levels[0]!.mesh;
        const source = batch.sources[i]!;
        const forms = [part.levels[Math.min(1, part.levels.length - 1)]!.mesh.geometry, mesh.geometry];
        for (const geometry of new Set(forms)) {
          const face = !!geometry.morphAttributes.position;
          const stand = new InstancedMesh(geometry, mesh.material, 1);
          stand.frustumCulled = false;
          // Every body is drawn with a colour per instance (burnt or not): `instancingColor` is part of three's program key
          stand.instanceColor = new InstancedBufferAttribute(new Float32Array(3).fill(1), 3);
          stand.receiveShadow = mesh.receiveShadow;
          if (face && source.morphTargetInfluences) {
            stand.morphTargetInfluences = [...source.morphTargetInfluences];
            stand.setMorphAt(0, source);
          }
          temporary.push(stand);
          warm.add(stand);
          // DO NOT compile the depth material as it was made: the shadow pass sets its side and cut from each garment's material
          stand.castShadow = mesh.castShadow;
          if (mesh.customDepthMaterial) stand.customDepthMaterial = mesh.customDepthMaterial;
          const cast = shadowStandIn(stand);
          if (cast) shadows.add(cast);
        }
      });
      // The palette pass's program too (`uploads.ts` compilePassAhead): its first draw built it in the frame.
      await Promise.all([compileAhead(warm), compileAhead(shadows, true), pass.ready]);
      for (const stand of temporary) stand.morphTexture?.dispose();
      warm.clear();
      shadows.clear();
      if (abandonIfUnwanted()) return;
      // And its geometry on the GPU, every level of it (`uploads.ts`).
      await Promise.all(batch.parts.flatMap((part) => part.levels.slice(1).map((level) => warmAhead(level.mesh, [level.mesh.geometry]))));
      if (abandonIfUnwanted()) return;
      // The skin's detail of the zoom NOW.
      applyBand(batch);
      batches.set(index, batch);
      wantedFrame.delete(index);
      committed = batch;
      paletteAdded = 0;
      batch.animationBytes = [...new Set(clips)].reduce((sum, clip) => sum + clip.data.byteLength, 0);
      group.userData.animationBytes = (group.userData.animationBytes ?? 0) + batch.animationBytes;
      group.userData.clipFrames ??= clips.map((clip) => clip?.frames ?? 0);
    group.userData.ready = true;
    group.userData.loadedModels = batches.size;
    } catch (error) {
      if (committed) {
        batches.delete(index);
        group.userData.paletteBytes -= paletteBytes(committed);
        group.userData.animationBytes -= committed.animationBytes;
        group.userData.loadedModels = batches.size;
      }
      releasePending();
      throw error;
    }
    onAssetsReady();
  }

  function pump(): void {
    while (activeLoads < 6 && queuedLoads.size > 0) {
      let priority: [number, { priority: boolean; wantedAt: number; resolve: () => void; reject: (error: unknown) => void }] | undefined;
      for (const pair of queuedLoads) if (pair[1].priority) { priority = pair; break; }
      if (!priority && activeLoads >= 5) break; // Keep one slot for a newly visible rider or occupant.
      const [index, entry] = priority ?? queuedLoads.entries().next().value!;
      queuedLoads.delete(index);
      if (performance.now() - entry.wantedAt > 1000) {
        loading.delete(index);
        wantedFrame.delete(index);
        entry.resolve();
        continue;
      }
      activeLoads++;
      void load(index).then(entry.resolve, entry.reject).finally(() => {
        activeLoads--;
        pump();
      });
    }
  }

  function request(index: number, priority = false): Promise<void> {
    // A body outside the reviewed whitelist must never be asked for; the browser checks (`verify:visual`) fail on this error.
    if (!CROWD_IDS.includes(models[index] ?? '')) console.error(`Citizen outside the whitelist requested: ${models[index]}`);
    wantedFrame.set(index, visualFrame);
    const existing = loading.get(index);
    if (existing) {
      const queued = queuedLoads.get(index);
      if (queued) { queued.priority ||= priority; queued.wantedAt = performance.now(); }
      return existing;
    }
    const failedAt = failed.get(index);
    // Failed a moment ago (said then): not drawn, not asked again yet.
    if (failedAt !== undefined && performance.now() - failedAt < RETRY_MS) return Promise.resolve();
    const work = new Promise<void>((resolve, reject) => {
      queuedLoads.set(index, { priority, wantedAt: performance.now(), resolve, reject });
    });
    loading.set(index, work);
    // A load that failed is let go, to be asked again later: DO NOT keep the rejected promise
    work.catch((error: unknown) => {
      console.error(`Citizen ${models[index]} failed to load; asked again in ${RETRY_MS} ms`, error);
      if (loading.get(index) === work) loading.delete(index);
      failed.set(index, performance.now());
    });
    pump();
    return work;
  }

  /** Who is drawn as whom (`citizenCasting.ts`) */
  if (import.meta.env.DEV) {
    // The cook (`scripts/cook-people.mjs`)
    (window as unknown as { __cookPeople?: () => Promise<{ hash: string | null; ids: string[]; bytes: number }> }).__cookPeople = async () => {
      const ids: string[] = [];
      let bytes = 0;
      for (const model of CROWD) {
        if (!model.person) continue;
        const asset = await personAsset(model, true);
        const waits: Promise<unknown>[] = [];
        asset.scene.traverse((o) => { if (o instanceof SkinnedMesh) waits.push(o.geometry.userData['lodReady'] as Promise<unknown>); });
        await Promise.all(waits);
        const packed = cookPerson(asset.scene);
        const response = await fetch(`/__cook/people/${model.id}.bin`, { method: 'PUT', body: packed });
        if (!response.ok) throw new Error(`Cook of ${model.id}: ${response.status}`);
        ids.push(model.id);
        bytes += packed.byteLength;
      }
      return { hash: peopleCookHash(), ids, bytes };
    };
  }

  // A person keeps their body for good (`CastingRegistry`): DO NOT give the registry a limit on how many it remembers
  const registry = new CastingRegistry(CROWD.filter((m) => models.includes(m.id))
    .sort((p, q) => models.indexOf(p.id) - models.indexOf(q.id)));
  const helmetFits = (id: string): boolean => !NO_HELMET.has(id);
  function bodyFor(ctx: CastingContext): { index: number; size: number } | null {
    return registry.pickCitizenModel(ctx, helmetFits);
  }
  /** DO NOT make a casting context for every figure drawn: one, filled again (the registry copies what it keeps). */
  const scratch: { -readonly [K in keyof CastingContext]-?: CastingContext[K] | undefined } = {
    seed: 0, gender: 'f', ageClass: 'adult', company: 'solo', companyId: 0, hasChild: undefined, helmet: undefined, x: 0, y: 0,
  };
  /** The context of a figure of `identity` at (x, y), in `scratch`. */
  function contextOf(identity: ClipIdentity, helmet: boolean, x: number, y: number): CastingContext {
    scratch.seed = identity.seed; scratch.gender = identity.gender; scratch.ageClass = identity.ageClass;
    scratch.company = identity.company; scratch.companyId = identity.companyId; scratch.hasChild = identity.hasChild;
    scratch.helmet = helmet; scratch.x = x; scratch.y = y;
    return scratch as CastingContext;
  }
  const mixClips: ClipFrames[] = [];
  const mixPhases: number[] = [];
  const mixWeights: number[] = [];

  /** The clips asked for and still baking, per body (their stand-ins drawn meanwhile). */
  const baking = new WeakMap<CitizenBatch, Set<number>>();
  /** A deferred clip asked for: baked in turn, the stand-in drawn meanwhile. */
  function want(batch: CitizenBatch, at: number): void {
    const job = batch.deferred.get(at);
    if (!job) return;
    batch.deferred.delete(at);
    let waiting = baking.get(batch);
    if (!waiting) baking.set(batch, waiting = new Set());
    waiting.add(at);
    batch.baking = batch.baking.then(async () => {
      // In a worker on the body's rig, timed by its shuffle; here (in slices) only where no worker can.
      batch.rigNodes ??= bakeRig(batch.scene);
      const clip = await bakeDeferredInWorker(batch.rigNodes, batch.sex, at, batch.clips[WALK_SHUFFLE]!) ?? await job.make();
      waiting.delete(at);
      if (disposed || batch.disposed) return;
      batch.clips[at] = clip;
      batch.gait = gaitClips(batch.clips);
      addToAtlas(batch, clip);
      batch.animationBytes += clip.data.byteLength;
      group.userData.animationBytes = (group.userData.animationBytes ?? 0) + clip.data.byteLength;
    }).catch(() => {});
  }

  /** The plays handed to the palette pass for one body (`gpuPlays`), the same objects every time. */
  const passPlays: Play[] = Array.from({ length: GPU_PLAYS }, () => ({ row: 0, t: 0, weight: 0 }));
  /** DO NOT hand the pass a longer list than a body plays (it reads each entry given): the first n of them, made once. */
  const passLists: readonly Play[][] = Array.from({ length: GPU_PLAYS + 1 }, (_, n) => passPlays.slice(0, n));

  /** Body `row`'s palette for the pass: its plays blended on the GPU, or blended (and maimed) here when the pass cannot. */
  function pose(batch: CitizenBatch, row: number, clips: readonly ClipFrames[], phases: readonly number[],
    weights: readonly number[], lost: readonly Severable[] | null): void {
    const single = band >= 2;
    const n = lost ? -1 : gpuPlays(passPlays, batch.atlas, clips, phases, weights, single);
    if (n >= 0) {
      batch.pass.setPlays(row, passLists[n]!, 0);
      return;
    }
    cpuPose(batch.scratch, 0, clips, phases, weights, batch.width, single);
    for (const limb of lost ?? []) maim(batch, batch.scratch, 0, limb);
    batch.pass.setOverride(row, batch.scratch);
    batch.pass.setPlays(row, null, 0);
  }

  /** Writes one figure at `level` into each part's mesh of that level: `instance`, its colour, its palette row and, at the nearest level, its face. */
  function place(batch: CitizenBatch, level: number, instance: Matrix4, colour: Color, face: FaceWeights | undefined): void {
    for (let i = 0; i < batch.parts.length; i++) {
      const part = batch.parts[i]!;
      const at = part.levels[part.at[Math.min(level, part.at.length - 1)]!]!;
      if (at.count >= at.mesh.instanceMatrix.count) growLevel(at, at.count + 1);
      const slot = at.count++;
      matrix.multiplyMatrices(instance, batch.local[i]!);
      at.mesh.setMatrixAt(slot, matrix);
      const c = at.mesh.instanceColor!.array as Float32Array, o = slot * 3;
      if (c[o] !== colour.r || c[o + 1] !== colour.g || c[o + 2] !== colour.b) {
        c[o] = colour.r; c[o + 1] = colour.g; c[o + 2] = colour.b;
        at.colourChanged = true;
      }
      (at.rows.array as Float32Array)[slot] = batch.count;
      if (face) setFacialExpression(at.mesh, batch.sources[i]!, slot, face);
    }
  }

  /** Writes one citizen: its bone palette (`pose`) plus instance transform, at `level` (`levelOf`). */
  function emit(batch: CitizenBatch, clips: readonly ClipFrames[], phases: readonly number[],
    weights: readonly number[], x: number, height: number, y: number, heading: number, scale: number,
    lean = 0, ground: Gradient | null = null, expression?: FaceWeights, lost: readonly Severable[] | null = null, level = lod): void {
    pose(batch, batch.count, clips, phases, weights, lost);
    transform.position.set(x, height, -y);
    // Yaw, then a roll about the body's own forward axis
    transform.rotation.set(0, heading + Math.PI / 2, -lean, 'YXZ');
    transform.scale.set(scale, scale, scale);
    transform.updateMatrix();
    if (ground) shearMatrix(transform.matrix, ground, x, -y);
    // Faces are read only close up: from the nearest level of detail on, no expression is computed or uploaded.
    place(batch, level, transform.matrix, UNBURNT, level === 0 ? expression : undefined);
    batch.count++;
    batch.lastUsed = frameNow;
  }

  /** Room for twice the bodies in the pass (its rows written so far kept); the skinning reads its new target. */
  function grow(batch: CitizenBatch): void {
    const before = paletteBytes(batch);
    batch.rows = Math.min(CAPACITY, batch.rows * 2);
    batch.pass.grow(batch.rows);
    batch.uniform.value = batch.pass.texture;
    batch.base.value = batch.pass.base;
    group.userData.paletteBytes += paletteBytes(batch) - before;
  }

  /** DO NOT lay the atlas again nor make a pass for a clip baked since: its rows written into the atlas's room, the pass kept (a new texture only when the atlas grows). */
  function addToAtlas(batch: CitizenBatch, clip: ClipFrames): void {
    const before = paletteBytes(batch);
    const old = batch.atlas.anim.atlas;
    if (!appendClip(batch.atlas, clip)) return;
    batch.pass.setAtlas(batch.atlas.anim.atlas);
    old.dispose();
    group.userData.paletteBytes += paletteBytes(batch) - before;
  }

  return {
    group,
    /** `pixels`: a figure's height on the screen where it stands (canvas pixels, `ratio` of them a CSS pixel): each figure's level by it. */
    begin(level = 2, zoom = Infinity, pixels: ((x: number, y: number, z: number, height: number) => number) | null = null, ratio = 1) {
      figurePixels = pixels;
      figureRatio = ratio;
      frameNow = performance.now();
      visualFrame++;
      held.begin();
      detail = level;
      registry.beginFrame();
      // The mesh by its error on screen; what the body does by the zoom.
      const nextBand = citizenBandAt(zoom);
      const nextLod = citizenLevelFor(zoom);
      const levelChanged = nextLod !== lod || nextBand !== band;
      lod = nextLod;
      band = nextBand;
      group.userData.lod = lod;
      for (const batch of batches.values()) {
        batch.count = 0;
        for (const part of batch.parts) for (const at of part.levels) at.count = 0;
        if (levelChanged) applyBand(batch);
      }
    },
    /** Draws one pedestrian, the body playing what `citizenGait.ts` decides from how the simulation moves it */
    /** `ground`: the footway's gradient under the walker, so both feet stand on it (`groundShear.ts`). */
    draw(ped: PedView, x: number, y: number, heading: number, deck: number, alpha: number,
      ground: Gradient | null = null, lean = 0, priority = false) {
      const hash = personHash(ped.id);
      scratch.seed = ped.id; scratch.gender = ped.gender; scratch.ageClass = ped.ageClass; scratch.company = companyOf(ped.party);
      scratch.companyId = ped.party.id; scratch.hasChild = ped.party.hasChild; scratch.helmet = false; scratch.x = x; scratch.y = y;
      const body = bodyFor(scratch as CastingContext);
      if (!body) return;
      const index = body.index;
      const batch = batches.get(index);
      if (!batch) {
        const known = loading.has(index);
        const work = request(index, priority);
        if (!known) void work.catch((error: unknown) => {
          group.userData.error = String(error);
          console.error('Citizen asset could not be loaded', models[index], error);
        });
        return;
      }
      if (batch.count >= CAPACITY) return;
      if (batch.count >= batch.rows) grow(batch);
      const time = Math.max(0, ped.age - (1 - alpha) * DT);
      const scale = body.size * (0.92 + ((hash >>> 8) & 255) / 255 * 0.17);
      let gait = motion.get(ped);
      if (!gait) {
        gait = createGait(ped, time, heading, hash);
        motion.set(ped, gait);
      }
      stepGait(gait, ped, batch.gait, time, heading, m(scale) / m(1), hash);
      plays.length = 0;
      gaitPlays(gait, batch.gait, plays);
      mixClips.length = 0; mixPhases.length = 0; mixWeights.length = 0;
      const carrying = ped.carry !== undefined;
      for (const play of plays) {
        const at = (carrying ? CARRY_AT[play.name] : undefined) ?? GAIT_AT[play.name];
        if (batch.deferred.size) want(batch, at);
        mixClips.push(batch.clips[at]!);
        mixPhases.push(play.frame);
        mixWeights.push(play.weight);
      }
      // Every limb lost (shots take more than one), the stump closed at its joint.
      const lost = ped.lost ?? (ped.maimed ? [ped.maimed] : null);
      const level = levelOf(x, y, deck);
      emit(batch, mixClips, mixPhases, mixWeights, x, deck, y, gaitHeading(gait), m(scale), lean, ground,
        level === 0 ? faceAt(ped.id, time, ped.panic ? (ped.gesture?.kind === 'crouch' ? 'cry' : 'panic') : ped.gesture?.kind, CROWD[index]?.person?.mood) : undefined,
        lost, level);
      if (lost) onBleed?.(ped.id, x, y, deck);
      {
        // What they play, kept: the palette is blended from it only if a ragdoll takes them (`capturedPose`).
        let kept = lastPose.get(ped.id);
        if (!kept || kept.palette.length !== batch.width) {
          kept = { index, palette: new Float32Array(batch.width), transform: new Matrix4(), frame: 0, clips: [], phases: [], weights: [], single: false, lost: null };
          lastPose.set(ped.id, kept);
        }
        kept.index = index;
        kept.clips.length = 0; kept.phases.length = 0; kept.weights.length = 0;
        for (let i = 0; i < mixClips.length; i++) { kept.clips.push(mixClips[i]!); kept.phases.push(mixPhases[i]!); kept.weights.push(mixWeights[i]!); }
        kept.single = band >= 2;
        kept.lost = lost;
        kept.transform.copy(transform.matrix);
        kept.frame = visualFrame;
      }
      // In the hand, what the gesture is done with, where the hand is in the clip carrying the most weight this frame.
      if (carrying && band < 2) {
        // The box between the two hands, as wide as they are apart.
        let best = -1;
        for (let i = 0; i < mixWeights.length; i++) if (best < 0 || mixWeights[i]! > mixWeights[best]!) best = i;
        const clip = best >= 0 ? mixClips[best] : undefined;
        if (clip?.hands && mixWeights[best]! > 0) {
          const frame = Math.min(clip.frames, Math.max(0, Math.round(mixPhases[best]!)));
          boxR.fromArray(clip.hands, frame * 32 + 12);
          boxL.fromArray(clip.hands, frame * 32 + 28);
          const width = Math.min(0.5, Math.max(0.24, boxR.distanceTo(boxL) - 0.07));
          boxAt.addVectors(boxR, boxL).multiplyScalar(0.5);
          boxAt.z += 0.03; boxAt.y += 0.02;
          handMatrix.compose(boxAt, boxTurn, boxSize.set(width, 0.3, 0.38));
          handMatrix.premultiply(transform.matrix);
          held.placeMatrix('box', handMatrix);
        }
      }
      const thing = ped.gesture && !carrying ? HELD[ped.gesture.kind] : undefined;
      if (thing && band < 2) {
        let best = -1;
        for (let i = 0; i < mixWeights.length; i++) if (best < 0 || mixWeights[i]! > mixWeights[best]!) best = i;
        const clip = best >= 0 ? mixClips[best] : undefined;
        if (clip?.hands && mixWeights[best]! > 0.5) {
          const frame = Math.min(clip.frames, Math.max(0, Math.round(mixPhases[best]!)));
          handMatrix.fromArray(clip.hands, frame * 32 + (thing.left ? 16 : 0));
          handMatrix.premultiply(transform.matrix);
          held.place(thing.kind, handMatrix, m(scale));
        }
      }
    },
    /** Somebody in or on a vehicle, or stepping between a vehicle and the footway */
    drawClip(identity: ClipIdentity,
      pelvisX: number, pelvisY: number, pelvisHeight: number, heading: number,
      plays: readonly { readonly key: CitizenClipKey; readonly phase: number; readonly weight: number;
        /** For a walk: ground covered, world units; the phase then follows this body's own stride. */
        readonly distance?: number }[],
      lean = 0, maxScale = Infinity, fromGround: boolean | 'pelvisOver' = false, fixedScale = 0,
      helmet: Matrix4 | null = null, face?: 'dead'): number {
      const hash = personHash(identity.seed);
      const body = bodyFor(contextOf(identity, helmet !== null, pelvisX, pelvisY));
      if (!body) return 0;
      const batch = batches.get(body.index);
      if (!batch) {
        const known = loading.has(body.index);
        const work = request(body.index, true);
        if (!known) void work.catch(() => {});
        return 0;
      }
      if (batch.count >= CAPACITY) return 0;
      if (batch.count >= batch.rows) grow(batch);
      mixClips.length = 0;
      mixPhases.length = 0;
      mixWeights.length = 0;
      let pelvis = 0;
      let pelvisLeft = 0;
      let pelvisAhead = 0;
      let total = 0;
      const scale = m(fixedScale > 0 ? fixedScale : Math.min(maxScale, body.size * (0.92 + ((hash >>> 8) & 255) / 255 * 0.17)));
      let headWeight = 0;
      let headClip: ClipFrames | undefined;
      for (const play of plays) {
        const at = play.key === 'walk' ? (identity.ageClass === 'elder' ? WALK_ELDER : WALK)
          : play.key in RIDER_AT ? RIDER_AT[play.key as RiderClipKey] : LIBRARY_AT[play.key as Played];
        if (batch.deferred.size) want(batch, at);
        const clip = batch.clips[at];
        if (!clip || play.weight <= 0) continue;
        // A walk played by distance plants the feet: one cycle per stride of THIS body
        const phase = play.distance !== undefined ? play.distance / Math.max(1e-6, clip.stride * scale) : play.phase;
        const f = clip.loop ? ((phase % 1) + 1) % 1 : Math.min(1, Math.max(0, phase));
        mixClips.push(clip);
        mixPhases.push(f * clip.frames);
        mixWeights.push(play.weight);
        pelvis += clip.pelvisY * play.weight;
        pelvisLeft += clip.pelvisX * play.weight;
        pelvisAhead += clip.pelvisZ * play.weight;
        total += play.weight;
        if (play.weight > headWeight) {
          headWeight = play.weight;
          headClip = clip;
        }
      }
      if (!mixClips.length) return 0;
      pelvis /= total;
      // The model's origin, found back from the pelvis along the leaned up axis
      const drop = fromGround ? 0 : pelvis * scale;
      const leftX = -Math.sin(heading);
      const leftY = Math.cos(heading);
      const aheadX = Math.cos(heading);
      const aheadY = Math.sin(heading);
      const shiftLeft = fromGround === true ? 0 : (pelvisLeft / total) * scale;
      const shiftAhead = fromGround === true ? 0 : (pelvisAhead / total) * scale;
      const originX = pelvisX - leftX * drop * Math.sin(lean) - leftX * shiftLeft - aheadX * shiftAhead;
      const originY = pelvisY - leftY * drop * Math.sin(lean) - leftY * shiftLeft - aheadY * shiftAhead;
      const originHeight = pelvisHeight - drop * Math.cos(lean);
      const level = levelOf(originX, originY, originHeight);
      emit(batch, mixClips, mixPhases, mixWeights, originX, originHeight, originY, heading, scale, lean, null,
        // In a seat a face lives too: blinking, glancing, a passenger chatting now and then (wall time: the render's own clock).
        level === 0 ? faceAt(identity.seed, performance.now() / 1000 + identity.seed * 0.13,
          face ?? (seatedChat(identity.seed, performance.now() / 1000) ? 'talk' : undefined), CROWD[body.index]?.person?.mood) : undefined,
        null, level);
      if (helmet) {
        // This body's helmet on the head of the pose carrying the most weight
        if (!headClip?.head || !batch.helmet) return -scale;
        helmet.multiplyMatrices(transform.matrix, helmetBone.multiplyMatrices(headClip.head, batch.helmet));
      }
      return scale;
    },
    /** Every figure drawn last frame, as the casting chose them: model, wardrobe, company and its dress code */
    census() {
      registry.recordCensus = true;
      return registry.census();
    },
    /** Whether the last `finish` drew anybody into the shadow map (`renderer.ts` moving casters). */
    get casting() { return casting; },
    finish() {
      casting = false;
      if (visualFrame % 300 === 0) for (const [id, kept] of lastPose) if (visualFrame - kept.frame > 600) lastPose.delete(id);
      for (const batch of batches.values()) {
        for (const part of batch.parts) for (const at of part.levels) {
          const mesh = at.mesh, count = at.count;
          // Its last figure gone from the shadow map: the map changes.
          if (mesh.castShadow && mesh.visible && mesh.count > 0 && count === 0) casting = true;
          mesh.count = count;
          // An empty level is still a program bind and its uniforms in every pass
          mesh.visible = count > 0;
          mesh.castShadow = detail > 0 && band < 2;
          if (mesh.castShadow && count > 0) casting = true;
          if (count === 0) continue;
          mesh.instanceMatrix.clearUpdateRanges();
          mesh.instanceMatrix.addUpdateRange(0, count * 16);
          mesh.instanceMatrix.needsUpdate = true;
          if (mesh.instanceColor && at.colourChanged) {
            mesh.instanceColor.clearUpdateRanges();
            mesh.instanceColor.addUpdateRange(0, count * 3);
            mesh.instanceColor.needsUpdate = true;
            at.colourChanged = false;
          }
          at.rows.clearUpdateRanges();
          at.rows.addUpdateRange(0, count);
          at.rows.needsUpdate = true;
          if (mesh.morphTexture) {
            // The faces of the bodies drawn, a row each (three sends an update range as one row of the image)
            const morph = mesh.morphTexture;
            morph.clearUpdateRanges();
            const row = morph.image.width;
            if (count * 2 < morph.image.height) for (let i = 0; i < count; i++) morph.addUpdateRange(i * row, row);
            morph.needsUpdate = true;
          }
        }
      }
    },
    /** The skeletons of the bodies written this frame, blended on the GPU before anybody draws them (`agents.renderPalettes`). */
    renderPalettes(renderer: WebGLRenderer): void {
      for (const batch of batches.values()) {
        if (batch.count === 0) continue;
        batch.pass.render(renderer, batch.count);
        batch.uniform.value = batch.pass.texture;
        batch.base.value = batch.pass.base;
      }
    },
    /** The pose a person was last drawn in, if within the last few seconds (`ragdoll.ts`): blended now, from what they played. */
    capturedPose(id: number): { index: number; palette: Float32Array; transform: Matrix4 } | null {
      const kept = lastPose.get(id);
      if (!kept || visualFrame - kept.frame >= 240) return null;
      const batch = batches.get(kept.index);
      if (!batch || batch.width !== kept.palette.length) return null;
      cpuPose(kept.palette, 0, kept.clips, kept.phases, kept.weights, batch.width, kept.single);
      for (const limb of kept.lost ?? []) maim(batch, kept.palette, 0, limb);
      return kept;
    },
    /** A loaded body's skeleton: bone names, parents, inverse binds, and part 0's local and bind matrices. */
    skeletonOf(index: number): { names: string[]; parents: number[]; inverses: Matrix4[]; local: Matrix4; bind: Matrix4 } | null {
      const batch = batches.get(index);
      const source = batch?.sources[0];
      if (!batch || !source) return null;
      const bones = source.skeleton.bones;
      return {
        names: bones.map((b) => b.name),
        parents: bones.map((b) => bones.indexOf(b.parent as never)),
        inverses: source.skeleton.boneInverses,
        local: batch.local[0]!,
        bind: source.bindMatrix,
      };
    },
    /** A library clip's pose on a loaded body at `phase` */
    /** Called for every bleeding walker drawn (`maimed`), with where they are. */
    set onBleed(f: ((id: number, x: number, y: number, z: number) => void) | null) { onBleed = f; },
    /** Bodies loaded and ready to draw, by index. */
    loadedIndices(): number[] {
      return [...batches.entries()].filter(([, b]) => b.clips.length > 0).map(([i]) => i);
    },
    clipPose(index: number, key: Played, phase: number): { palette: Float32Array; duration: number } | null {
      const batch = batches.get(index);
      if (!batch) return null;
      const at = LIBRARY_AT[key];
      if (batch.deferred.size) want(batch, at);
      const clip = batch.clips[at];
      // A stand-in until baked: not the clip asked for.
      if (!clip || batch.deferred.has(at) || baking.get(batch)?.has(at)) return null;
      const out = new Float32Array(batch.width);
      const bones = batch.width / SKIN_BONE_FLOATS;
      const packedWidth = bones * PACKED_BONE_FLOATS;
      const f = Math.min(1, Math.max(0, phase)) * clip.frames;
      const whole = Math.min(clip.frames, Math.floor(f));
      blendPackedFrames(out, 0, clip.data, whole * packedWidth, packedWidth, bones, 1 - (f - whole), f - whole);
      return { palette: out, duration: clip.duration };
    },
    /** Draws a body of `index` with a palette of skin matrices (`ragdoll.ts`) and an instance matrix. */
    /** The body somebody of this identity is drawn with (a rider thrown off is the same person, `ragdoll.fling`). */
    indexFor(identity: ClipIdentity, helmet: boolean, x: number, y: number): number | null {
      return bodyFor(contextOf(identity, helmet, x, y))?.index ?? null;
    },
    /** The people cast in a company forgotten: its vehicle is gone from the world (`CastingRegistry.forgetCompany`). */
    forgetCompany(company: Company, companyId: number): void {
      registry.forgetCompany(company, companyId);
    },
    /** How many people the casting remembers (tests). */
    get remembered(): number {
      return registry.remembered;
    },
    drawPalette(index: number, palette: Float32Array, instance: Matrix4, charred = false): void {
      const batch = batches.get(index);
      if (!batch || batch.count >= CAPACITY || palette.length !== batch.width) return;
      if (batch.count >= batch.rows) grow(batch);
      // Worked out by the ragdoll: the pass copies it as it is.
      batch.pass.setOverride(batch.count, palette);
      batch.pass.setPlays(batch.count, null, 0);
      const e = instance.elements;
      // Its face's weights too, close up: the slot otherwise keeps whatever the morph texture held there - zero, never written
      const level = levelOf(e[12]!, -e[14]!, e[13]!);
      place(batch, level, instance, charred ? BURNT : UNBURNT, level === 0 ? NEUTRAL_FACE : undefined);
      batch.count++;
      batch.lastUsed = frameNow;
    },
    dispose() {
      disposed = true;
      clearInterval(evictionTimer);
      for (const entry of queuedLoads.values()) entry.resolve();
      queuedLoads.clear();
      for (const batch of batches.values()) {
        batch.disposed = true;
        disposeOwned(batch.resources);
      }
      disposeOwned(resources);
      resources.clear(); batches.clear(); loading.clear(); wantedFrame.clear(); group.clear();
      releaseIdleBakeWorkers();
    },
  };
}

/** The people's style: realistic, or as an animated film draws them (`people/cartoon.ts`). */
function peopleStyle(): CartoonStyle {
  try {
    const asked = new URLSearchParams(location.search).get('style') ?? localStorage.getItem('roadcraft.peopleStyle');
    return asked === 'pixar' ? PIXAR : REALISTIC;
  } catch {
    return REALISTIC;
  }
}

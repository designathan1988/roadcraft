import type { Severable } from '@sim/people/view';
import {
  BufferAttribute, BufferGeometry, Color, DataTexture, DynamicDrawUsage, FloatType, Group, InstancedBufferAttribute, InstancedMesh,
  type Material, Matrix4, MeshDepthMaterial, MeshStandardMaterial, Object3D, Quaternion, RGBAFormat,
  RGBADepthPacking, SkinnedMesh, Texture, Vector3, type WebGLRenderer,
} from 'three';
import { PIXAR, REALISTIC, cartoonBody, styleFor, type CartoonStyle } from './people/cartoon';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { personHash, type PartyView, type PedView } from '@sim/people/view';
import { DT } from '@sim/dt';
import { m, perM } from '@world/units';
import { CROWD, CROWD_IDS, CastingRegistry, type CastingContext, type Company } from './citizenCasting';
import { NO_HELMET, type RiderClipKey } from './riderPoses';
import { CITIZEN_ASSET_URLS, CITIZEN_LICENSES } from './citizenAssets';
import type { CitizenModel } from './citizenCasting';
import { loadPeopleAssets } from '@people/body/assets';
import { Morpher } from '@people/body/morph';
import { createPersonRig, personSimplifier } from './people/personRig';
import { cancelUploads, compileAhead, shadowStandIn, warmAhead } from './uploads';
import { bakeDeferredInWorker, bakeInWorker, releaseIdleBakeWorkers } from './bakePool';
import { cookPerson, loadCookedPerson, peopleCookHash } from './people/cookedPerson';
import { HELD, createHeldProps } from './people/heldProps';
import { attachFacialMorphs } from './people/facialMorphs';
import { applyFace, channelShapes, faceAt, type FaceWeights } from './people/faceExpression';
import { expressionShapes } from '@people/body/expressions';
import { applySkinAppearance, createPersonLayers, loadSkinAppearance, releaseSkinAppearance, type SkinAppearance } from './people/skinAppearance';
import { loadProxyItem, type ProxyItem } from '@people/body/proxy';
import { wornItems } from '@people/spec';
import { type WalkSex, captureBind, captureBindRotations, loadRocketboxClips } from './citizenWalk';
import { type Gradient, shearMatrix } from './groundShear';
import { PACKED_BONE_FLOATS, SKIN_BONE_FLOATS, blendPackedFrames } from './citizenPalette';
import { GPU_PLAYS, citizenAtlas, cpuPose, gpuPlays, type CitizenAtlas, type Play } from './citizenPlays';
import { createPalettePass, createPaletteTargets, renderPalettes, type PalettePass } from './people/crowdAnimation';
import { createGait, gaitHeading, gaitPlays, stepGait, type Gait, type GaitClips, type GaitPlay } from './citizenGait';
import {
  CARRY_AT, GAIT_AT, LIBRARY_AT, RIDER_AT, WALK, WALK_ELDER, afterFrame, bake, gaitClips,
  type CitizenClipKey, type ClipFrames, type Deferred, type Played,
} from './citizenBake';

export type { CitizenClipKey } from './citizenBake';
export { CROWD_IDS } from './citizenCasting';
const CAPACITY = 1000;
interface CitizenBatch {
  resources: Set<{ dispose(): void }>;
  animationBytes: number;
  lastUsed: number;
  disposed: boolean;
  /** The body's parts (the skin, each garment), each drawn at the level of every figure (`CitizenPart`). */
  parts: CitizenPart[]; clips: ClipFrames[];
  /** The same baked clips, by the name the gait plays them by. */
  gait: GaitClips;
  /** Floats of a body's palette (16 a bone), and the bodies written this frame. */
  width: number; count: number;
  /** The skeletons blended on the GPU (`people/crowdAnimation.ts`): the clips' atlas, the pass, its rows; the skinning reads `uniform`. */
  atlas: CitizenAtlas; pass: PalettePass; rows: number; uniform: { value: Texture };
  /** The first row of its people in the shared palettes (`renderPalettes`), read by its skinning. */
  readonly base: { value: number };
  /** A body's palette worked out on the CPU (held by a ragdoll, maimed, more plays than the pass takes). */
  readonly scratch: Float32Array;
  /** Rest joints for the pass's refit, all at the origin: the cooked bodies are drawn on their own joints. */
  readonly joints: DataTexture;
  readonly parents: Int16Array;
  /** This body's helmet in its head bone's frame (`riderPoses.helmetShape`), or null. */
  helmet: Matrix4 | null;
  /** Clips still to bake, on first use (`Deferred`), one at a time: in a bake worker, from this rig (`bakeDeferredInWorker`). */
  deferred: Deferred;
  readonly rig: { readonly scene: Object3D; readonly sex: WalkSex };
  baking: Promise<void>;
}

/** One part of a body: its levels, its two sets of materials, and an instanced mesh per level a figure was drawn at. */
export interface CitizenPart {
  readonly source: SkinnedMesh;
  readonly local: Matrix4;
  /** Its geometry at each level (`CITIZEN_LEVEL_ERROR`), the first with the face's morphs. */
  readonly lods: readonly BufferGeometry[];
  /** The materials of a figure close enough for its skin, hair and garment detail, and of one too far for them (`citizenBandAt` 2 and on). */
  readonly fine: Material | Material[];
  readonly coarse: Material | Material[];
  readonly depth: MeshDepthMaterial;
  /** Its meshes' name: `citizen-<model>-<part>`, and the slot after `@`. */
  readonly name: string;
  /** By `levelKey`: made the first time a figure is drawn there. */
  readonly drawn: (LevelMesh | undefined)[];
}

/** The figures of one part at one level: the instanced mesh, each instance's palette row (`citizenRow`), how many this frame. */
export interface LevelMesh {
  readonly mesh: InstancedMesh;
  readonly rows: InstancedBufferAttribute;
  readonly level: number;
  readonly coarse: boolean;
  count: number;
}

/** A figure's mesh slot: its level, and whether it is past the zoom of its detail (no skin detail, no shadow). */
const levelKey = (level: number, coarse: boolean): number => level * 2 + (coarse ? 1 : 0);

/** How a figure is drawn by its own size on the screen (`zoom`, CSS pixels a world unit where it stands): its level and its band. */
export function citizenLookAt(zoom: number): { readonly level: number; readonly band: number } {
  return { level: citizenLevelFor(zoom), band: citizenBandAt(zoom) };
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

/** Who a figure drawn by `drawClip` is and with whom: the casting context without the place. */
export interface ClipIdentity {
  readonly seed: number;
  readonly gender: 'f' | 'm';
  readonly ageClass: 'child' | 'adult' | 'elder';
  readonly company: Company;
  readonly companyId: number;
  readonly hasChild?: boolean;
}

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

/** A face's weights written into a level-0 part's instance `slot` (only the nearest level carries the face's morphs). */
function setFacialExpression(part: CitizenPart, drawn: LevelMesh, slot: number, face: FaceWeights): void {
  const source = part.source;
  const influences = source.morphTargetInfluences;
  const targets = source.morphTargetDictionary;
  if (!influences || !targets || !drawn.mesh.geometry.morphAttributes.position) return;
  applyFace(influences, targets, face);
  const mesh = drawn.mesh;
  // three allocates an InstancedMesh's morph texture from `count`.
  const visible = mesh.count;
  if (mesh.morphTexture === null) mesh.count = CAPACITY;
  mesh.setMorphAt(slot, source);
  mesh.count = visible;
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

/** `base`: the first row of this body's people in the palettes' shared target (`renderPalettes`). */
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

/** The instanced mesh of a part at `key` (`levelKey`), made the first time a figure is drawn there: the level's geometry shared, its own palette rows. */
export function levelMeshOf(group: Group, batch: Pick<CitizenBatch, 'resources'>, part: CitizenPart, key: number): LevelMesh {
  const kept = part.drawn[key];
  if (kept) return kept;
  const level = key >> 1, coarse = (key & 1) === 1;
  const variant = part.lods[Math.min(level, part.lods.length - 1)]!;
  const geometry = new BufferGeometry();
  for (const name of Object.keys(variant.attributes)) geometry.setAttribute(name, variant.getAttribute(name));
  geometry.setIndex(variant.getIndex());
  for (const g of variant.groups) geometry.addGroup(g.start, g.count, g.materialIndex);
  // The face's morphs on the nearest level only (`applyFace`).
  if (variant.morphAttributes.position) { geometry.morphAttributes = variant.morphAttributes; geometry.morphTargetsRelative = variant.morphTargetsRelative; }
  geometry.boundingBox = variant.boundingBox;
  geometry.boundingSphere = variant.boundingSphere;
  // Each instance's row of the palette pass: the figures of a level are not the pass's rows in order.
  const rows = new InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
  rows.setUsage(DynamicDrawUsage);
  geometry.setAttribute('citizenRow', rows);
  const mesh = new InstancedMesh(geometry, coarse ? part.coarse : part.fine, CAPACITY);
  // InstancedMesh does not initialise this array itself.
  if (geometry.morphAttributes.position && part.source.morphTargetInfluences) mesh.morphTargetInfluences = [...part.source.morphTargetInfluences];
  // A colour per body from the start (white): a body burnt black by a bomb is the same program, its colour near black
  mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(CAPACITY * 3).fill(1), 3);
  mesh.instanceColor.setUsage(DynamicDrawUsage);
  mesh.name = `${part.name}@${key}`;
  mesh.count = 0;
  // Hidden until it has somebody to draw (`finish` shows it then).
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  // Small animated figures do not receive shadow maps
  mesh.receiveShadow = false;
  mesh.customDepthMaterial = part.depth;
  batch.resources.add(mesh);
  batch.resources.add({ dispose: () => mesh.morphTexture?.dispose() });
  group.add(mesh);
  const made: LevelMesh = { mesh, rows, level, coarse, count: 0 };
  part.drawn[key] = made;
  return made;
}

/** A part's world matrix for one figure, reused (`placeFigure`). */
const PART_MATRIX = new Matrix4();

/** One figure into the mesh of each part at its level: its matrix, colour and palette row; its face where its level has one. */
export function placeFigure(group: Group, batch: Pick<CitizenBatch, 'parts' | 'resources' | 'count' | 'lastUsed'>, look: { readonly level: number; readonly band: number },
  instance: Matrix4, colour: Color, now: number, expression?: FaceWeights): void {
  const key = levelKey(look.level, look.band >= 2);
  for (const part of batch.parts) {
    const drawn = levelMeshOf(group, batch, part, key);
    const slot = drawn.count++;
    PART_MATRIX.multiplyMatrices(instance, part.local);
    drawn.mesh.setMatrixAt(slot, PART_MATRIX);
    drawn.mesh.setColorAt(slot, colour);
    (drawn.rows.array as Float32Array)[slot] = batch.count;
    // Faces are read only close up: from the nearest level of detail on, no expression is computed or uploaded.
    if (expression && look.level === 0) setFacialExpression(part, drawn, slot, expression);
  }
  batch.count++;
  batch.lastUsed = now;
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
  /** Every body's palettes in one pair of targets (`renderPalettes`), and this frame's passes and bases, reused. */
  const palettes = createPaletteTargets();
  resources.add(palettes);
  const paletteJobs: { pass: PalettePass; rows: number }[] = [];
  const paletteBases: number[] = [];
  const drawnBatches: CitizenBatch[] = [];
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
      const source = batch.parts[0]?.source;
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
  const helmetBone = new Matrix4();
  let disposed = false;
  let morpher: Morpher | null = null;
  let detail = 2;
  /** The view's zoom, and the scale of the screen where a figure stands (CSS pixels a world unit): each figure's level by its own (`lookAt`). */
  let zoomNow = Infinity;
  let scaleAt: ((x: number, y: number, z: number) => number) | null = null;
  /** A figure's level and band where it stands (world x, y, height). */
  const lookAt = (x: number, y: number, z: number): { readonly level: number; readonly band: number } =>
    citizenLookAt(scaleAt ? scaleAt(x, y, z) : zoomNow);
  let frameNow = performance.now();
  // Keep a recently seen body ready for a return pan
  const IDLE_MS = 60_000;
  const evictInactive = (): void => {
    const now = performance.now();
    for (const [index, batch] of batches) {
      if (batch.count > 0 || now - batch.lastUsed < IDLE_MS) continue;
      batch.disposed = true;
      for (const part of batch.parts) for (const drawn of part.drawn) if (drawn) group.remove(drawn.mesh);
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
  group.userData.availableModels = models.length;
  group.userData.models = models;
  group.userData.licenses = CITIZEN_LICENSES;

  /** A roster person (`people/roster.ts`) as a loaded asset would be */
  async function personAsset(model: CitizenModel, fresh = false,
    owned: Set<{ dispose(): void }> = resources): Promise<GLTF> {
    const person = model.person!;
    // Cooked ahead (`cookedPerson.ts`, `npm run cook:people`): read back, not built - the realistic bodies
    const style = peopleStyle();
    const cooked = fresh || style !== REALISTIC ? null : await loadCookedPerson(model.id);
    if (cooked) {
      let mesh: SkinnedMesh | undefined;
      cooked.traverse((o) => { if (o instanceof SkinnedMesh && !mesh) mesh = o; });
      if (mesh) {
        const skin = await loadSkinAppearance(person);
        owned.add({ dispose: () => releaseSkinAppearance(skin) });
        mesh.geometry.userData['skinAppearance'] = skin;
        return { scene: cooked, parser: null } as unknown as GLTF;
      }
    }
    const people = await loadPeopleAssets();
    morpher ??= new Morpher(people.packs);

    // The garments it wears, loaded first; failing that it is drawn in the tailored shells rather than not at all.
    const proxies = new Map<string, ProxyItem>();
    try {
      for (const [name, item] of await Promise.all(wornItems(person.look).map(async (n) => [n, await loadProxyItem(n)] as const))) proxies.set(name, item);
    } catch { proxies.clear(); }
    const input = {
      proxies,
      texturedSkin: true,
      data: people.mesh, skeleton: people.skeleton, bodyRange: people.bodyRange,
      positions: cartoonBody(morpher.shape(person.body, person.features), people.mesh, styleFor(style, person.id)), look: person.look,
      capture: captureBind(model.gender === 'f' ? 'female' : 'male'), captureAxes: captureBindRotations(model.gender === 'f' ? 'female' : 'male'),
    };
    await personSimplifier;
    // A body is built in one go, just after a frame is drawn.
    await afterFrame();
    const built = performance.now();
    const rig = createPersonRig(input);
    performance.measure('person-rig', { start: built, end: performance.now() });
    // Live faces: blinking, gaze, mood, speech
    if (new URLSearchParams(location.search).get('expressions') !== 'off') {
      const faceAt = performance.now();
      await attachFacialMorphs(input, rig, channelShapes(await expressionShapes()));
      performance.measure('person-face', { start: faceAt, end: performance.now() });
    }
    {
      const skin = await loadSkinAppearance(person);
      owned.add({ dispose: () => releaseSkinAppearance(skin) });
      rig.mesh.geometry.userData['skinAppearance'] = skin;
    }
    return { scene: rig.scene, parser: null } as unknown as GLTF;
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
    const [asset, library] = await Promise.all([
      model?.person ? personAsset(model, false, owned) : (async () => {
        const url = CITIZEN_ASSET_URLS[model?.sourceId ?? models[index]!];
        if (!url) throw new Error(`Missing citizen asset: ${models[index]}`);
        return new GLTFLoader().loadAsync(url);
      })(),
      loadRocketboxClips(sex),
    ]);
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
      performance.measure('person-bake', { start: bakeAt, end: performance.now() });
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
      const uniform: { value: Texture } = { value: palettes.texture };
      const base = { value: 0 };
      const batch: CitizenBatch = { parts: [], clips, gait: gaitClips(clips), width, rows,
        atlas, pass, uniform, base, scratch: new Float32Array(width), joints, parents,
        count: 0, helmet, resources: owned, animationBytes: 0,
        lastUsed: performance.now(), disposed: false,
        deferred, baking: Promise.resolve(), rig: { scene: asset.scene, sex } };
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
        // The same materials twice: a figure close enough for its skin, hair and garment detail, and one too far for them (`appearanceDetail` 0).
        const materialsFor = (detailed: boolean): MeshStandardMaterial[] => original.map((source, materialIndex) => {
          const material = (source as MeshStandardMaterial).clone();
          material.color.setHex(0xffffff); // Preserve authored skin; never tint the whole citizen.
          // A roster person's colours are its vertices' (`personRig.ts`).
          material.roughness = 0.88;
          material.metalness = 0;
          skinMaterial(material, uniform, o, materialIndex === 0 ? (CROWD[index]?.look ?? 0) : 0, base);
          const skin = o.geometry.userData['skinAppearance'] as SkinAppearance | undefined;
          if (skin) applySkinAppearance(material, o.geometry, skin, personLayers);
          const appearance = material.userData['appearanceDetail'] as { value: number } | undefined;
          if (appearance) appearance.value = detailed ? 1 : 0;
          owned.add(material);
          return material;
        });
        const fine = materialsFor(true), coarse = materialsFor(false);
        const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
        const source = original[0] as MeshStandardMaterial;
        depth.map = source.map;
        depth.alphaTest = source.alphaTest;
        skinMaterial(depth, uniform, o, 0, base);
        owned.add(depth);
        const many = Array.isArray(o.material);
        batch.parts.push({ source: o, local: o.matrixWorld.clone(), lods: variants, fine: many ? fine : fine[0]!, coarse: many ? coarse : coarse[0]!,
          depth, drawn: [], name: `citizen-${models[index]}-${o.name}` });
      }
      // Each part's nearest level made now: the geometry of every level is sent to the GPU through it, and the face's programs built on it.
      for (const part of batch.parts) added.push(levelMeshOf(group, batch, part, levelKey(0, false)).mesh);
      // Its shaders built before it is drawn (`uploads.ts`) - the programs it is really drawn with: a body far off has no face
      const warm = new Group();
      const shadows = new Group();
      const temporary: InstancedMesh[] = [];
      batch.parts.forEach((part) => {
        const mesh = part.drawn[levelKey(0, false)]!.mesh;
        const variants = part.lods;
        const source = part.source;
        const forms = [variants[Math.min(1, variants.length - 1)]!, variants[0]!];
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
          stand.castShadow = true;
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
      await Promise.all(batch.parts.map((part) => warmAhead(part.drawn[levelKey(0, false)]!.mesh, part.lods.slice(1))));
      if (abandonIfUnwanted()) return;
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
      // On another core; on the page only where no worker can.
      const clip = await bakeDeferredInWorker(batch.rig.scene, batch.rig.sex, at, batch.clips[GAIT_AT.walkShuffle]!) ?? await job.make();
      waiting.delete(at);
      if (disposed || batch.disposed) return;
      batch.clips[at] = clip;
      batch.gait = gaitClips(batch.clips);
      laidIn(batch, at, clip);
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
    weights: readonly number[], lost: readonly Severable[] | null, single: boolean): void {
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

  /** Writes one citizen: its bone palette (`pose`) plus instance transform, at its own level (`look`, `lookAt`). */
  function emit(batch: CitizenBatch, look: { readonly level: number; readonly band: number }, clips: readonly ClipFrames[], phases: readonly number[],
    weights: readonly number[], x: number, height: number, y: number, heading: number, scale: number,
    lean = 0, ground: Gradient | null = null, expression?: FaceWeights, lost: readonly Severable[] | null = null): void {
    pose(batch, batch.count, clips, phases, weights, lost, look.band >= 2);
    transform.position.set(x, height, -y);
    // Yaw, then a roll about the body's own forward axis
    transform.rotation.set(0, heading + Math.PI / 2, -lean, 'YXZ');
    transform.scale.set(scale, scale, scale);
    transform.updateMatrix();
    if (ground) shearMatrix(transform.matrix, ground, x, -y);
    placeFigure(group, batch, look, transform.matrix, UNBURNT, frameNow, expression);
  }


  /** Room for twice the bodies in the pass (its rows written so far kept); the skinning reads its new target. */
  function grow(batch: CitizenBatch): void {
    const before = paletteBytes(batch);
    batch.rows = Math.min(CAPACITY, batch.rows * 2);
    batch.pass.grow(batch.rows);
    group.userData.paletteBytes += paletteBytes(batch) - before;
  }

  /** A clip baked since the atlas was laid: added to the same atlas, read by the same pass (`CitizenAtlas.add`). */
  function laidIn(batch: CitizenBatch, at: number, clip: ClipFrames): void {
    const before = paletteBytes(batch);
    batch.atlas.add(at, clip);
    group.userData.paletteBytes += paletteBytes(batch) - before;
  }

  return {
    group,
    /** `screenScale`: CSS pixels a world unit where a figure stands: each figure's mesh by its own error on the screen, its face and detail by its own size; none, the view's zoom for all. */
    begin(level = 2, zoom = Infinity, screenScale?: (x: number, y: number, z: number) => number) {
      frameNow = performance.now();
      visualFrame++;
      held.begin();
      detail = level;
      registry.beginFrame();
      zoomNow = zoom;
      scaleAt = screenScale ?? null;
      group.userData.lod = citizenLevelFor(zoom);
      for (const batch of batches.values()) {
        batch.count = 0;
        for (const part of batch.parts) for (const drawn of part.drawn) if (drawn) drawn.count = 0;
      }
    },
    /** Draws one pedestrian, the body playing what `citizenGait.ts` decides from how the simulation moves it */
    /** `ground`: the footway's gradient under the walker, so both feet stand on it (`groundShear.ts`). */
    draw(ped: PedView, x: number, y: number, heading: number, deck: number, alpha: number,
      ground: Gradient | null = null, lean = 0, priority = false) {
      const hash = personHash(ped.id);
      const body = bodyFor({ seed: ped.id, gender: ped.gender, ageClass: ped.ageClass, company: companyOf(ped.party),
        companyId: ped.party.id, hasChild: ped.party.hasChild, x, y });
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
      const look = lookAt(x, y, deck);
      const band = look.band;
      emit(batch, look, mixClips, mixPhases, mixWeights, x, deck, y, gaitHeading(gait), m(scale), lean, ground,
        look.level === 0 ? faceAt(ped.id, time, ped.panic ? (ped.gesture?.kind === 'crouch' ? 'cry' : 'panic') : ped.gesture?.kind, CROWD[index]?.person?.mood) : undefined,
        lost);
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
      const body = bodyFor({ ...identity, helmet: helmet !== null, x: pelvisX, y: pelvisY });
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
      const look = lookAt(pelvisX, pelvisY, pelvisHeight);
      emit(batch, look, mixClips, mixPhases, mixWeights,
        pelvisX - leftX * drop * Math.sin(lean) - leftX * shiftLeft - aheadX * shiftAhead, pelvisHeight - drop * Math.cos(lean),
        pelvisY - leftY * drop * Math.sin(lean) - leftY * shiftLeft - aheadY * shiftAhead, heading, scale, lean, null,
        // In a seat a face lives too: blinking, glancing, a passenger chatting now and then (wall time: the render's own clock).
        look.level === 0 ? faceAt(identity.seed, performance.now() / 1000 + identity.seed * 0.13,
          face ?? (seatedChat(identity.seed, performance.now() / 1000) ? 'talk' : undefined), CROWD[body.index]?.person?.mood) : undefined);
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
      for (const batch of batches.values()) for (const part of batch.parts) for (const drawn of part.drawn) {
        if (!drawn) continue;
        const mesh = drawn.mesh, count = drawn.count;
        mesh.count = count;
        // An empty level is still a program bind and its uniforms in every pass
        mesh.visible = count > 0;
        // Past the zoom of their detail, figures cast no shadow (`citizenBandAt` 2 and on).
        mesh.castShadow = detail > 0 && !drawn.coarse;
        if (mesh.castShadow && count > 0) casting = true;
        if (count === 0) continue;
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, count * 16);
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) {
          mesh.instanceColor.clearUpdateRanges();
          mesh.instanceColor.addUpdateRange(0, count * 3);
          mesh.instanceColor.needsUpdate = true;
        }
        drawn.rows.clearUpdateRanges();
        drawn.rows.addUpdateRange(0, count);
        drawn.rows.needsUpdate = true;
        if (mesh.morphTexture && drawn.level === 0) {
          // The faces of the bodies drawn, a row each (three sends an update range as one row of the image)
          const morph = mesh.morphTexture;
          morph.clearUpdateRanges();
          const row = morph.image.width;
          if (count * 2 < morph.image.height) for (let i = 0; i < count; i++) morph.addUpdateRange(i * row, row);
          morph.needsUpdate = true;
        }
      }
    },
    /** The skeletons of the bodies written this frame, blended on the GPU before anybody draws them (`agents.renderPalettes`). */
    renderPalettes(renderer: WebGLRenderer): void {
      // Every body's people into the same targets, each its band of rows (`renderPalettes`): two targets bound a frame, not two a body.
      paletteJobs.length = 0;
      drawnBatches.length = 0;
      for (const batch of batches.values()) if (batch.count > 0) { paletteJobs.push({ pass: batch.pass, rows: batch.count }); drawnBatches.push(batch); }
      if (!paletteJobs.length) return;
      renderPalettes(renderer, palettes, paletteJobs, paletteBases);
      for (let i = 0; i < drawnBatches.length; i++) {
        const batch = drawnBatches[i]!;
        batch.base.value = paletteBases[i]!;
        batch.uniform.value = palettes.texture;
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
      const source = batch?.parts[0]?.source;
      if (!batch || !source) return null;
      const bones = source.skeleton.bones;
      return {
        names: bones.map((b) => b.name),
        parents: bones.map((b) => bones.indexOf(b.parent as never)),
        inverses: source.skeleton.boneInverses,
        local: batch.parts[0]!.local,
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
      return bodyFor({ ...identity, helmet, x, y })?.index ?? null;
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
      // At its own level where it lies; its face's weights too, close up: the slot otherwise keeps whatever the morph texture held there
      placeFigure(group, batch, lookAt(instance.elements[12], -instance.elements[14], instance.elements[13]), instance, charred ? BURNT : UNBURNT, frameNow, NEUTRAL_FACE);
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

import type { Severable } from '@sim/people/view';
import {
  BufferAttribute, BufferGeometry, Color, DataTexture, DynamicDrawUsage, FloatType, Group, InstancedBufferAttribute, InstancedMesh,
  Matrix4, MeshDepthMaterial, MeshStandardMaterial, Object3D, Quaternion, RGBAFormat,
  RGBADepthPacking, SkinnedMesh, Texture, Vector3,
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
import { bakeInWorker, releaseIdleBakeWorkers } from './bakePool';
import { cookPerson, loadCookedPerson, peopleCookHash } from './people/cookedPerson';
import { HELD, createHeldProps } from './people/heldProps';
import { attachFacialMorphs } from './people/facialMorphs';
import { applyFace, channelShapes, faceAt, type FaceWeights } from './people/faceExpression';
import { expressionShapes } from '@people/body/expressions';
import { applySkinAppearance, createFaceCardAtlas, loadSkinAppearance, releaseSkinAppearance, type SkinAppearance } from './people/skinAppearance';
import { loadProxyItem, type ProxyItem } from '@people/body/proxy';
import { wornItems } from '@people/spec';
import { captureBind, captureBindRotations, loadRocketboxClips } from './citizenWalk';
import { type Gradient, shearMatrix } from './groundShear';
import { PACKED_BONE_FLOATS, SKIN_BONE_FLOATS, blendPackedFrames, copyPackedFrame } from './citizenPalette';
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
  meshes: InstancedMesh[]; sources: SkinnedMesh[]; local: Matrix4[]; clips: ClipFrames[];
  /** The same baked clips, by the name the gait plays them by. */
  gait: GaitClips;
  texture: DataTexture; pixels: Float32Array; width: number; count: number;
  rows: number; uniform: { value: DataTexture };
  lods: BufferGeometry[][];
  /** Each mesh's per-instance morph texture, kept aside while its level has no face (lod > 0). */
  parkedMorph: (DataTexture | null)[];
  /** This body's helmet in its head bone's frame (`riderPoses.helmetShape`), or null. */
  helmet: Matrix4 | null;
  /** Clips still to bake, on first use (`Deferred`), one at a time. */
  deferred: Deferred;
  baking: Promise<void>;
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
mat4 getBoneMatrix(const in float i) {
  int x = int(i)*4;
  int y = gl_InstanceID;
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

function setFacialExpression(batch: CitizenBatch, slot: number, face: FaceWeights): void {
  for (let i = 0; i < batch.meshes.length; i++) {
    const source = batch.sources[i]!;
    const influences = source.morphTargetInfluences;
    const targets = source.morphTargetDictionary;
    if (!influences || !targets) continue;
    applyFace(influences, targets, face);
    const mesh = batch.meshes[i]!;
    // three allocates an InstancedMesh's morph texture from `count`.
    const visible = mesh.count;
    if (mesh.morphTexture === null) mesh.count = CAPACITY;
    mesh.setMorphAt(slot, source);
    mesh.count = visible;
  }
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

function skinMaterial(material: MeshStandardMaterial | MeshDepthMaterial, uniform: { value: DataTexture },
  mesh: SkinnedMesh, look = 0): void {
  material.defines = { ...material.defines, USE_SKINNING: '' };
  material.onBeforeCompile = shader => {
    shader.uniforms.citizenBones = uniform;
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
  material.customProgramCacheKey = () => `citizen-skinning-v2-look${look}`;
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
  // The brows and lashes of every body's materials, in one array of layers (`FaceCardAtlas`).
  const faceCards = createFaceCardAtlas();
  resources.add(faceCards);
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
  const maim = (batch: CitizenBatch, offset: number, limb: Severable): void => {
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
    const px = batch.pixels;
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
  const lastPose = new Map<number, { index: number; palette: Float32Array; transform: Matrix4; frame: number }>();
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
  let morpher: Morpher | null = null;
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
      for (const texture of batch.parkedMorph) texture?.dispose();
      disposeOwned(batch.resources);
      group.userData.paletteBytes -= batch.pixels.byteLength;
      group.userData.animationBytes -= batch.animationBytes;
      batches.delete(index);
      loading.delete(index);
      wantedFrame.delete(index);
    }
    group.userData.loadedModels = batches.size;
    if (batches.size === 0 && loading.size === 0) releaseIdleBakeWorkers();
  };
  const evictionTimer = typeof window === 'undefined' ? 0 : window.setInterval(evictInactive, 15_000);
  /** Puts mesh `i` of a batch on the current level of detail. */
  const applyLevel = (batch: CitizenBatch, i: number): void => {
    const variants = batch.lods[i]!;
    const mesh = batch.meshes[i]!;
    const wanted = variants[Math.min(lod, variants.length - 1)]!;
    if (mesh.geometry !== wanted) mesh.geometry = wanted;
    if (mesh.geometry.morphAttributes.position) {
      if (!mesh.morphTexture && batch.parkedMorph[i]) { mesh.morphTexture = batch.parkedMorph[i]!; batch.parkedMorph[i] = null; }
    } else if (mesh.morphTexture) {
      batch.parkedMorph[i] = mesh.morphTexture;
      mesh.morphTexture = null;
    }
    const material = mesh.material;
    for (const m of Array.isArray(material) ? material : [material]) {
      const appearance = m.userData['appearanceDetail'] as { value: number } | undefined;
      if (appearance) appearance.value = band <= 1 ? 1 : 0;
    }
  };
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
      const width = reference.skeleton.bones.length * 16;
      const rows = 16;
      const pixels = new Float32Array(rows * width);
      group.userData.paletteBytes = (group.userData.paletteBytes ?? 0) + pixels.byteLength;
      paletteAdded = pixels.byteLength;
      const texture = new DataTexture(pixels, width / 4, rows, RGBAFormat, FloatType);
      texture.needsUpdate = true;
      owned.add(texture);
      const uniform = { value: texture };
      const batch: CitizenBatch = { meshes: [], sources: [], local: [], clips, gait: gaitClips(clips), texture, pixels, width, rows,
        uniform, count: 0, lods: [], parkedMorph: [], helmet, resources: owned, animationBytes: 0,
        lastUsed: performance.now(), disposed: false,
        deferred, baking: Promise.resolve() };
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
          skinMaterial(material, uniform, o, materialIndex === 0 ? (CROWD[index]?.look ?? 0) : 0);
          const skin = o.geometry.userData['skinAppearance'] as SkinAppearance | undefined;
          if (skin) applySkinAppearance(material, o.geometry, skin, faceCards);
          owned.add(material);
          return material;
        });
        const mesh = new InstancedMesh(o.geometry, Array.isArray(o.material) ? materials : materials[0]!, CAPACITY);
        // InstancedMesh does not initialise this array itself.
        if (o.morphTargetInfluences) mesh.morphTargetInfluences = [...o.morphTargetInfluences];
        // A colour per body from the start (white): a body burnt black by a bomb is the same program, its colour near black
        mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(CAPACITY * 3).fill(1), 3);
        mesh.instanceColor.setUsage(DynamicDrawUsage);
        mesh.name = `citizen-${models[index]}-${o.name}`;
        mesh.count = 0;
        // Hidden until it has somebody to draw (`finish` shows it then).
        mesh.visible = false;
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(DynamicDrawUsage);
        mesh.castShadow = true;
        // Small animated figures do not receive shadow maps
        mesh.receiveShadow = false;
        const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
        const source = original[0] as MeshStandardMaterial;
        depth.map = source.map;
        depth.alphaTest = source.alphaTest;
        skinMaterial(depth, uniform, o);
        mesh.customDepthMaterial = depth;
        owned.add(mesh); owned.add(depth);
        batch.meshes.push(mesh);
        batch.sources.push(o);
        batch.lods.push(variants);
        batch.local.push(o.matrixWorld.clone());
        group.add(mesh);
        added.push(mesh);
      }
      // Its shaders built before it is drawn (`uploads.ts`) - the programs it is really drawn with: a body far off has no face
      const warm = new Group();
      const shadows = new Group();
      const temporary: InstancedMesh[] = [];
      batch.meshes.forEach((mesh, i) => {
        const variants = batch.lods[i]!;
        const source = batch.sources[i]!;
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
          stand.castShadow = mesh.castShadow;
          if (mesh.customDepthMaterial) stand.customDepthMaterial = mesh.customDepthMaterial;
          const cast = shadowStandIn(stand);
          if (cast) shadows.add(cast);
        }
      });
      await Promise.all([compileAhead(warm), compileAhead(shadows, true)]);
      for (const stand of temporary) stand.morphTexture?.dispose();
      warm.clear();
      shadows.clear();
      if (abandonIfUnwanted()) return;
      // And its geometry on the GPU, every level of it (`uploads.ts`).
      await Promise.all(batch.meshes.map((mesh, i) => warmAhead(mesh, batch.lods[i]!.slice(1))));
      if (abandonIfUnwanted()) return;
      // On the level in use NOW: a body arriving between two frames was drawn once on its nearest level, face and all
      for (let i = 0; i < batch.meshes.length; i++) applyLevel(batch, i);
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
        group.userData.paletteBytes -= committed.pixels.byteLength;
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
      const clip = await job.make();
      waiting.delete(at);
      if (disposed || batch.disposed) return;
      batch.clips[at] = clip;
      batch.gait = gaitClips(batch.clips);
      batch.animationBytes += clip.data.byteLength;
      group.userData.animationBytes = (group.userData.animationBytes ?? 0) + clip.data.byteLength;
    }).catch(() => {});
  }

  /** Writes one citizen: blended bone palette plus instance transform. */
  function emit(batch: CitizenBatch, clips: readonly ClipFrames[], phases: readonly number[],
    weights: readonly number[], x: number, height: number, y: number, heading: number, scale: number,
    lean = 0, ground: Gradient | null = null, expression?: FaceWeights): void {
    const offset = batch.count * batch.width;
    const bones = batch.width / SKIN_BONE_FLOATS;
    const packedWidth = bones * PACKED_BONE_FLOATS;
    // Far off (`band` 2, a body a few pixels tall), the pose is the frame of the clip that weighs most, copied as it is
    if (band >= 2) {
      let best = -1;
      for (let c = 0; c < clips.length; c++) if (best < 0 || weights[c]! > weights[best]!) best = c;
      if (best >= 0) {
        const clip = clips[best]!;
        const start = Math.round(Math.min(clip.frames, Math.max(0, phases[best]!))) * packedWidth;
        copyPackedFrame(batch.pixels, offset, clip.data, start, bones);
      } else batch.pixels.fill(0, offset, offset + batch.width);
    } else {
      const pixels = batch.pixels;
      const width = batch.width;
      pixels.fill(0, offset, offset + width);
      let total = 0;
      for (let c = 0; c < clips.length; c++) total += Math.max(0, weights[c]!);
      for (let c = 0; c < clips.length; c++) {
        const weight = Math.max(0, weights[c]!) / (total || 1);
        if (weight < 0.001) continue;
        const clip = clips[c]!;
        const data = clip.data;
        const f = Math.min(clip.frames, Math.max(0, phases[c]!));
        const fraction = f % 1;
        const start = Math.floor(f) * packedWidth;
        const a = weight * (1 - fraction);
        const b = weight * fraction;
        blendPackedFrames(pixels, offset, data, start, packedWidth, bones, a, b);
      }
    }
    transform.position.set(x, height, -y);
    // Yaw, then a roll about the body's own forward axis
    transform.rotation.set(0, heading + Math.PI / 2, -lean, 'YXZ');
    transform.scale.set(scale, scale, scale);
    transform.updateMatrix();
    if (ground) shearMatrix(transform.matrix, ground, x, -y);
    for (let i = 0; i < batch.meshes.length; i++) {
      matrix.multiplyMatrices(transform.matrix, batch.local[i]!);
      batch.meshes[i]!.setMatrixAt(batch.count, matrix);
      batch.meshes[i]!.setColorAt(batch.count, UNBURNT);
    }
    // Faces are read only close up: from the nearest level of detail on, no expression is computed or uploaded.
    if (expression && lod === 0) setFacialExpression(batch, batch.count, expression);
    batch.count++;
    batch.lastUsed = frameNow;
  }

  function grow(batch: CitizenBatch): void {
    const rows = Math.min(CAPACITY, batch.rows * 2);
    const pixels = new Float32Array(rows * batch.width);
    pixels.set(batch.pixels);
    group.userData.paletteBytes += pixels.byteLength - batch.pixels.byteLength;
    const texture = new DataTexture(pixels, batch.width / 4, rows, RGBAFormat, FloatType);
    texture.needsUpdate = true;
    batch.resources.delete(batch.texture);
    batch.texture.dispose();
    batch.rows = rows; batch.pixels = pixels; batch.texture = texture;
    batch.uniform.value = texture;
    batch.resources.add(texture);
  }

  return {
    group,
    begin(level = 2, zoom = Infinity) {
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
        if (levelChanged) for (let i = 0; i < batch.meshes.length; i++) applyLevel(batch, i);
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
      emit(batch, mixClips, mixPhases, mixWeights, x, deck, y, gaitHeading(gait), m(scale), lean, ground,
        lod === 0 ? faceAt(ped.id, time, ped.panic ? (ped.gesture?.kind === 'crouch' ? 'cry' : 'panic') : ped.gesture?.kind, CROWD[index]?.person?.mood) : undefined);
      // Every limb lost (shots take more than one), the stump closed at its joint.
      const lost = ped.lost ?? (ped.maimed ? [ped.maimed] : null);
      if (lost) {
        for (const limb of lost) maim(batch, (batch.count - 1) * batch.width, limb);
        onBleed?.(ped.id, x, y, deck);
      }
      {
        let kept = lastPose.get(ped.id);
        if (!kept || kept.palette.length !== batch.width) {
          kept = { index, palette: new Float32Array(batch.width), transform: new Matrix4(), frame: 0 };
          lastPose.set(ped.id, kept);
        }
        kept.index = index;
        kept.palette.set(batch.pixels.subarray((batch.count - 1) * batch.width, batch.count * batch.width));
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
      emit(batch, mixClips, mixPhases, mixWeights,
        pelvisX - leftX * drop * Math.sin(lean) - leftX * shiftLeft - aheadX * shiftAhead, pelvisHeight - drop * Math.cos(lean),
        pelvisY - leftY * drop * Math.sin(lean) - leftY * shiftLeft - aheadY * shiftAhead, heading, scale, lean, null,
        // In a seat a face lives too: blinking, glancing, a passenger chatting now and then (wall time: the render's own clock).
        lod === 0 ? faceAt(identity.seed, performance.now() / 1000 + identity.seed * 0.13,
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
      for (const batch of batches.values()) {
        if (batch.count > 0) {
          batch.texture.clearUpdateRanges();
          // three.js uploads each DataTexture update range as one image row.
          if (batch.count * 2 < batch.rows) {
            for (let i = 0; i < batch.count; i++) {
              batch.texture.addUpdateRange(i * batch.width, batch.width);
            }
          }
          batch.texture.needsUpdate = true;
        }
        for (const mesh of batch.meshes) {
          mesh.count = batch.count;
          // An empty batch is still a program bind and its uniforms in every pass
          mesh.visible = batch.count > 0;
          mesh.castShadow = detail > 0 && band < 2;
          if (mesh.castShadow && batch.count > 0) casting = true;
          if (batch.count > 0) {
            mesh.instanceMatrix.clearUpdateRanges();
            mesh.instanceMatrix.addUpdateRange(0, batch.count * 16);
            mesh.instanceMatrix.needsUpdate = true;
            if (mesh.instanceColor) {
              mesh.instanceColor.clearUpdateRanges();
              mesh.instanceColor.addUpdateRange(0, batch.count * 3);
              mesh.instanceColor.needsUpdate = true;
            }
            if (mesh.morphTexture && lod === 0) {
              // The faces of the bodies drawn, a row each (three sends an update range as one row of the image)
              const morph = mesh.morphTexture;
              morph.clearUpdateRanges();
              const row = morph.image.width;
              if (batch.count * 2 < morph.image.height) for (let i = 0; i < batch.count; i++) morph.addUpdateRange(i * row, row);
              morph.needsUpdate = true;
            }
          }
        }
      }
    },
    /** The pose a person was last drawn in, if within the last few seconds (`ragdoll.ts`). */
    capturedPose(id: number): { index: number; palette: Float32Array; transform: Matrix4 } | null {
      const kept = lastPose.get(id);
      return kept && visualFrame - kept.frame < 240 ? kept : null;
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
      batch.pixels.set(palette, batch.count * batch.width);
      for (let i = 0; i < batch.meshes.length; i++) {
        matrix.multiplyMatrices(instance, batch.local[i]!);
        batch.meshes[i]!.setMatrixAt(batch.count, matrix);
        batch.meshes[i]!.setColorAt(batch.count, charred ? BURNT : UNBURNT);
      }
      // Its face's weights too, close up: the slot otherwise keeps whatever the morph texture held there - zero, never written
      if (lod === 0) setFacialExpression(batch, batch.count, NEUTRAL_FACE);
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
        for (const texture of batch.parkedMorph) texture?.dispose();
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

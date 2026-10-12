import { loadPeopleAssets, type PeopleAssets } from '@people/body/assets';
import { Morpher } from '@people/body/morph';
import { DEFAULT_MACRO, ageFromYears, type MacroParams } from '@people/body/macro';
import { loadProxyItem, type ProxyItem, type ProxyPack } from '@people/body/proxy';
import { DEFAULT_LOOK, type PersonLook } from '@people/spec';
import { HAIR_STYLES, generateHair, generateHeadband, type HairBase, type HairStyle } from '@people/hair/procedural';
import { expressionShapes } from '@people/body/expressions';
import { loadProcedural, clipFields, clipOf, packRecord, proceduralCookHash } from './proceduralCook';
import type { PackRecord, PackValue } from './cookPack';
import { CHANNELS, channelShapes } from './faceExpression';
import { createPersonRig, type PersonRig } from './personRig';
import { captureBind, captureBindRotations, loadRocketboxClips, type WalkSex } from '../citizenWalk';
import { bakeLibraryClip, bakeWalk, breathe, restRig, type ClipFrames } from '../citizenBake';

/**
 * What the procedural crowd (`proceduralCrowd.ts`) is cooked from
 * (`npm run cook:people`, `proceduralCook.ts`): each body class's rig and data
 * - the shape basis, the clips, the joint basis, the face slots, the
 * expressions - and each hairstyle's cards. Pure functions of the code and
 * the assets, in a module of their own: the cook's fingerprint
 * (`cook-plugin.ts`) is this module's import closure, so how the crowd is
 * drawn can change without making the cooked data stale.
 *
 * Moved here unchanged from `proceduralCrowd.ts` (2026-10-08); what they
 * read from the crowd's closure is now `BakeEnv`.
 */

/** Principal components carried per body: 16 keep a body within about 1.5 cm of the full model. */
export const SHAPES = 16;
export const SHAPE_WIDTH = 4096;
/** Rows of a person's own face (`procFace`) are this wide; the vertex-to-face index (`procFaceIndex`) this wide. */
export const FACE_WIDTH = 2048;
export const FACE_INDEX_WIDTH = 4096;
/** The face's expression channels (`faceExpression.ts`: blink, joy, sadness, anger, surprise, brows, visemes), padded to 12. */
export const EXPR = Object.keys(CHANNELS).slice(0, 12);
export const EXPR_SLOTS = 12;

export type AgeBand = 'child' | 'young' | 'adult' | 'senior';
const BAND_YEARS: Readonly<Record<AgeBand, number>> = { child: 9, young: 22, adult: 42, senior: 72 };

/** A class's own body: the middle of every slider at the band's age. */
export function classBase(sex: WalkSex, band: AgeBand): MacroParams {
  return { ...DEFAULT_MACRO, gender: sex === 'female' ? 0 : 1, age: ageFromYears(BAND_YEARS[band]),
    muscle: 0.5, weight: 0.5, height: 0.5, proportions: 0.5, african: 1 / 3, asian: 1 / 3, caucasian: 1 / 3 };
}

/** What the bake reads: the people assets and morpher, the shape components, the eyes. */
export interface BakeEnv {
  setup(): Promise<{ assets: PeopleAssets; morpher: Morpher }>;
  /** The first `SHAPES` principal components (filled by `setup`). */
  readonly components: readonly Float32Array[];
  eyes(): Promise<ProxyItem>;
  /** The assets and morpher once `setup` has loaded them. */
  readonly loaded: { assets: PeopleAssets; morpher: Morpher } | null;
}

/** The assets loaded once, shared by the bake and the crowd that draws with it. */
export function createBakeEnv(): BakeEnv {
  let assets: PeopleAssets | null = null;
  let morpher: Morpher | null = null;
  let eyes: Promise<ProxyItem> | null = null;
  const components: Float32Array[] = [];
  return {
    components,
    async setup() {
      assets ??= await loadPeopleAssets();
      morpher ??= new Morpher(assets.packs);
      if (!components.length) for (let k = 0; k < SHAPES; k++) components.push(morpher.component(k));
      return { assets, morpher };
    },
    eyes: () => (eyes ??= loadProxyItem('eyes')),
    get loaded() { return assets && morpher ? { assets, morpher } : null; },
  };
}

/** A proxy pack as a cooked record, and back (`proceduralCook.ts`). */
export function packRecordOf(pack: ProxyPack): PackRecord {
  return {
    name: pack.name, kind: pack.kind, scaleRefs: pack.scaleRefs, scaleBase: pack.scaleBase, refs: pack.refs,
    weights: pack.weights, offsets: pack.offsets, index: pack.index, deleteVerts: pack.deleteVerts, colour: pack.colour,
    zDepth: pack.zDepth, uvs: pack.uvs ?? null, fade: pack.fade ?? null,
  };
}
export function packFromRecord(r: Record<string, PackValue>): ProxyPack {
  const uvs = r['uvs'], fade = r['fade'];
  return {
    name: r['name'] as string, kind: r['kind'] as ProxyPack['kind'], scaleRefs: r['scaleRefs'] as number[],
    scaleBase: r['scaleBase'] as unknown as [number, number, number], refs: r['refs'] as Uint32Array,
    weights: r['weights'] as Float32Array, offsets: r['offsets'] as Float32Array, index: r['index'] as Uint32Array,
    deleteVerts: r['deleteVerts'] as Uint32Array, colour: r['colour'] as number, zDepth: r['zDepth'] as number,
    ...(uvs instanceof Float32Array ? { uvs } : {}), ...(fade instanceof Float32Array ? { fade } : {}),
  };
}

/** The base mesh as a hairstyle is grown on it. */
export const hairBase = (a: PeopleAssets, mo: Morpher): HairBase => ({ positions: mo.base, vertexCount: a.mesh.vertexCount,
  bodyRange: a.bodyRange, joints: a.mesh.joints, weights: a.mesh.weights, boneNames: a.mesh.boneNames, faces: a.mesh.faces });

/** A hairstyle's cards: read from the cook (`proceduralCook.ts`), grown here only when it is missing or stale. */
export async function hairCards(env: BakeEnv, style: HairStyle): Promise<ProxyPack> {
  const cooked = await loadProcedural(`hair-${style.name}`);
  if (cooked) return packFromRecord(cooked);
  const { assets: a, morpher: mo } = await env.setup();
  const at = performance.now();
  const pack = generateHair(style, hairBase(a, mo));
  performance.measure(`hitch:person/hair ${style.name}`, { start: at, end: performance.now() });
  return pack;
}

/** What a class is made of besides its rig: computed here, or read from the cook. */
export interface ClassData {
  readonly shapePixels: Float32Array;
  readonly jointBasis: Float32Array;
  readonly faceIndexPixels: Float32Array;
  readonly faceList: Int32Array;
  readonly exprPixels: Float32Array;
  readonly walk: ClipFrames;
  readonly idle: ClipFrames;
  /** Running (from danger), and cowering crouched (struck with fear): the reactions' clips. */
  readonly run: ClipFrames;
  readonly cower: ClipFrames;
  /** Sprinting from a blow (GTA's peds flee at a flat-out run), and holding a phone up at it. */
  readonly sprint: ClipFrames;
  readonly photo: ClipFrames;
  /** Up off the ground from a crouch: what a body knocked down gets up with (`ragdoll.ts` rise). */
  readonly getUp: ClipFrames;
  /** Down into a crouch (a first wound doubles them over, `agents.ts` flinch). */
  readonly duck: ClipFrames;
  /** Walking hurt, a limp as captured (Rocketbox walk_bruised / walk_injured), and running hurt (run_injured). */
  readonly hurtWalk: ClipFrames;
  readonly hurtRun: ClipFrames;
  /** Standing scared, looking about (Rocketbox idle_nervous_01): a bystander's first moment after a shot. */
  readonly nervous: ClipFrames;
  /** Struck in the chest by a round, as captured (Quaternius Hit_Chest): the jerk of a hit. */
  readonly hit: ClipFrames;
  /** Knocked back a few steps, and up off the ground face down or face up (CMU captures). */
  readonly staggerBack: ClipFrames;
  readonly riseFront: ClipFrames;
  readonly riseBack: ClipFrames;
  /** On hands and knees, crawling (CMU 111_03). */
  readonly crawl: ClipFrames;
}
export const classRecord = (d: ClassData): PackRecord => ({
  shapePixels: d.shapePixels, jointBasis: d.jointBasis, faceIndexPixels: d.faceIndexPixels, faceList: d.faceList,
  exprPixels: d.exprPixels, ...clipFields('walk', d.walk), ...clipFields('idle', d.idle),
  ...clipFields('run', d.run), ...clipFields('cower', d.cower), ...clipFields('sprint', d.sprint), ...clipFields('photo', d.photo), ...clipFields('getUp', d.getUp), ...clipFields('duck', d.duck), ...clipFields('hurtWalk', d.hurtWalk),
  ...clipFields('hurtRun', d.hurtRun), ...clipFields('nervous', d.nervous), ...clipFields('hit', d.hit),
  ...clipFields('staggerBack', d.staggerBack), ...clipFields('riseFront', d.riseFront), ...clipFields('riseBack', d.riseBack), ...clipFields('crawl', d.crawl),
});
export const classFromRecord = (r: Record<string, PackValue>): ClassData => ({
  shapePixels: r['shapePixels'] as Float32Array, jointBasis: r['jointBasis'] as Float32Array,
  faceIndexPixels: r['faceIndexPixels'] as Float32Array, faceList: r['faceList'] as Int32Array,
  exprPixels: r['exprPixels'] as Float32Array, walk: clipOf('walk', r), idle: clipOf('idle', r),
  run: clipOf('run', r), cower: clipOf('cower', r), sprint: clipOf('sprint', r), photo: clipOf('photo', r), getUp: clipOf('getUp', r), duck: clipOf('duck', r), hurtWalk: clipOf('hurtWalk', r),
  hurtRun: clipOf('hurtRun', r), nervous: clipOf('nervous', r), hit: clipOf('hit', r),
  staggerBack: clipOf('staggerBack', r), riseFront: clipOf('riseFront', r), riseBack: clipOf('riseBack', r), crawl: clipOf('crawl', r),
});

/** A class's rig: its body at the band's age, with only the eyes on it (no outfit, hair, brows, lashes or hat). */
export async function classRig(env: BakeEnv, sex: WalkSex, band: AgeBand): Promise<{ base: MacroParams; shape: Float32Array; eyes: ProxyItem; rig: PersonRig }> {
  const { assets: a, morpher: mo } = await env.setup();
  const base = classBase(sex, band);
  const shape = mo.shape(base);
  const eyes = await env.eyes();
  await breathe();
  const { outfit: _o, footwear: _f, brows: _b, lashes: _l, ...bare } = DEFAULT_LOOK;
  const look: PersonLook = { ...bare, hairCut: 'none', hat: 'none', extras: [] };
  const rig = createPersonRig({
    nude: true, texturedSkin: true, data: a.mesh, skeleton: a.skeleton, bodyRange: a.bodyRange, positions: shape, look,
    capture: captureBind(sex), captureAxes: captureBindRotations(sex), proxies: new Map([['eyes', eyes]]),
  });
  await breathe();
  return { base, shape, eyes, rig };
}

/**
 * A class's data on its rig: the shape basis, the clips, the joint basis,
 * the face slots and the expressions. Some 250 ms of work, done a few
 * milliseconds a frame (`breathe`) when it has to be done in play - only
 * when the cook is missing or stale.
 */
export async function classData(env: BakeEnv, sex: WalkSex, rig: PersonRig, shape: Float32Array): Promise<ClassData> {
  const { assets: a } = await env.setup();
  const components = env.components;
  const vertexCount = a.mesh.vertexCount;
  // The shape basis on this body: each component as moves of every base
  // vertex in the bind posture, per unit of its coefficient (a small step,
  // so the feet-to-ground shift stays linear).
  const shapeRows = Math.ceil(vertexCount * SHAPES / SHAPE_WIDTH);
  const shapePixels = new Float32Array(SHAPE_WIDTH * shapeRows * 4);
  const stepped = new Float32Array(shape.length);
  for (let k = 0; k < SHAPES; k++) {
    const comp = components[k]!;
    let biggest = 0;
    for (let j = 0; j < comp.length; j++) biggest = Math.max(biggest, Math.abs(comp[j]!));
    const eps = biggest > 0 ? 0.3 / biggest : 1;
    for (let j = 0; j < shape.length; j++) stepped[j] = shape[j]! + eps * comp[j]!;
    const moved = rig.deltas!(stepped);
    for (let v = 0; v < vertexCount; v++) {
      const t = (v * SHAPES + k) * 4;
      shapePixels[t] = moved[v * 3]! / eps;
      shapePixels[t + 1] = moved[v * 3 + 1]! / eps;
      shapePixels[t + 2] = moved[v * 3 + 2]! / eps;
    }
    await breathe();
  }
  const library = await loadRocketboxClips(sex);
  await breathe();
  const bakeRig = restRig(rig.scene);
  const walk = await bakeWalk(bakeRig, sex);
  await breathe();
  const idle = await bakeLibraryClip(bakeRig, library.idle, undefined, 'idle');
  await breathe();
  const run = await bakeLibraryClip(bakeRig, library.run, undefined, 'run');
  await breathe();
  const cower = await bakeLibraryClip(bakeRig, library.crouchIdle, undefined, 'crouchIdle');
  await breathe();
  const sprint = await bakeLibraryClip(bakeRig, library.runFast, undefined, 'runFast');
  await breathe();
  const photo = await bakeLibraryClip(bakeRig, library.photo, undefined, 'photo');
  await breathe();
  const getUp = await bakeLibraryClip(bakeRig, library.crouchUp, undefined, 'crouchUp');
  await breathe();
  const duck = await bakeLibraryClip(bakeRig, library.crouchDown, undefined, 'crouchDown');
  await breathe();
  const hurtWalk = await bakeLibraryClip(bakeRig, library.walkInjured, undefined, 'walkInjured');
  await breathe();
  const hurtRun = await bakeLibraryClip(bakeRig, library.runInjured, undefined, 'runInjured');
  await breathe();
  const nervous = await bakeLibraryClip(bakeRig, library.nervous, undefined, 'nervous');
  await breathe();
  const hit = await bakeLibraryClip(bakeRig, library.hitChest, undefined, 'hitChest');
  await breathe();
  const staggerBack = await bakeLibraryClip(bakeRig, library.staggerBack, undefined, 'staggerBack');
  await breathe();
  const riseFront = await bakeLibraryClip(bakeRig, library.getUpFront, undefined, 'getUpFront');
  await breathe();
  const riseBack = await bakeLibraryClip(bakeRig, library.getUpBack, undefined, 'getUpBack');
  await breathe();
  const crawl = await bakeLibraryClip(bakeRig, library.crawl, undefined, 'crawl');
  await breathe();
  // Joints follow the shape: a MakeHuman bone's head is the mean of a
  // group of base vertices (its joint cube, `personRig.headOf`), so its
  // move per coefficient is the mean of theirs in the shape basis.
  const bones = rig.mesh.skeleton.bones.length;
  const jointBasis = new Float32Array(bones * SHAPES * 3);
  a.skeleton.bones.forEach((bone, i) => {
    const verts: number[] = [];
    if (bone.head.strategy === 'CUBE' && bone.head.cubeName) {
      for (const [x0, x1] of a.mesh.vertexGroups[bone.head.cubeName] ?? []) for (let v = x0; v <= x1; v++) verts.push(v);
    } else verts.push(...(bone.head.vertexIndices ?? []));
    if (!verts.length || i >= bones) return;
    for (let k = 0; k < SHAPES; k++) for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (const v of verts) sum += shapePixels[(v * SHAPES + k) * 4 + c]!;
      jointBasis[(i * SHAPES + k) * 3 + c] = sum / verts.length;
    }
  });
  // The head's vertices (helpers too: the eyes, brows and lashes are pinned
  // to them), each a slot in a person's face row.
  const headBone = a.mesh.boneNames.indexOf('head');
  const faceList: number[] = [];
  const faceIndexPixels = new Float32Array(FACE_INDEX_WIDTH * Math.ceil(vertexCount / FACE_INDEX_WIDTH)).fill(-1);
  for (let v = 0; v < vertexCount; v++) {
    let w = 0;
    for (let k = 0; k < 4; k++) if (a.mesh.joints[v * 4 + k] === headBone) w += a.mesh.weights[v * 4 + k]! / 65535;
    if (w > 0.25) { faceIndexPixels[v] = faceList.length; faceList.push(v); }
  }
  const faceRows = Math.ceil(faceList.length / FACE_WIDTH);
  // Each expression channel on this body, as moves of the head's vertices
  // in the bind posture: the channel's ARKit shapes on the class body,
  // posed (`PersonRig.deltas`).
  const expressions = await expressionShapes();
  await breathe();
  const channels = channelShapes(expressions);
  await breathe();
  const exprPixels = new Float32Array(FACE_WIDTH * 4 * faceRows * EXPR_SLOTS);
  const posedBase = rig.deltas!(shape);
  const withChannel = new Float32Array(shape.length);
  for (const [c, name] of EXPR.entries()) {
    await breathe();
    const unit = channels[name];
    if (!unit) continue;
    for (let j = 0; j < shape.length; j++) withChannel[j] = shape[j]! + unit[j]!;
    const moved = rig.deltas!(withChannel);
    faceList.forEach((v, i) => {
      const o = (c * faceRows * FACE_WIDTH + i) * 4;
      exprPixels[o] = moved[v * 3]! - posedBase[v * 3]!;
      exprPixels[o + 1] = moved[v * 3 + 1]! - posedBase[v * 3 + 1]!;
      exprPixels[o + 2] = moved[v * 3 + 2]! - posedBase[v * 3 + 2]!;
    });
  }
  await breathe();
  return { shapePixels, jointBasis, faceIndexPixels, faceList: Int32Array.from(faceList), exprPixels, walk, idle, run, cower, sprint, photo, getUp, duck, hurtWalk, hurtRun, nervous, hit, staggerBack, riseFront, riseBack, crawl };
}

/** Every class and hairstyle, packed for the cook (`proceduralCook.ts`, `scripts/cook-people.mjs`). */
export async function cookAll(env: BakeEnv): Promise<Map<string, ArrayBuffer>> {
  const out = new Map<string, ArrayBuffer>();
  for (const sex of ['female', 'male'] as const) {
    for (const band of ['child', 'young', 'adult', 'senior'] as const) {
      const { shape, rig } = await classRig(env, sex, band);
      out.set(`class-${sex}-${band}`, packRecord(classRecord(await classData(env, sex, rig, shape))));
    }
  }
  // The cards of every hairstyle. Not the strands drawn over them close
  // up (`strandPiece`): those are for the few people nearest the camera.
  const { assets: a, morpher: mo } = await env.setup();
  for (const style of Object.values(HAIR_STYLES)) {
    out.set(`hair-${style.name}`, packRecord(packRecordOf(generateHair(style, hairBase(a, mo)))));
    await breathe();
  }
  out.set('acc-headband', packRecord(packRecordOf(generateHeadband(hairBase(a, mo)))));
  return out;
}

// The cook (`scripts/cook-people.mjs`, run by hand): every class and hairstyle
// built here once, packed and sent to the development server, which writes
// them to `cooked/procedural/` (`proceduralCook.ts` reads them back).
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __cookProcedural?: () => Promise<{ hash: string | null; names: string[]; bytes: number }> }).__cookProcedural = async () => {
    const files = await cookAll(createBakeEnv());
    let bytes = 0;
    for (const [name, data] of files) {
      const response = await fetch(`/__cook/procedural/${name}.bin`, { method: 'PUT', body: data });
      if (!response.ok) throw new Error(`Cook of ${name}: ${response.status}`);
      bytes += data.byteLength;
    }
    return { hash: proceduralCookHash(), names: [...files.keys()], bytes };
  };
}

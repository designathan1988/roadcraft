import { CAPTURE_NAME, type PersonRig } from './personRig';
import type { BodyPart, Severable } from '@sim/people/view';
import {
  BufferAttribute, BufferGeometry, Color, DataTexture, DoubleSide, DynamicDrawUsage, FloatType, Group,
  InstancedBufferAttribute, InstancedMesh, Matrix4, MeshDepthMaterial, Quaternion, MeshStandardMaterial, Vector3, NearestFilter,
  RedFormat, RGBADepthPacking, RGBAFormat, SRGBColorSpace, ShaderChunk, ShaderLib, UnsignedByteType,
  type Material, type Texture, type WebGLRenderer,
} from 'three';
import { bodyHeight } from '@people/body/morph';
import { yearsFromAge, type MacroParams } from '@people/body/macro';
import { loadProxyItem, type ProxyItem } from '@people/body/proxy';
import { wornItems, type PersonLook, type PersonSpec } from '@people/spec';
import { FEMALE_HAIR, HAIR_STYLES, MALE_HAIR, generateHairStrands, generateHeadband } from '@people/hair/procedural';
import { hairStrandTexture } from './hairTexture';
import { compileAhead, shadowStandIn } from '../uploads';
import { PERSON_SHADOW_VARIANTS, PERSON_VARIANTS, castsAt, personDepthKey, personProgramKey, type Kind, type Variant } from './personVariants';
import { forgetOtherDerived, readDerived, writeDerived } from '../derivedCache';
import { pullTowardEye } from '../depthConvention';
import { loadProcedural } from './proceduralCook';
import { faceAt } from './faceExpression';
import { itemTexture, personLighting, skinChoice, skinTextures } from './skinAppearance';
import type { WalkSex } from '../citizenWalk';
import { breathe, type ClipFrames } from '../citizenBake';
import { PACKED_BONE_FLOATS, SKIN_BONE_FLOATS, blendPackedFrames } from '../citizenPalette';
import {
  EXPR, EXPR_SLOTS, FACE_WIDTH, SHAPES, classData, classFromRecord, classRig, cookAll, createBakeEnv,
  hairBase, hairCards, packFromRecord, type AgeBand,
} from './proceduralBake';
import { buildClassAnimation, createPalettePass, type ClassAnimation, type PalettePass, MOST_ROW_RANGES } from './crowdAnimation';
import { BODY_WIDTH, createClassBodies, type ClassBodies } from './crowdBodies';
import { createGpuRows, type GpuRows } from './gpuRows';
import { classRigInWorker, personFaceInWorker, wearInWorker } from '../bakePool';
import { HAIR_STRAND_PEOPLE } from '../quality';
import type { WornPiece } from './personRig';
import { rigFromMade, sharedCopy } from './classRigMade';
import type { PersonFaceJob } from '../citizenBake.worker';
import {
  EYE_TRIANGLES, FAR_TRIANGLES, FAR_ZONES, FarZone, LEVELS, LEVEL_CAPS, LEVEL_TRIANGLES, REGION, boneZone, cardCentres, cardSelections, farMesh,
  filterTriangles, headZone, itemShownAt, levelFor, lodReady, simplifiedIndexAway, sortSkinWeights, type HeadFrame, type PieceRole,
} from './crowdLod';
import { createBlobShadows } from '../blobShadows';
import { lodPool } from './lodPool';
import { providePeopleLod } from './lodPort';
import { measureHitch } from '@core/hitch';

// The class bodies built on this page simplify their levels in the page's pool (`lodPort.ts`).
providePeopleLod(lodPool);

/** Procedural people (`people-lab.html`, then the game): one MakeHuman body per class - sex and age band */

/** Wounds kept a person (`procPerson`): bullet holes and where blood soaks out of them. */
const WOUND_SLOTS = 8;
/** A person's matrix as drawn this frame (with their height), read by every piece they are in: DO NOT write it into each piece. */
const PLACE_FLOATS = 16;
/** A person's row of `procPerson`: their wounds (`WOUND_SLOTS` texels), their expression weights (`EXPR_SLOTS` / 4 texels), their place (4
 *  texels), then their far colours (`FAR_ZONES` texels: a zone's colour, and 0 cloth, 1 skin, 2 hair). */
const PERSON_FLOATS = (WOUND_SLOTS + EXPR_SLOTS / 4) * 4 + PLACE_FLOATS + FAR_ZONES * 4;
/** Where a person's expression weights start in their row, floats. */
const EXPR_AT = WOUND_SLOTS * 4;
/** Where their place starts, floats. */
const PLACE_AT = (WOUND_SLOTS + EXPR_SLOTS / 4) * 4;
/** Where their far colours start (`FarZone`), floats. */
const ZONE_AT = PLACE_AT + PLACE_FLOATS;

const WOUND_BONES: Readonly<Record<BodyPart, readonly string[]>> = {
  head: ['Bip01_Head'], torso: ['Bip01_Spine', 'Bip01_Spine1', 'Bip01_Spine2', 'Bip01_Pelvis'],
  armL: ['Bip01_L_UpperArm', 'Bip01_L_Forearm'], armR: ['Bip01_R_UpperArm', 'Bip01_R_Forearm'],
  legL: ['Bip01_L_Thigh', 'Bip01_L_Calf'], legR: ['Bip01_R_Thigh', 'Bip01_R_Calf'],
};
const spotsOf = new WeakMap<object, Record<BodyPart, number[]>>();
/** The rest mesh's vertices of each part a bullet can strike (their strongest bone on that part). */
function woundSpotsOf(mesh: { geometry: BufferGeometry; skeleton: { bones: { name: string }[] } },
  groups: Readonly<Record<string, readonly (readonly [number, number])[]>> | null): Record<BodyPart, number[]> {
  let known = spotsOf.get(mesh);
  if (known) return known;
  const names = mesh.skeleton.bones.map((b) => CAPTURE_NAME[b.name] ?? b.name);
  const partOf = names.map((n) => (Object.keys(WOUND_BONES) as BodyPart[]).find((part) => WOUND_BONES[part].includes(n)) ?? null);
  known = { head: [], torso: [], armL: [], armR: [], legL: [], legR: [] };
  // Not the hidden helpers (joint cubes inside the body, the tights and skirt shells): a wound is on the skin.
  const hidden = new Set<number>();
  for (const [name, ranges] of Object.entries(groups ?? {})) {
    if (!name.startsWith('joint-') && !name.startsWith('helper-')) continue;
    for (const [a, b] of ranges) for (let v = a; v <= b; v++) hidden.add(v);
  }
  const index = mesh.geometry.getAttribute('skinIndex'), weight = mesh.geometry.getAttribute('skinWeight');
  if (index && weight) {
    for (let v = 0; v < index.count; v += 3) {
      let best = 0, bone = -1;
      for (let c = 0; c < 4; c++) { const wgt = weight.getComponent(v, c); if (wgt > best) { best = wgt; bone = index.getComponent(v, c); } }
      const part = bone >= 0 ? partOf[bone] : null;
      if (part && best > 0.6 && !hidden.has(v)) known[part].push(v);
    }
  }
  spotsOf.set(mesh, known);
  return known;
}

/** A body's units a metre, from its rest mesh's height and the body's height in metres. */
function woundUnit(geometry: BufferGeometry, metres: number): number {
  geometry.computeBoundingBox();
  const b = geometry.boundingBox!;
  return (b.max.y - b.min.y) / Math.max(0.5, metres);
}
const COVER_WIDTH = 4096;
/** How far skin under a garment sinks, metres. */
const SINK = 0.025;

function bandOf(years: number): AgeBand {
  return years < 14 ? 'child' : years < 32 ? 'young' : years < 58 ? 'adult' : 'senior';
}

/** A garment that hides the skin under it (as `dressedGeometry` decides). */
const COVERING = new Set(['clothes', 'shoes', 'top', 'bottom', 'skirt', 'dress', 'suit', 'gloves']);

/** The attributes a piece has an entry of per person drawn. */
const INSTANCED = new Set(['aPerson', 'aDye', 'aWorn', 'aSkin', 'aOut', 'aShoe']);

/** One level of an item on a class, or the far mesh of a class and outfit */
interface Piece {
  readonly item: Item | null;
  readonly level: number;
  readonly mesh: InstancedMesh;
  readonly attrs: Map<string, InstancedBufferAttribute>;
  capacity: number;
  people: ProceduralPerson[];
  /** Entries written since the last upload. */
  dirty: boolean;
  /** Triangles drawn per person. */
  readonly triangles: number;
  readonly ready: Promise<void>;
}

/** An item (or a skin) fitted to a class: one set of vertices, and a piece a level it is drawn at. */
interface Item {
  readonly name: string;
  readonly kind: Kind;
  readonly role: PieceRole;
  readonly source: BufferGeometry;
  readonly levels: (Piece | null)[];
  readonly vertices: number;
  /** Settles once every level's shaders are built and its meshes are in the scene. */
  ready: Promise<void>;
  /** Its texture's mean colour at its own vertices, linear: its colour on a far body (`zoneColours`). */
  readonly colour: Color;
  /** Its widest side over its wearer's height: the levels it is too small to draw at left out (`itemShownAt`). */
  readonly share: number;
  readonly map: Texture | null;
}

interface BodyClass {
  readonly key: string;
  readonly sex: WalkSex;
  readonly band: AgeBand;
  readonly base: MacroParams;
  readonly shape: Float32Array;
  readonly coefficients: Float64Array;
  readonly rig: PersonRig;
  /** An item fitted to the class's body (`PersonRig.wear`): on the people's worker, where the rig is kept. */
  readonly fit: (item: ProxyItem) => Promise<WornPiece>;
  readonly height: number;
  readonly clips: Record<ProcClip, ClipFrames>;
  readonly bones: number;
  /** Bones parents first, and each one's parent (-1 for the root). */
  readonly order: readonly number[];
  readonly parent: Int16Array;
  /** Each bone's head per unit of each shape coefficient, metres: [bone][k][xyz]. */
  readonly jointBasis: Float32Array;
  /** The shape basis, kept for `probe`. */
  readonly shapePixels: Float32Array;
  readonly bodies: ClassBodies;
  readonly anim: ClassAnimation;
  readonly pass: PalettePass;
  readonly uniforms: {
    procBones: { value: Texture };
    /** The class's first row in the palettes' shared target (`paletteTargets.ts`). */
    procBase: { value: number };
    procBodies: { value: Texture };
    procBodyStride: { value: number };
    procCover: { value: DataTexture };
    procCoverRows: { value: number };
    /** The face index (four vertices a texel), the expressions' shapes from `procExprHead`, each person's face from `procFaceHead`. */
    procFace: { value: Texture };
    procFaceRows: { value: number };
    procFaceHead: { value: number };
    procExprHead: { value: number };
    /** Each person's row (`PERSON_FLOATS`): wounds - where on the body at rest, and since when (-1: none) - then expression weights, then their place. */
    procPerson: { value: DataTexture };
    /** The clock the wounds spread by (seconds), and the body's units a metre. */
    procTime: { value: number };
    procWoundUnit: { value: number };
  };
  /** `procPerson`'s pixels: each person's wounds and expression weights now. */
  personData: Float32Array;
  /** The rows whose place was written this frame. */
  readonly placed: number[];
  /** Palette rows worked out here: those held, bent, jolted or maimed, and the ragdolls' questions. */
  palette: Float32Array;
  /** `procFace` on the GPU only: the head (index, expressions), then each person's own face (their regional sliders) as moves of the head's vertices, `faceRows` rows each. */
  readonly faces: GpuRows;
  /** The sliders each row's face was made from (null: none), to make it again on a restore. */
  readonly faceOf: (Readonly<Record<string, number>> | null)[];
  /** The head's rows read again from the cook (or baked again), for a restore. */
  readonly reloadHead: () => Promise<Float32Array>;
  readonly faceVerts: Int32Array;
  rows: number;
  capacity: number;
  readonly cover: Map<string, number>;
  readonly body: BufferGeometry;
  readonly skins: Map<string, Item>;
  readonly items: Map<string, Item>;
  /** The far mesh (level 3): the class's body, every far person of the class in it, each in their colours a zone (null while it is made). */
  far: Piece | null;
  /** Each body vertex's zone (`FarZone`), its area a zone, and the head's frame the hair is told by: what a garment covers (`zoneCover`). */
  readonly zones: Uint8Array;
  readonly zoneArea: Float32Array;
  readonly head: HeadFrame;
  /** Each item's share of a zone: covered (`deleteVerts`), or its own area over the body's there; made once a class and item. */
  readonly zoneCover: Map<string, Float32Array>;
  /** Every piece of the class, for the frame's matrices. */
  readonly pieces: Piece[];
  readonly people: ProceduralPerson[];
  /** Each bone's zone (`boneZone`), for an item's vertices. */
  readonly boneZones: Uint8Array;
  /** The body's height at rest, its own units: an item's size is held against it (`Item.share`). */
  readonly bodyHeight: number;
  /** People drawn this frame. */
  drawn: number;
}

/** What a procedural person plays: walking, standing, running, sprinting for their life, cowering, photographing. */
export type ProcClip = 'walk' | 'idle' | 'run' | 'sprint' | 'cower' | 'photo' | 'getUp' | 'duck' | 'hurtWalk' | 'hurtRun' | 'nervous' | 'hit' | 'staggerBack' | 'riseFront' | 'riseBack' | 'crawl';

export interface ProceduralPerson {
  readonly spec: PersonSpec;
  readonly band: AgeBand;
  readonly sex: WalkSex;
  /** Their row in the class's palette, face and wound textures. */
  readonly row: number;
  /** Standing height over the class body's, the instance's scale. */
  readonly scale: number;
  /** Metres. */
  readonly height: number;
  readonly items: readonly string[];
  /** Their grown hairstyle's item (`hair:...`) and colour, for its strands close up. */
  readonly grown: string | null;
  readonly hairColour: Color;
  /** How far each of their joints is from the class body's, metres (their baked body's, `crowdBodies.ts`). */
  readonly joints: Float32Array;
  /** Where they stand and face; what they play. Set by the caller each frame (a zero scale hides them). */
  readonly matrix: Matrix4;
  clip: ProcClip;
  phase: number;
  /** The clip they are leaving, still playing under the new one at `weight` */
  fade?: { clip: ProcClip; phase: number; weight: number } | undefined;
  /** What they are doing, as the face shows it (`faceAt`): 'talk', 'panic'... */
  activity?: string | undefined;
  /** Limbs (or the head) lost to shots: their bones closed at the joint they were torn from. Set by the caller. */
  lost?: readonly Severable[] | undefined;
  /** How tall they stand on the screen, pixels: their level of detail. Set by the caller each frame; unset, they are drawn in full. */
  pixels?: number | undefined;
}

interface ProceduralStats {
  readonly classes: number;
  readonly people: number;
  readonly pieces: number;
  readonly draws: number;
  readonly items: number;
  readonly vertices: number;
  readonly textureBytes: number;
  readonly bakeMs: number;
  /** People drawn at each level this frame (0 the closest). */
  readonly levels: readonly number[];
  /** Triangles drawn this frame, the shadow's not counted. */
  readonly triangles: number;
}

const ROW_START = 64;
/** A piece's room for people at first; doubled when full. */
const PIECE_START = 16;
/** A far person's shadow disc, metres across their middle. */
const BLOB_RADIUS = 0.34;

/** Colours a generated accessory (a headband) is dyed. */
const ACCESSORY_COLOURS = [0xc0392b, 0x1f3a93, 0xf2f0ea, 0x111111, 0xd35400, 0x8e44ad, 0x16a085] as const;

let plain: DataTexture | null = null;
/** A white texel, for a piece with no texture of its own. */
function plainTexture(): DataTexture {
  if (!plain) {
    plain = new DataTexture(new Uint8Array([160, 160, 160, 255]), 1, 1, RGBAFormat, UnsignedByteType);
    plain.needsUpdate = true;
  }
  return plain;
}

/** What a person wears here: their own look, or - for a child, whom the generator dresses in the old tailored shells */
function proceduralLook(spec: PersonSpec, hair = true): PersonLook {
  const look = spec.look;
  const female = spec.body.gender < 0.5;
  const h = Math.abs(spec.id * 2654435761) >>> 0;
  const dressed: PersonLook = look.outfit ? look : {
    ...look,
    outfit: (female ? ['female_casualsuit01', 'female_casualsuit02']
      : ['male_casualsuit01', 'male_casualsuit02', 'male_casualsuit03', 'male_casualsuit04', 'male_casualsuit05', 'male_casualsuit06'])[h % (female ? 2 : 6)]!,
    footwear: ['shoes01', 'shoes02', 'shoes05'][(h >>> 8) % 3]!,
    outfitTint: look.topColour,
  };
  // Half the people in a grown style, half in a stock one that passed the audit (`randomPerson`'s curated lists).
  const mouth = (l: PersonLook): PersonLook => ({ ...l, extras: [...(l.extras ?? []), 'acc:teeth', 'acc:tongue'] });
  if (!hair || ((h >>> 20) & 1) === 0) return mouth(dressed);
  // Children keep the stock styles (the player: the grown ones on a child "nobody even wears that").
  if (yearsFromAge(spec.body.age) < 14) return mouth(dressed);
  // Hair grown procedurally (`people/hair/procedural.ts`): older women shorter or up, girls never in a bun, older men short.
  const years = yearsFromAge(spec.body.age);
  const styles: readonly string[] = female
    ? years > 60 ? ['bob', 'midLayered', 'bun', 'bobFringe', 'shoulderBob']
      : years < 14 ? ['longStraight', 'ponytail', 'ponytailFringe', 'bobFringe', 'braid', 'twinBraids', 'pigtails', 'longHeadband'] : FEMALE_HAIR
    : years > 55 ? ['shortCrop', 'shortSide', 'slickedBack'] : MALE_HAIR;
  const style = styles[(h >>> 12) % styles.length]!;
  return mouth({
    ...dressed,
    hairCut: `hair:${style}`,
    ...(HAIR_STYLES[style]?.headband ? { extras: [...(dressed.extras ?? []), 'acc:headband'] } : {}),
  });
}

/** What a person's programs read of their class (`uniformsInto`): its textures and its bind matrices. */
type ClassShading = Pick<BodyClass, 'uniforms'> & {
  readonly rig: { readonly mesh: { readonly bindMatrix: Matrix4; readonly bindMatrixInverse: Matrix4 } };
};

/** The vertex half every program shares: the person's row of the palette pass (`procBones`), their baked body */
function vertexPars(v: Variant): string {
  const face = v.kind !== 'far' && v.level <= 1;
  const expr = v.kind !== 'far' && v.level === 0;
  return `
uniform sampler2D procBones;
uniform float procBase;
uniform sampler2D procBodies;
uniform float procBodyStride;
uniform mat4 bindMatrix;
uniform mat4 bindMatrixInverse;
uniform sampler2D procPerson;
attribute vec4 aPerson;
attribute vec3 aRefs;
attribute vec3 aRefW;
// The person's matrix, read once at the top of main (placeChunk): the instance's own is never written.
mat4 procPlace;
mat4 getBoneMatrix(const in float i) {
  int x = int(i) * 4;
  int y = int(aPerson.x) + int(procBase);
  return mat4(texelFetch(procBones, ivec2(x, y), 0), texelFetch(procBones, ivec2(x + 1, y), 0),
    texelFetch(procBones, ivec2(x + 2, y), 0), texelFetch(procBones, ivec2(x + 3, y), 0));
}
${face ? `
uniform sampler2D procFace;
uniform float procFaceRows;
uniform float procFaceHead;
uniform float procExprHead;

vec3 procFaceDelta(int v) {
  // The face index: four vertices a texel at the head of procFace
  int q = v / 4;
  vec4 four = texelFetch(procFace, ivec2(q % ${FACE_WIDTH}, q / ${FACE_WIDTH}), 0);
  int k = v - q * 4;
  float idx = k == 0 ? four.x : k == 1 ? four.y : k == 2 ? four.z : four.w;
  if (idx < 0.0) return vec3(0.0);
  int t = int(idx) + (int(procFaceHead) + int(aPerson.x) * int(procFaceRows)) * ${FACE_WIDTH};
  vec3 d = texelFetch(procFace, ivec2(t % ${FACE_WIDTH}, t / ${FACE_WIDTH}), 0).xyz;
  ${expr ? `// The expression of the moment: each channel's shape at its weight.
  for (int c = 0; c < ${EXPR_SLOTS}; c += 4) {
    vec4 w = texelFetch(procPerson, ivec2(${WOUND_SLOTS} + c / 4, int(aPerson.x)), 0);
    for (int j = 0; j < 4; j++) {
      if (w[j] == 0.0) continue;
      int e = (int(procExprHead) + (c + j) * int(procFaceRows)) * ${FACE_WIDTH} + int(idx);
      d += w[j] * texelFetch(procFace, ivec2(e % ${FACE_WIDTH}, e / ${FACE_WIDTH}), 0).xyz;
    }
  }` : ''}
  return d;
}` : ''}
vec3 procDelta(int v) {
  int t = int(aPerson.y) * int(procBodyStride) + v;
  vec3 d = texelFetch(procBodies, ivec2(t % ${BODY_WIDTH}, t / ${BODY_WIDTH}), 0).xyz;
  ${face ? 'd += procFaceDelta(v);' : ''}
  return d;
}
vec3 procShapeDelta() {
  vec3 d = aRefW.x * procDelta(int(aRefs.x));
  if (aRefW.y != 0.0) d += aRefW.y * procDelta(int(aRefs.y));
  if (aRefW.z != 0.0) d += aRefW.z * procDelta(int(aRefs.z));
  return d;
}
${v.widen ? 'attribute vec3 aCard;\nuniform float procWiden;' : ''}`;
}

const COVER_CHUNK = `
uniform sampler2D procCover;
uniform float procCoverRows;
attribute vec4 aWorn;
float procCovered(float item) {
  if (item < -0.5) return 0.0;
  int v = int(aRefs.x);
  return texelFetch(procCover, ivec2(v % ${COVER_WIDTH}, int(item) * int(procCoverRows) + v / ${COVER_WIDTH}), 0).r;
}`;

/** The far levels skin with each vertex's two strongest bones */
const TWO_BONES_BASE = `
mat4 boneMatX = getBoneMatrix( skinIndex.x );
mat4 boneMatY = getBoneMatrix( skinIndex.y );
vec2 procW = skinWeight.xy / max( 1e-4, skinWeight.x + skinWeight.y );`;
const TWO_BONES_NORMAL = `
mat4 skinMatrix = bindMatrixInverse * ( procW.x * boneMatX + procW.y * boneMatY ) * bindMatrix;
objectNormal = vec4( skinMatrix * vec4( objectNormal, 0.0 ) ).xyz;`;
const TWO_BONES_POSITION = `
vec4 skinVertex = bindMatrix * vec4( transformed, 1.0 );
transformed = ( bindMatrixInverse * ( boneMatX * skinVertex * procW.x + boneMatY * skinVertex * procW.y ) ).xyz;`;

/** three's chunk with the person's row (`procPlace`) for the instance's matrix. */
const placeChunk = (name: 'project_vertex' | 'defaultnormal_vertex' | 'worldpos_vertex'): string =>
  ShaderChunk[name].replaceAll('instanceMatrix', 'procPlace');

/** The vertex half of a program: the person's place, skeleton, shape and widening, the skin's cover. */
function patchVertex(shader: { vertexShader: string }, v: Variant): void {
  const cover = v.kind === 'skin' && v.level <= 2;
  let vs = shader.vertexShader.replace('#include <skinning_pars_vertex>', vertexPars(v) + (cover ? COVER_CHUNK : ''))
    .replace('void main() {', `void main() {
  procPlace = mat4(texelFetch(procPerson, ivec2(${PLACE_AT / 4}, int(aPerson.x)), 0), texelFetch(procPerson, ivec2(${PLACE_AT / 4 + 1}, int(aPerson.x)), 0),
    texelFetch(procPerson, ivec2(${PLACE_AT / 4 + 2}, int(aPerson.x)), 0), texelFetch(procPerson, ivec2(${PLACE_AT / 4 + 3}, int(aPerson.x)), 0));`);
  for (const name of ['project_vertex', 'defaultnormal_vertex', 'worldpos_vertex'] as const) vs = vs.replace(`#include <${name}>`, placeChunk(name));
  if (v.level >= 2) {
    vs = vs.replace('#include <skinbase_vertex>', TWO_BONES_BASE)
      .replace('#include <skinnormal_vertex>', TWO_BONES_NORMAL)
      .replace('#include <skinning_vertex>', TWO_BONES_POSITION);
  }
  shader.vertexShader = vs.replace('#include <begin_vertex>', `#include <begin_vertex>
${v.widen ? 'transformed = aCard + (transformed - aCard) * procWiden;' : ''}
transformed += procShapeDelta();
${cover ? 'transformed -= normalize(normal) * ' + SINK.toFixed(4) + ' * max(max(procCovered(aWorn.x), procCovered(aWorn.y)), max(procCovered(aWorn.z), procCovered(aWorn.w)));' : ''}
`);
}

function uniformsInto(shader: { uniforms: Record<string, unknown> }, cls: ClassShading, widen?: number): void {
  Object.assign(shader.uniforms, cls.uniforms, {
    bindMatrix: { value: cls.rig.mesh.bindMatrix },
    bindMatrixInverse: { value: cls.rig.mesh.bindMatrixInverse },
  });
  if (widen !== undefined) shader.uniforms['procWiden'] = { value: widen };
}

/** Wounds (as GTA's ped damage decals) */
const WOUND_BLOCK = `
  if (vProcWounded > 0.5) {
    float blood = 0.0, hole = 0.0;
    float u = procWoundUnit;
    float grain = fract(sin(dot(floor(vProcBind * (60.0 / u)), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    for (int i = 0; i < ${WOUND_SLOTS}; i++) {
      vec4 wd = texelFetch(procPerson, ivec2(i, int(vProcRow + 0.5)), 0);
      if (wd.w < 0.0) continue;
      float drench = wd.w > 1e8 ? 1.0 : 0.0;
      float age = max(0.0, procTime - (wd.w - drench * 2e8));
      float r = u * (0.035 + 0.12 * (1.0 - exp(-age / 10.0))) * (1.0 + drench * 7.0);
      vec3 d = vProcBind - wd.xyz;
      d.y = d.y < 0.0 ? d.y * 0.45 : d.y * 1.25;
      float dist = length(d) * (0.8 + 0.4 * grain);
      blood = max(blood, 1.0 - smoothstep(r * 0.5, r, dist));
      hole = max(hole, (1.0 - drench) * (1.0 - smoothstep(u * 0.007, u * 0.015, length(vProcBind - wd.xyz))));
    }
    // Blood soaked into cloth is near black-red, a little of the cloth's own shade through it.
    texel.rgb = mix(texel.rgb, vec3(0.16, 0.006, 0.01) * (0.8 + 0.4 * texel.rgb), blood * 0.95);
    texel.rgb = mix(texel.rgb, vec3(0.04, 0.0, 0.0), hole);
  }`;

/** `grown`: a procedural hair item, its texture a strand atlas */
function pieceMaterial(cls: ClassShading, v: Variant, map: Texture | null, eyes: Texture | null, widen: number): Material {
  const { level, grown, lash } = v;
  const kind = v.kind as Kind;
  const material = new MeshStandardMaterial({ roughness: kind === 'skin' ? 0.5 : grown ? 0.6 : 0.85, metalness: 0, side: DoubleSide });
  material.defines = { USE_SKINNING: '' };
  if (grown) { material.alphaTest = 0.02; material.alphaToCoverage = true; }
  // Brows and lashes: a soft edge (alpha to coverage over a low cut) - at 0.35 their hairs merged into one hard black band.
  else if (kind === 'face') {
    material.alphaTest = 0.08; material.alphaToCoverage = true;
    pullTowardEye(material, 2, 8);
  }
  else if (kind === 'hair') { material.alphaTest = 0.35; material.alphaToCoverage = true; }
  if (kind === 'skin') material.alphaTest = 0.5;
  material.onBeforeCompile = (shader) => {
    uniformsInto(shader, cls, v.widen ? widen : undefined);
    shader.uniforms['procMap'] = { value: map };
    shader.uniforms['procEyes'] = { value: eyes };
    patchVertex(shader, v);
    shader.vertexShader = `attribute vec4 aDye; ${kind === 'skin' ? 'attribute float eyeMask;' : ''} ${grown ? 'attribute float aFade;' : ''}
varying vec4 vProcDye; varying vec2 vProcUv; varying float vSkinMask; varying float vFade;
varying vec3 vProcBind; varying float vProcRow; varying float vProcWounded;
${shader.vertexShader}`
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vProcDye = aDye; vProcUv = uv; vFade = ${grown ? 'aFade' : '1.0'}; vSkinMask = ${kind === 'skin' ? '1.0 - eyeMask' : '0.0'};
vProcBind = position; vProcRow = aPerson.x; vProcWounded = aPerson.z;`);
    const hair = kind === 'hair' ? '1.0' : '0.0';
    const cloth = kind === 'cloth' ? '1.0' : '0.0';
    shader.fragmentShader = `#define appearanceDetail 1.0
#define vHairMask ${hair}
#define vGarmentSlot ${cloth}
uniform sampler2D procMap; uniform sampler2D procEyes;
uniform sampler2D procPerson; uniform float procTime; uniform float procWoundUnit;
varying vec4 vProcDye; varying vec2 vProcUv; varying float vSkinMask; varying float vFade;
varying vec3 vProcBind; varying float vProcRow; varying float vProcWounded;
vec3 personStrand = vec3(0.0, 1.0, 0.0); float personSparkle = 0.5;
${shader.fragmentShader}`
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec4 texel = texture2D(procMap, vProcUv);
  ${grown ? `
  // Thinning towards a card's long edges
  float across = fract(vProcUv.x * 4.0);
  float sides = smoothstep(0.0, 0.22, min(across, 1.0 - across));
  float coverage = clamp(texel.r * 2.5 * vFade * mix(0.35, 1.0, sides), 0.0, 1.0);
  vec3 tone = vProcDye.rgb * mix(0.72, 1.0, smoothstep(0.0, 0.3, texel.g));
  tone *= 1.0 + (texel.b - 0.5) * 0.72;
  float facing = abs(dot(normalize(vNormal), normalize(vViewPosition)));
  tone *= mix(0.6, 1.0, smoothstep(0.05, 0.55, facing));
  texel = vec4(tone, coverage);` : kind === 'skin' ? `
  if (vSkinMask < 0.5) {
    texel = texture2D(procEyes, vProcUv);
    // Iris less garish (the packs' are oversaturated: cat's eyes), sclera off-white, never paper white.
    float l = dot(texel.rgb, vec3(0.2126, 0.7152, 0.0722));
    texel.rgb = mix(vec3(l), texel.rgb, 0.62) * vec3(0.93, 0.9, 0.88);
  }
  else texel = vec4(texel.rgb * vProcDye.rgb, 1.0);` : `
  if (vProcDye.a > 0.5) {
    float l = dot(texel.rgb, vec3(0.2126, 0.7152, 0.0722));
    texel.rgb = vProcDye.rgb * (0.45 + 1.1 * l);
  }
  ${kind === 'face' ? `
  // Brows and lashes a shade lighter than the hair, and thinned: at the
  // hair's own darkness, fully opaque, they read as painted black bars.
  ${lash ? `
  texel.rgb = vec3(0.05, 0.038, 0.03) + texel.rgb * 0.25;
  texel.a = smoothstep(0.15, 0.95, texel.a) * 0.78;` : `
  texel.rgb = texel.rgb * 1.35 + vec3(0.035, 0.028, 0.022);
  texel.a = smoothstep(0.22, 0.95, texel.a) * 0.8;`}` : ''}`}
  ${WOUND_BLOCK}
  // Burnt black (a bomb's direct hit, see char): soot over everything, a few embers still glowing in the cracks.
  if (vProcDye.a > 1.5) {
    float soot = fract(sin(dot(floor(vProcUv * vec2(90.0, 90.0)), vec2(12.9898, 78.233))) * 43758.5453);
    texel.rgb = mix(vec3(0.028, 0.022, 0.018), vec3(0.1, 0.07, 0.05), soot * soot) + vec3(0.35, 0.08, 0.0) * step(0.985, soot);
  }
  diffuseColor *= texel;
}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
${kind === 'skin' ? 'if (vSkinMask < 0.5) roughnessFactor = 0.08;' : ''}
${lash ? 'roughnessFactor = 1.0;' : ''}
${grown ? 'roughnessFactor = max(0.55, roughnessFactor + (texture2D(procMap, vProcUv).b - 0.5) * 0.16 + (1.0 - texture2D(procMap, vProcUv).g) * 0.06);' : ''}`)
      .replace('#include <lights_physical_pars_fragment>', personLighting(kind === 'hair', kind === 'cloth'))
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  vec3 dp1 = dFdx(-vViewPosition), dp2 = dFdy(-vViewPosition);
  vec2 du1 = dFdx(vProcUv), du2 = dFdy(vProcUv);
  vec3 along = dp2 * du1.x - dp1 * du2.x;
  personStrand = along - normal * dot(along, normal);
  personStrand = dot(personStrand, personStrand) > 1e-12 ? normalize(personStrand) : vec3(0.0, 1.0, 0.0);
  personSparkle = fract(sin(dot(floor(vProcUv * vec2(160.0, 12.0)), vec2(12.9898, 78.233))) * 43758.5453);
}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
reflectedLight.indirectSpecular *= personIndirect();
${kind === 'skin' && level <= 1 ? `
// The eye's wet cornea: a sharp catchlight of the key light and a soft one of the sky above
if (vSkinMask < 0.5) {
  vec3 R = reflect(-normalize(vViewPosition), normal);
  vec3 key = normalize((viewMatrix * vec4(-0.45, 0.8, 0.5, 0.0)).xyz);
  float glint = pow(max(dot(R, key), 0.0), 380.0) * 2.4 + pow(max(dot(R, (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz), 0.0), 6.0) * 0.06;
  reflectedLight.directSpecular += vec3(glint);
}` : ''}`);
  };
  material.customProgramCacheKey = () => personProgramKey(v);
  return material;
}

/** The far mesh's program (level 3): a vertex's colour the person's for its zone (`FarZone`, their row of `procPerson` past `ZONE_AT`). */
function farMaterial(cls: ClassShading): Material {
  const material = new MeshStandardMaterial({ roughness: 0.8, metalness: 0, side: DoubleSide });
  material.defines = { USE_SKINNING: '' };
  const v: Variant = { kind: 'far', level: 3, widen: false, grown: false, lash: false };
  material.onBeforeCompile = (shader) => {
    uniformsInto(shader, cls);
    patchVertex(shader, v);
    shader.vertexShader = `attribute vec4 aFar;
varying vec3 vProcColour; varying float vSkinMask; varying float vProcCloth;
varying vec3 vProcBind; varying float vProcRow; varying float vProcWounded; varying float vProcChar;
${shader.vertexShader}`
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  // The person's colour for the vertex's zone: their hair, their skin or the garment over it (\`zoneColours\`).
  vec4 zone = texelFetch(procPerson, ivec2(${ZONE_AT / 4} + int(aFar.w + 0.5), int(aPerson.x)), 0);
  vProcColour = zone.rgb;
  vSkinMask = zone.a > 0.5 && zone.a < 1.5 ? 1.0 : 0.0;
  vProcCloth = zone.a < 0.5 ? 1.0 : 0.0;
}
vProcBind = position; vProcRow = aPerson.x; vProcWounded = aPerson.z; vProcChar = aPerson.w;`);
    shader.fragmentShader = `#define appearanceDetail 1.0
#define vHairMask 0.0
#define vGarmentSlot vProcCloth
uniform sampler2D procPerson; uniform float procTime; uniform float procWoundUnit;
varying vec3 vProcColour; varying float vSkinMask; varying float vProcCloth;
varying vec3 vProcBind; varying float vProcRow; varying float vProcWounded; varying float vProcChar;
vec3 personStrand = vec3(0.0, 1.0, 0.0); float personSparkle = 0.5;
${shader.fragmentShader}`
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec4 texel = vec4(vProcColour, 1.0);
  ${WOUND_BLOCK}
  if (vProcChar > 0.5) texel.rgb = vec3(0.04, 0.03, 0.025);
  diffuseColor *= texel;
}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(0.85, 0.5, vSkinMask);`)
      .replace('#include <lights_physical_pars_fragment>', personLighting(false, true))
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
reflectedLight.indirectSpecular *= personIndirect();`);
  };
  material.customProgramCacheKey = () => personProgramKey(v);
  return material;
}

/** DO NOT cast a piece with its own level's program: it casts the next level's triangles (`castsAt`), so the next level's skinning, without the face or expressions the shadow cannot show. */
function depthMaterial(cls: ClassShading, v: Variant, widen: number): MeshDepthMaterial {
  // // No colour: the sun's maps are read by their depth texture alone (three r186 PCF compares `shadow.map.depthTexture`), nothing reads the packed colour (AGT-35).
  const material = new MeshDepthMaterial({ depthPacking: RGBADepthPacking, colorWrite: false });
  material.defines = { USE_SKINNING: '' };
  const cast: Variant = { ...v, level: v.level + 1 };
  material.onBeforeCompile = (shader) => {
    uniformsInto(shader, cls, v.widen ? widen : undefined);
    patchVertex(shader, cast);
  };
  material.customProgramCacheKey = () => personDepthKey(cast);
  return material;
}

/** A class's shading with nothing in it: what a program is compiled against before any class is made. */
function blankShading(): ClassShading {
  const blank = new DataTexture(new Float32Array(4), 1, 1, RGBAFormat, FloatType);
  return {
    uniforms: {
      procBones: { value: blank }, procBase: { value: 0 }, procBodies: { value: blank }, procBodyStride: { value: 0 }, procCover: { value: blank },
      procCoverRows: { value: 0 }, procFace: { value: blank }, procFaceRows: { value: 0 }, procFaceHead: { value: 0 },
      procExprHead: { value: 0 }, procPerson: { value: blank }, procTime: { value: 0 }, procWoundUnit: { value: 1 },
    },
    rig: { mesh: { bindMatrix: new Matrix4(), bindMatrixInverse: new Matrix4() } },
  };
}

/** The shader text a piece of variant `v` is compiled with (`depth`: the shadow's, cast by the next level), as three hands it to `onBeforeCompile`: one key, one text. */
export function personShaderText(v: Variant, depth = false): string {
  const shading = blankShading();
  const material = depth ? depthMaterial(shading, v, 1) : pieceMaterial(shading, v, null, null, 1);
  const lib = ShaderLib[depth ? 'depth' : 'physical'];
  const shader = { vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader, uniforms: {} as Record<string, unknown> };
  material.onBeforeCompile(shader as never, null as never);
  material.dispose();
  return `${shader.vertexShader}
----
${shader.fragmentShader}`;
}

/** Every program a procedural person can be drawn with (`PERSON_VARIANTS`) and cast into the shadow with */
export function personProgramStandIns(): { readonly lit: Group; readonly shadow: Group } {
  const shading = blankShading();
  // A position and a normal, as every piece has (`farMesh`, `computeVertexNormals`): `vertexNormals` is part of three's key.
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(9), 3));
  const standIn = (material: Material): InstancedMesh => {
    // Instanced without a colour or a morph a person, as `makePiece` makes them.
    const mesh = new InstancedMesh(geometry, material, 1);
    mesh.frustumCulled = false;
    return mesh;
  };
  const lit = new Group();
  for (const v of PERSON_VARIANTS) lit.add(standIn(v.kind === 'far' ? farMaterial(shading) : pieceMaterial(shading, v, null, null, 1)));
  const shadow = new Group();
  for (const v of PERSON_SHADOW_VARIANTS) {
    // The depth's side and cut come from the piece's own material, as the shadow pass takes them (`shadowStandIn`).
    const mesh = standIn(pieceMaterial(shading, v, null, null, 1));
    mesh.castShadow = true;
    mesh.customDepthMaterial = depthMaterial(shading, v, 1);
    const cast = shadowStandIn(mesh);
    if (cast) shadow.add(cast);
  }
  return { lit, shadow };
}

function kindOf(item: ProxyItem): Kind {
  const k = item.pack.kind;
  if (k === 'eyebrows' || k === 'eyelashes') return 'face';
  if (k === 'hair' || k === 'beard' || item.transparent) return 'hair';
  return 'cloth';
}

/** What an item is to a person, for its triangles at each level (`crowdLod.ts`). */
function roleOf(name: string, item: ProxyItem, look: PersonLook): PieceRole {
  const k = item.pack.kind;
  if (name === 'acc:teeth' || name === 'acc:tongue') return 'mouth';
  if (k === 'eyebrows') return 'brows';
  if (k === 'eyelashes') return 'lashes';
  if (kindOf(item) === 'hair') return 'hair';
  if (name === look.outfit) return 'outfit';
  if (k === 'shoes' || name === look.footwear) return 'shoes';
  if (COVERING.has(k) && !name.startsWith('acc:')) return 'garment';
  return 'accessory';
}

/** A texture of rows: once on the GPU, rows can be sent alone (`touchRows`). */
function rowTexture(pixels: Float32Array, width: number, rows: number): DataTexture {
  const texture = new DataTexture(pixels, width / 4, rows, RGBAFormat, FloatType);
  texture.minFilter = texture.magFilter = NearestFilter;
  texture.needsUpdate = true;
  texture.onUpdate = () => { texture.userData['uploaded'] = true; };
  return texture;
}

/** `capacity` people's rows of `procPerson`: no wounds (-1), no expression (0); `old`'s rows kept. */
function personRows(capacity: number, old?: Float32Array): Float32Array {
  const rows = new Float32Array(PERSON_FLOATS * capacity);
  for (let r = 0; r < capacity; r++) rows.fill(-1, r * PERSON_FLOATS, r * PERSON_FLOATS + EXPR_AT);
  if (old) rows.set(old);
  return rows;
}

/** Rows `first`..`first + count` of a row texture to the GPU, a range a row */
function touchRows(texture: DataTexture, first: number, count: number): void {
  const row = texture.image.width * 4;
  if (texture.userData['uploaded']) for (let r = 0; r < count; r++) texture.addUpdateRange((first + r) * row, row);
  else texture.clearUpdateRanges();
  texture.needsUpdate = true;
}

const samplers = new WeakMap<Texture, ((u: number, v: number) => readonly [number, number, number]) | null>();
/** A texture read back at a UV, linear RGB (128 x 128 is plenty for a colour a vertex); null when it cannot be read. */
function textureSampler(texture: Texture | null): ((u: number, v: number) => readonly [number, number, number]) | null {
  if (!texture) return null;
  const known = samplers.get(texture);
  if (known !== undefined) return known;
  let sampler: ((u: number, v: number) => readonly [number, number, number]) | null = null;
  const srgb = texture.colorSpace === SRGBColorSpace;
  const lin = (c: number): number => { const s = c / 255; return !srgb ? s : s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  // A texture of pixels (a garment padded in a worker, `skinAppearance.ts` paddedGarment): read where it is. DO NOT draw it on a canvas: its
  // image is no picture, and every garment came out grey on a far body (the far bodies' photos, 2026-10-22).
  const raw = texture.image as { data?: ArrayLike<number> | null; width?: number; height?: number } | null;
  if (raw?.data && (raw.data instanceof Uint8Array || raw.data instanceof Uint8ClampedArray) && (raw.width ?? 0) > 0 && (raw.height ?? 0) > 0
    && raw.data.length >= raw.width! * raw.height! * 4) {
    const px = raw.data, W = raw.width!, H = raw.height!, flip = texture.flipY;
    sampler = (u, v) => {
      const fu = u - Math.floor(u), fv = v - Math.floor(v);
      const x = Math.min(W - 1, Math.max(0, Math.floor(fu * W)));
      const y = Math.min(H - 1, Math.max(0, Math.floor((flip ? 1 - fv : fv) * H)));
      const o = (y * W + x) * 4;
      return [lin(px[o]!), lin(px[o + 1]!), lin(px[o + 2]!)];
    };
    samplers.set(texture, sampler);
    return sampler;
  }
  try {
    const image = texture.image as (CanvasImageSource & { width?: number; height?: number }) | null;
    const W = 128, H = 128;
    let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
    // A canvas drawn in software (MDN `willReadFrequently`)
    if (typeof OffscreenCanvas !== 'undefined') ctx = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true });
    else if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
    if (ctx && image && (image.width ?? 0) > 0) {
      ctx.drawImage(image, 0, 0, W, H);
      const px = ctx.getImageData(0, 0, W, H).data;
      const flip = texture.flipY;
      sampler = (u, v) => {
        const fu = u - Math.floor(u), fv = v - Math.floor(v);
        const x = Math.min(W - 1, Math.max(0, Math.floor(fu * W)));
        const y = Math.min(H - 1, Math.max(0, Math.floor((flip ? 1 - fv : fv) * H)));
        const o = (y * W + x) * 4;
        return [lin(px[o]!), lin(px[o + 1]!), lin(px[o + 2]!)];
      };
    }
  } catch {
    sampler = null;
  }
  samplers.set(texture, sampler);
  return sampler;
}

/** A texture's mean colour at a geometry's vertices (those `keep` passes); grey without one. */
function meanColour(texture: Texture | null, geometry: BufferGeometry, keep?: (v: number) => boolean): Color {
  const sample = textureSampler(texture);
  const uv = geometry.getAttribute('uv');
  if (!sample || !uv) return new Color(0.3, 0.3, 0.3);
  let r = 0, g = 0, b = 0, n = 0;
  for (let v = 0; v < uv.count; v++) {
    if (keep && !keep(v)) continue;
    const [cr, cg, cb] = sample(uv.getX(v), uv.getY(v));
    r += cr; g += cg; b += cb; n++;
  }
  return n ? new Color(r / n, g / n, b / n) : new Color(0.3, 0.3, 0.3);
}

/** A body's head at rest (`HeadFrame`): its eyes' mean height and depth, and its top's height over them. */
function headFrame(body: BufferGeometry): HeadFrame {
  const position = body.getAttribute('position'), eye = body.getAttribute('eyeMask');
  let y = 0, z = 0, n = 0, top = -Infinity;
  for (let v = 0; v < position.count; v++) {
    top = Math.max(top, position.getY(v));
    if (eye && eye.getX(v) > 0.5) { y += position.getY(v); z += position.getZ(v); n++; }
  }
  const eyeY = n ? y / n : top * 0.93, eyeZ = n ? z / n : 0;
  return { eyeY, eyeZ, above: Math.max(1e-6, top - eyeY) };
}

/** The zone of each vertex of a geometry skinned to a class's bones (`FarZone`): its heaviest bone's, a head's split into hair and face. */
function vertexZones(geometry: BufferGeometry, boneZones: Uint8Array, head: HeadFrame): Uint8Array {
  const position = geometry.getAttribute('position'), index = geometry.getAttribute('skinIndex'), weight = geometry.getAttribute('skinWeight');
  const zones = new Uint8Array(position.count);
  for (let v = 0; v < position.count; v++) {
    let best = 0, most = -1;
    for (let k = 0; k < 4; k++) { const w = weight.getComponent(v, k); if (w > most) { most = w; best = index.getComponent(v, k); } }
    const zone = boneZones[best] ?? FarZone.torso;
    zones[v] = zone === FarZone.face ? headZone(position.getY(v), position.getZ(v), head) : zone;
  }
  return zones;
}

/** A geometry's area in each zone (a triangle's by its first vertex's zone). */
function zoneAreas(geometry: BufferGeometry, zones: Uint8Array, keep?: (v: number) => boolean): Float32Array {
  const position = geometry.getAttribute('position'), index = geometry.getIndex();
  const out = new Float32Array(FAR_ZONES);
  if (!index) return out;
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  for (let t = 0; t + 2 < index.count; t += 3) {
    const i = index.getX(t), j = index.getX(t + 1), k = index.getX(t + 2);
    if (keep && !keep(i)) continue;
    a.fromBufferAttribute(position, i); b.fromBufferAttribute(position, j); c.fromBufferAttribute(position, k);
    const z = zones[i]!;
    out[z] = out[z]! + b.sub(a).cross(c.sub(a)).length() / 2;
  }
  return out;
}

/** A colour as a far body shows it: dyed as the close pieces dye it (`pieceMaterial`: the dye by the texture's lightness), else its own. */
function farColour(colour: Color, dye: Color | null): Color {
  if (!dye) return colour.clone();
  const l = 0.2126 * colour.r + 0.7152 * colour.g + 0.0722 * colour.b;
  return dye.clone().multiplyScalar(0.45 + 1.1 * l);
}

declare const __CROWD_LOD_HASH__: string | undefined;
declare const __PROCEDURAL_COOK_HASH__: string | undefined;
/** The fingerprint the pieces' levels are kept under (`derivedCache.ts`): the code that plans them */
const LOD_PLAN_HASH = typeof __CROWD_LOD_HASH__ !== 'undefined' && typeof __PROCEDURAL_COOK_HASH__ !== 'undefined'
  && __CROWD_LOD_HASH__ && __PROCEDURAL_COOK_HASH__ ? `${__CROWD_LOD_HASH__}-${__PROCEDURAL_COOK_HASH__}` : null;
if (LOD_PLAN_HASH) forgetOtherDerived('crowd-lod', LOD_PLAN_HASH);
/** A `LodPlan` as the browser keeps it: plain arrays. */
interface StoredPlan {
  readonly indices: readonly (Uint32Array | 'all' | null)[];
  readonly widen: readonly number[];
  readonly cardOf: Int32Array | null;
  readonly triangles: readonly number[];
}

/** How an item is drawn at each level: its index (null: not drawn there; 'all': its own) and its cards' widening. */
interface LodPlan {
  readonly indices: readonly (BufferAttribute | 'all' | null)[];
  readonly widen: readonly number[];
  /** Each vertex's card (hair), for the widening; null for a mesh. */
  readonly cardOf: Int32Array | null;
  readonly triangles: readonly number[];
}

export interface ProceduralCrowd {
  readonly group: Group;
  add(spec: PersonSpec): Promise<ProceduralPerson>;
  /** Every person's level, pose and place: once a frame, after setting `matrix`, `clip`, `phase` (and `pixels`). */
  /** `strands`: how many of the nearest people get their hair's strands (the tier's, `quality.ts` hairStrandPeople). */
  update(eye?: Vector3, time?: number, shadows?: boolean, strands?: number): void;
  /** The skeletons worked out on the GPU (`crowdAnimation.ts`): once a frame, after `update`, before the scene is drawn. */
  renderPalettes(renderer: WebGLRenderer): void;
  /** The ragdolls' side (`agents.ts`, `ragdoll.ts`): a person's skeleton */
  readonly ragdoll: {
    skeleton(person: ProceduralPerson): { names: string[]; parents: number[]; inverses: Matrix4[]; local: Matrix4; bind: Matrix4 } | null;
    pose(person: ProceduralPerson): Float32Array | null;
    /** A pose of a clip (`idle`, or `getUp` played once: its phase held at the end), in the person's row. */
    standing(person: ProceduralPerson, phase: number, clip?: 'idle' | 'getUp' | 'riseFront' | 'riseBack' | 'crawl'): Float32Array | null;
    hold(person: ProceduralPerson, palette: Float32Array | null): void;
    /** A clip's length, seconds. */
    duration(person: ProceduralPerson, clip: ProcClip): number;
    /** A bullet hole in this part of them, blood soaking out of it from now on. */
    wound(person: ProceduralPerson, part: BodyPart): void;
    /** The jolt of a bullet (Euphoria's shot: the spine giving way along the shot for a moment, then recovering) */
    jolt(person: ProceduralPerson, dirX: number, dirY: number, strength: number): void;
    /** The layers over the clip now (a jolt and its weight), for probes. */
    layers(person: ProceduralPerson): string[];
    /** A wounded posture laid over their clip (null takes it off): bent over by `hunch` radians, a hand on the wound by `reach` (0-1). */
    posture(person: ProceduralPerson, pose: { hunch: number; reach: number; part: BodyPart; cover?: number } | null): void;
    /** Blood all over them (a body shot to pieces). */
    drench(person: ProceduralPerson): void;
    /** Their wounds gone (the person drawn as somebody new). */
    heal(person: ProceduralPerson): void;
    /** Another of this person - their row's shape, face, clothes and colours - for a piece of them torn off */
    twin(person: ProceduralPerson): ProceduralPerson | null;
    untwin(twin: ProceduralPerson): void;
    /** Burnt black (a bomb's direct hit), skin, clothes and hair; given back by `hold(person, null)`. */
    char(person: ProceduralPerson, on: boolean): void;
  };
  clear(): void;
  clipDuration(person: ProceduralPerson, clip?: ProcClip): number;
  /** Ground one walk cycle covers at the person's scale, metres (of `clip`, their own by default). */
  stride(person: ProceduralPerson, clip?: ProcClip): number;
  stats(): ProceduralStats;
  /** Whether the last `update` drew anybody (each class casts through its shadow proxy): the shadow map's moving casters. */
  readonly casting: boolean;
  /** Diagnosis: the shape the GPU sums for a person at base vertices, against the rig's exact one, metres. */
  probe(person: ProceduralPerson, vertices: readonly number[]): { v: number; linear: number[]; exact: number[] }[];
  readonly people: readonly ProceduralPerson[];
  /** Drops an item and its pieces, so it is built again on next use (a hairstyle being edited). */
  forget(name: string): void;
  /** Every class made ahead, one at a time: its rig on the people's worker (`classRigInWorker`), the page only putting it together */
  warmClasses(): Promise<void>;
  /** Every class and hairstyle built here, packed for the cook (`proceduralCook.ts`, `scripts/cook-people.mjs`). */
  cook(): Promise<Map<string, ArrayBuffer>>;
}

/** A person's place in the crowd: their class, baked body, what they wear and at which level they are drawn. */
interface Wear { readonly item: Item; readonly dye: Color | null }
interface PersonState {
  readonly cls: BodyClass;
  /** Their own shape coefficients less the class's (`probe`). */
  readonly coef: Float32Array;
  readonly variant: number;
  /** The skin first. */
  readonly wears: readonly Wear[];
  readonly covers: readonly number[];
  /** Their level now (-1: not drawn), and the one this frame wants. */
  level: number;
  want: number;
  /** The pieces they are in now, and their slot in each (DO NOT look it up in the piece's list: `indexOf` over every person in it). */
  readonly pieces: Piece[];
  readonly slotIn: Map<Piece, number>;
  /** Their matrix with their own height, this frame. */
  readonly drawn: Matrix4;
}

export function createProceduralCrowd(options: { hair?: boolean; /** World units per metre (the game's are 2.5). */ unit?: number } = {}): ProceduralCrowd {
  const group = new Group();
  group.name = 'procedural-people';
  const classes = new Map<string, Promise<BodyClass>>();
  const ready: BodyClass[] = [];
  const people: ProceduralPerson[] = [];
  const states = new Map<ProceduralPerson, PersonState>();
  const env = createBakeEnv();
  let bakeMs = 0;
  /** Bumped by `clear`: an `add` begun before it is dropped. */
  let epoch = 0;
  const items = new Map<string, Promise<ProxyItem>>();
  const textures = new Map<string, Promise<Texture | null>>();
  const scaled = new Matrix4();
  const blobs = createBlobShadows('procedural-people-shadows', 1024);
  group.add(blobs.mesh);
  /** How every item is drawn at each level, by item (the body: 'skin'): the same for every class, whose fits share their vertices' order. */
  const lodPlans = new Map<string, Promise<LodPlan>>();
  const levelCount = [0, 0, 0, 0];
  let trianglesDrawn = 0;
  /** Whether a piece that casts (levels 0 and 1, `castsAt`) drew anybody this frame: the far levels' shadow is a disc, never the map's. */
  let castingNow = false;
  /** Last frame's: the last caster gone changes the shadow too. */
  let castedLast = false;

  /** The class's pose on this person's own joints. */
  const shift = new Float32Array(512 * 3);
  const refit = (cls: BodyClass, person: ProceduralPerson, at: number): void => {
    const m = cls.palette, d = person.joints;
    for (const i of cls.order) {
      const p = cls.parent[i]!;
      let x = d[i * 3]!, y = d[i * 3 + 1]!, z = d[i * 3 + 2]!;
      if (p >= 0) {
        const q = at + p * SKIN_BONE_FLOATS;
        const ex = x - d[p * 3]!, ey = y - d[p * 3 + 1]!, ez = z - d[p * 3 + 2]!;
        x = shift[p * 3]! + m[q]! * ex + m[q + 4]! * ey + m[q + 8]! * ez;
        y = shift[p * 3 + 1]! + m[q + 1]! * ex + m[q + 5]! * ey + m[q + 9]! * ez;
        z = shift[p * 3 + 2]! + m[q + 2]! * ex + m[q + 6]! * ey + m[q + 10]! * ez;
      }
      shift[i * 3] = x; shift[i * 3 + 1] = y; shift[i * 3 + 2] = z;
    }
    for (let i = 0; i < cls.bones; i++) {
      const o = at + i * SKIN_BONE_FLOATS;
      const dx = d[i * 3]!, dy = d[i * 3 + 1]!, dz = d[i * 3 + 2]!;
      m[o + 12] = m[o + 12]! + shift[i * 3]! - (m[o]! * dx + m[o + 4]! * dy + m[o + 8]! * dz);
      m[o + 13] = m[o + 13]! + shift[i * 3 + 1]! - (m[o + 1]! * dx + m[o + 5]! * dy + m[o + 9]! * dz);
      m[o + 14] = m[o + 14]! + shift[i * 3 + 2]! - (m[o + 2]! * dx + m[o + 6]! * dy + m[o + 10]! * dz);
    }
  };

  /** A limb lost: every bone from its joint down shrunk to that joint, so the stump closes there */
  const limbBones = new WeakMap<BodyClass, Record<string, { bones: number[]; parent: number; joint: Vector3 } | null>>();
  const limbTmp = new Matrix4(), limbAt = new Vector3();
  const LIMB_ROOT: Record<Severable, string> = { armL: 'lowerarm_l', armR: 'lowerarm_r', legL: 'calf_l', legR: 'calf_r', head: 'head' };
  const closeLimb = (cls: BodyClass, at: number, limb: Severable): void => {
    let info = limbBones.get(cls);
    if (!info) {
      info = {};
      const bones = cls.rig.mesh.skeleton.bones;
      const parents = bones.map((b) => bones.indexOf(b.parent as never));
      for (const [key, name] of Object.entries(LIMB_ROOT)) {
        const root = bones.findIndex((b) => b.name === name);
        if (root < 0) { info[key] = null; continue; }
        const set = [root];
        for (let i = 0; i < bones.length; i++) {
          let j = parents[i]!;
          while (j >= 0 && j !== root) j = parents[j]!;
          if (j === root) set.push(i);
        }
        const joint = new Vector3().setFromMatrixPosition(limbTmp.copy(cls.rig.mesh.skeleton.boneInverses[root]!).invert());
        info[key] = { bones: set, parent: parents[root]!, joint };
      }
      limbBones.set(cls, info);
    }
    const which = info[limb];
    if (!which || which.parent < 0) return;
    const px = cls.palette;
    limbTmp.fromArray(px, at + which.parent * SKIN_BONE_FLOATS);
    limbAt.copy(which.joint).applyMatrix4(limbTmp);
    for (const i of which.bones) {
      const o = at + i * SKIN_BONE_FLOATS;
      px.fill(0, o, o + 16);
      px[o + 12] = limbAt.x; px[o + 13] = limbAt.y; px[o + 14] = limbAt.z; px[o + 15] = 1;
    }
  };

  /** Poses held by the ragdolls, by person (`ragdoll.hold`). */
  const holds = new Map<ProceduralPerson, Float32Array>();
  const woundSpots = (cls: BodyClass): Record<BodyPart, number[]> => {
    const assets = env.loaded?.assets ?? null;
    return woundSpotsOf(cls.rig.mesh,
      assets && assets.mesh.vertexCount === cls.rig.mesh.geometry.getAttribute('position').count ? assets.mesh.vertexGroups : null);
  };
  const classOf = (person: ProceduralPerson): BodyClass | null => states.get(person)?.cls ?? null;

  const item = (name: string): Promise<ProxyItem> => {
    let loaded = items.get(name);
    if (!loaded) {
      const style = name.startsWith('hair:') ? HAIR_STYLES[name.slice(5)] : undefined;
      if (name === 'eyes') {
        loaded = env.eyes();
        items.set(name, loaded);
        return loaded;
      }
      if (name === 'acc:teeth' || name === 'acc:tongue') {
        // The base mesh's own teeth and tongue (its helper groups), each vertex pinned to itself
        loaded = Promise.all([env.setup(), item('eyes')]).then(([{ assets: a }, eyes]) => {
          const groups = (name === 'acc:teeth' ? ['helper-upper-teeth', 'helper-lower-teeth'] : ['helper-tongue'])
            .map((g) => a.mesh.faceGroups.indexOf(g)).filter((g) => g >= 0);
          const used = new Map<number, number>();
          const index: number[] = [];
          const at = (v: number): number => { let k = used.get(v); if (k === undefined) { k = used.size; used.set(v, k); } return k; };
          for (let f = 0; f < a.mesh.faceGroup.length; f++) {
            if (!groups.includes(a.mesh.faceGroup[f]!)) continue;
            const q = [a.mesh.faces[f * 4]!, a.mesh.faces[f * 4 + 1]!, a.mesh.faces[f * 4 + 2]!, a.mesh.faces[f * 4 + 3]!];
            index.push(at(q[0]!), at(q[1]!), at(q[2]!));
            if (q[3] !== q[2]) index.push(at(q[0]!), at(q[2]!), at(q[3]!));
          }
          const n = used.size;
          const refs = new Uint32Array(n * 3), weights = new Float32Array(n * 3);
          for (const [v, k] of used) { refs.fill(v, k * 3, k * 3 + 3); weights[k * 3] = 1; }
          const pack = { ...eyes.pack, name, kind: 'clothes' as const, refs, weights, offsets: new Float32Array(n * 3),
            index: Uint32Array.from(index), deleteVerts: new Uint32Array(0), uvs: new Float32Array(n * 2) };
          return { pack, texture: null, transparent: false, textureFile: null };
        });
        items.set(name, loaded);
        return loaded;
      }
      if (name === 'acc:headband') {
        // From the cook, like the hairstyles: grown here it was the biggest share of the game's script while people arrived
        loaded = loadProcedural('acc-headband').then(async (cooked) => {
          if (cooked) return { pack: packFromRecord(cooked), texture: null, transparent: false, textureFile: null };
          const { assets: a, morpher: mo } = await env.setup();
          return { pack: generateHeadband(hairBase(a, mo)), texture: null, transparent: false, textureFile: null };
        });
        items.set(name, loaded);
        return loaded;
      }
      if (!style && /^eyebrow|^eyelash/.test(name)) {
        // Brows and lashes nearer the skin than their files place them
        loaded = loadProxyItem(name).then((it) => {
          const k = name.startsWith('eyebrow') ? 0.2 : 0.62;
          return { ...it, pack: { ...it.pack, offsets: it.pack.offsets.map((o) => o * k) } };
        });
        items.set(name, loaded);
        return loaded;
      }
      loaded = style
        ? hairCards(env, style).then((pack) => ({ pack, texture: null, transparent: true, textureFile: null }))
        : loadProxyItem(name);
      items.set(name, loaded);
    }
    return loaded;
  };
  const textureOf = (name: string, it: ProxyItem): Promise<Texture | null> => {
    let t = textures.get(name);
    if (!t) {
      const style = name.startsWith('hair:') ? HAIR_STYLES[name.slice(5)] : undefined;
      t = style ? Promise.resolve(hairStrandTexture(style.strands))
        : name.startsWith('acc:') ? Promise.resolve(plainTexture() as Texture) : itemTexture(name, it) ?? Promise.resolve(null);
      textures.set(name, t);
    }
    return t;
  };

  /** A class's rig and how its items are fitted: made on the people's worker (its arrays shared, nothing of what it sent kept), or here where no worker can or no cook says what the class is. */
  const classRigFor = async (sex: WalkSex, band: AgeBand, cooked: boolean): Promise<{ base: MacroParams; shape: Float32Array; rig: PersonRig; fit: (item: ProxyItem) => Promise<WornPiece>; eyes: ProxyItem }> => {
    const { assets: a } = await env.setup();
    const away = cooked ? await classRigInWorker(sex, band) : null;
    if (away) {
      const { rig, shape } = rigFromMade(away, a.mesh.weights, a.mesh.joints);
      const fit = (it: ProxyItem): Promise<WornPiece> => wearInWorker(sex, band, it.pack).then((worn) => worn ?? Promise.reject(new Error(`${it.pack.name}: not fitted`)));
      return { base: away.base, shape, rig, fit, eyes: await env.eyes() };
    }
    const made = await classRig(env, sex, band);
    return { ...made, fit: (it) => Promise.resolve(made.rig.wear!(it, made.shape)) };
  };

  const buildClass = async (sex: WalkSex, band: AgeBand): Promise<BodyClass> => {
    const { assets: a, morpher: mo } = await env.setup();
    const started = performance.now();
    // Read from the cook (`proceduralCook.ts`); built here only when it is missing or stale.
    const cooked = await loadProcedural(`class-${sex}-${band}`);
    // DO NOT build a class's rig on the page (`createPersonRig`, 50-100 ms each, while the map opens): made and kept on the people's worker, its body read back as a cooked person, its items fitted there (`fit`).
    const { base, shape, rig, fit, eyes } = await classRigFor(sex, band, cooked !== null);
    const data = cooked ? classFromRecord(cooked) : await classData(env, sex, rig, shape);
    const { shapePixels, jointBasis, faceIndexPixels, faceList } = data;
    const clips: Record<ProcClip, ClipFrames> = {
      walk: data.walk, idle: data.idle, run: data.run, cower: data.cower, sprint: data.sprint, photo: data.photo, getUp: data.getUp,
      duck: data.duck, hurtWalk: data.hurtWalk, hurtRun: data.hurtRun, nervous: data.nervous, hit: data.hit,
      staggerBack: data.staggerBack, riseFront: data.riseFront, riseBack: data.riseBack, crawl: data.crawl,
    };
    const vertexCount = a.mesh.vertexCount;

    // The body itself: base-vertex references for its shape and cover.
    const body = rig.mesh.geometry;
    const source = body.userData['morphSource'] as { kind: Int16Array; index: Int32Array };
    const n = body.getAttribute('position').count;
    const refs = new Float32Array(n * 3), refW = new Float32Array(n * 3);
    for (let o = 0; o < n; o++) {
      const kind = source.kind[o]!, i = source.index[o]!;
      if (kind === -1) { refs.fill(i, o * 3, o * 3 + 3); refW[o * 3] = 1; }
      else if (kind === 0) {
        for (let k = 0; k < 3; k++) { refs[o * 3 + k] = eyes.pack.refs[i * 3 + k]!; refW[o * 3 + k] = eyes.pack.weights[i * 3 + k]!; }
      }
    }
    body.setAttribute('aRefs', new BufferAttribute(refs, 3));
    body.setAttribute('aRefW', new BufferAttribute(refW, 3));
    if (!body.getAttribute('eyeMask')) body.setAttribute('eyeMask', new BufferAttribute(new Float32Array(n), 1));
    if (!body.getAttribute('normal')) body.computeVertexNormals();
    await breathe();

    const bones = rig.mesh.skeleton.bones.length;
    const skeletonBones = rig.mesh.skeleton.bones;
    const parent = new Int16Array(bones).fill(-1);
    skeletonBones.forEach((bone, i) => { parent[i] = skeletonBones.indexOf(bone.parent as typeof bone); });
    const order: number[] = [];
    const visit = (i: number): void => { order.push(i); for (let j = 0; j < bones; j++) if (parent[j] === i) visit(j); };
    for (let i = 0; i < bones; i++) if (parent[i] === -1) visit(i);
    // The bodies baked from the shape basis
    const bodies = createClassBodies(shapePixels, vertexCount, SHAPES, jointBasis, bones);
    // The atlas's texels let go once on the GPU: the clips keep the same frames for the CPU's own palettes.
    const anim = buildClassAnimation(clips, bones, true);
    const pass = createPalettePass(anim, parent, () => bodies.joints, ROW_START);
    await breathe();
    // Drawn only once its program is built (`uploads.ts` compilePassAhead), off the frame.
    await pass.ready;
    const faceRows = Math.ceil(faceList.length / FACE_WIDTH);
    // One texture for the face: the index (a vertex a float, four a texel), the expressions' shapes, then each person's face
    const indexRows = Math.ceil(faceIndexPixels.length / (FACE_WIDTH * 4));
    const faceHead = indexRows + faceRows * EXPR_SLOTS;
    const headOf = (d: Pick<typeof data, 'faceIndexPixels' | 'exprPixels'>): Float32Array => {
      const head = new Float32Array(FACE_WIDTH * 4 * faceHead);
      head.set(d.faceIndexPixels);
      head.set(d.exprPixels, indexRows * FACE_WIDTH * 4);
      return head;
    };
    // DO NOT keep the faces on the CPU: the head goes up once, each person's face as they are made (`gpuRows.ts`).
    const faces = createGpuRows(FACE_WIDTH, faceHead + faceRows * ROW_START);
    faces.write(0, headOf(data));
    const reloadHead = async (): Promise<Float32Array> => {
      const again = await loadProcedural(`class-${sex}-${band}`);
      return headOf(again ? classFromRecord(again) : await classData(env, sex, rig, shape));
    };
    const personData = personRows(ROW_START);

    const palette = new Float32Array(bones * SKIN_BONE_FLOATS * ROW_START);
    const coverPixels = new Uint8Array(COVER_WIDTH);
    const cover = new DataTexture(coverPixels, COVER_WIDTH, 1, RedFormat, UnsignedByteType);
    cover.needsUpdate = true;
    const metres = bodyHeight(shape, a.bodyRange) / 10;
    const unit = woundUnit(rig.mesh.geometry, metres);
    // The far mesh's zones (`FarZone`): each bone's by its name, the head's hair over the brow and round the skull.
    const boneZones = Uint8Array.from(skeletonBones, (b) => boneZone(CAPTURE_NAME[b.name] ?? b.name));
    const head = headFrame(body);
    const zones = vertexZones(body, boneZones, head);
    const eyeMask = body.getAttribute('eyeMask');
    const zoneArea = zoneAreas(body, zones, (v) => eyeMask.getX(v) < 0.5);
    if (!body.boundingBox) body.computeBoundingBox();
    bakeMs += performance.now() - started;
    const cls: BodyClass = {
      key: `${sex}-${band}`, sex, band, base, shape, coefficients: mo.coefficients(base), rig,
      height: metres, clips, bones, order, parent, jointBasis, shapePixels: bodies.basis, bodies, anim, pass,
      uniforms: {
        procBones: { value: pass.texture },
        procBase: { value: pass.base },

        procBodies: { value: bodies.texture },
        procBodyStride: { value: bodies.stride },
        procCover: { value: cover },
        procCoverRows: { value: Math.ceil(vertexCount / COVER_WIDTH) },
        procFace: { value: faces.texture },
        procFaceRows: { value: faceRows },
        procFaceHead: { value: faceHead },
        procExprHead: { value: indexRows },
        procPerson: { value: rowTexture(personData, PERSON_FLOATS, ROW_START) },
        procTime: { value: 0 },
        procWoundUnit: { value: unit },
      },
      fit, personData, placed: [], faces, faceOf: [], reloadHead, faceVerts: sharedCopy(faceList), palette, rows: 0, capacity: ROW_START, cover: new Map(), body,
      skins: new Map(), items: new Map(), far: null, zones, zoneArea, head, boneZones, zoneCover: new Map(), bodyHeight: body.boundingBox!.max.y - body.boundingBox!.min.y,
      pieces: [], people: [], drawn: 0,
    };
    ready.push(cls);
    buildFar(cls);
    return cls;
  };

  const classFor = (sex: WalkSex, band: AgeBand): Promise<BodyClass> => {
    const key = `${sex}-${band}`;
    let cls = classes.get(key);
    if (!cls) { cls = buildClass(sex, band); classes.set(key, cls); }
    return cls;
  };

  /** A garment's cover row in its class, made on first use. */
  const coverRow = (cls: BodyClass, name: string, it: ProxyItem): number => {
    const known = cls.cover.get(name);
    if (known !== undefined) return known;
    const row = cls.cover.size;
    cls.cover.set(name, row);
    const per = cls.uniforms.procCoverRows.value;
    const old = cls.uniforms.procCover.value;
    const rows = (row + 1) * per;
    const pixels = new Uint8Array(COVER_WIDTH * rows);
    pixels.set((old.image.data as Uint8Array).subarray(0, Math.min(old.image.data!.length, pixels.length)));
    for (const v of it.pack.deleteVerts) pixels[row * per * COVER_WIDTH + v] = 255;
    const texture = new DataTexture(pixels, COVER_WIDTH, rows, RedFormat, UnsignedByteType);
    texture.needsUpdate = true;
    cls.uniforms.procCover.value = texture;
    old.dispose();
    return row;
  };

  const growRows = (cls: BodyClass): void => {
    const capacity = cls.capacity * 2;
    const palette = new Float32Array(cls.bones * SKIN_BONE_FLOATS * capacity);
    palette.set(cls.palette);
    cls.palette = palette;
    cls.capacity = capacity;
    cls.pass.grow(capacity);
    cls.uniforms.procBones.value = cls.pass.texture;
    cls.uniforms.procBase.value = cls.pass.base;
    const faceRows = cls.uniforms.procFaceRows.value;
    const head = cls.uniforms.procFaceHead.value;
    // The rows on the GPU are carried into the bigger texture there, at the next flush.
    cls.faces.grow(head + faceRows * capacity);
    cls.uniforms.procFace.value = cls.faces.texture;
    cls.personData = personRows(capacity, cls.personData);
    cls.uniforms.procPerson.value.dispose();
    cls.uniforms.procPerson.value = rowTexture(cls.personData, PERSON_FLOATS, capacity);

  };

  /** An instanced attribute of `size` floats an entry, for a piece of `capacity` people. */
  const instanced = (capacity: number, size: number, fill = 0): InstancedBufferAttribute => {
    const attribute = new InstancedBufferAttribute(new Float32Array(capacity * size).fill(fill), size);
    attribute.setUsage(DynamicDrawUsage);
    return attribute;
  };

  /** A piece: an instanced mesh over `geometry` (an index over its item's vertices), with its own entries a person. */
  const makePiece = (cls: BodyClass, owner: Item | null, v: Variant, geometry: BufferGeometry, material: Material,
    attrs: Readonly<Record<string, number>>, proxy: BufferAttribute | null, depth: MeshDepthMaterial | null, triangles: number): Piece => {
    const capacity = PIECE_START;
    const map = new Map<string, InstancedBufferAttribute>();
    for (const [name, size] of Object.entries(attrs)) {
      const attribute = instanced(capacity, size, name === 'aWorn' ? -1 : 0);
      geometry.setAttribute(name, attribute);
      map.set(name, attribute);
    }
    const mesh = new InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    // Never moved (the people are placed by their instances)
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = true;
    mesh.castShadow = !!(proxy && depth);
    if (proxy && depth) {
      // Its side and cut set by the shadow pass on every draw, from the piece's material (`uploads.ts` shadowStandIn)
      mesh.customDepthMaterial = depth;
      const own = geometry.index, shadowIndex: BufferAttribute = proxy;
      mesh.onBeforeShadow = () => { geometry.index = shadowIndex; };
      mesh.onAfterShadow = () => { geometry.index = own; };
    }
    mesh.name = `${cls.key}/${owner?.name ?? v.kind}/L${v.level}`;
    mesh.userData['cls'] = cls.key;
    // Into the scene only once its shaders are built, in parallel and off the frame (`uploads.ts` compileAhead)
    const jobs: Promise<void>[] = [compileAhead(mesh)];
    const shadow = shadowStandIn(mesh);
    if (shadow) jobs.push(compileAhead(shadow, true));
    const piece: Piece = {
      item: owner, level: v.level, mesh, attrs: map, capacity, people: [], dirty: false, triangles,
      ready: Promise.all(jobs).then(() => { group.add(mesh); }),
    };
    cls.pieces.push(piece);
    return piece;
  };

  /** DO NOT dispose the geometry for its old per-person attributes */
  const growPiece = (piece: Piece): void => {
    // DO NOT `dispose` the mesh for its old matrices: three's releaseStatesOfObject walks every geometry the renderer knows, ms a call (the old buffer stays on the GPU, less than the new one).
    const capacity = piece.capacity * 2;
    const matrices = new InstancedBufferAttribute(new Float32Array(capacity * 16), 16);
    matrices.setUsage(DynamicDrawUsage);
    (matrices.array as Float32Array).set(piece.mesh.instanceMatrix.array as Float32Array);
    piece.mesh.instanceMatrix = matrices;
    for (const [name, old] of piece.attrs) {
      const attribute = instanced(capacity, old.itemSize, name === 'aWorn' ? -1 : 0);
      (attribute.array as Float32Array).set(old.array as Float32Array);
      piece.mesh.geometry.setAttribute(name, attribute);
      piece.attrs.set(name, attribute);
    }
    piece.capacity = capacity;
  };

  /** How an item is drawn at each level (`LodPlan`), worked out once for every class. */
  const lodPlan = (key: string, geometry: BufferGeometry, kind: Kind, role: PieceRole): Promise<LodPlan> => {
    const known = lodPlans.get(key);
    if (known) return known;
    // Kept in the browser between sessions
    const stored = LOD_PLAN_HASH ? `crowd-lod:${LOD_PLAN_HASH}:${role}:${key}` : null;
    const plan = (async (): Promise<LodPlan> => {
      if (stored) {
        const kept = await readDerived<StoredPlan>(stored);
        const vertices = geometry.getAttribute('position').count;
        if (kept && kept.indices.length === LEVELS
          && kept.indices.every((x) => x === null || x === 'all' || (x instanceof Uint32Array && x.every((v) => v < vertices)))) {
          return {
            indices: kept.indices.map((x) => (x === null || x === 'all' ? x : new BufferAttribute(x, 1))),
            widen: kept.widen, cardOf: kept.cardOf, triangles: kept.triangles,
          };
        }
      }
      const made = await makeLodPlan(geometry, kind, role);
      if (stored) {
        writeDerived(stored, {
          indices: made.indices.map((x) => (x === null || x === 'all' ? x : Uint32Array.from(x.array as ArrayLike<number>))),
          widen: [...made.widen], cardOf: made.cardOf, triangles: [...made.triangles],
        } satisfies StoredPlan);
      }
      return made;
    })();
    lodPlans.set(key, plan);
    plan.catch(() => { if (lodPlans.get(key) === plan) lodPlans.delete(key); });
    return plan;
  };
  /** The simplifying itself by the worker (`simplifiedIndexAway`), every level at once. */
  const makeLodPlan = async (geometry: BufferGeometry, kind: Kind, role: PieceRole): Promise<LodPlan> => {
    const budgets = LEVEL_TRIANGLES[role];
    const all = geometry.getIndex()!.count / 3;
    const attr = (index: Uint32Array | null): BufferAttribute | null => (index && index.length ? new BufferAttribute(index, 1) : null);
    let plan: LodPlan;
    if (kind === 'hair' || kind === 'face') {
      // Cards kept by their area; a stock hair that is one mesh is simplified instead.
      const { cardOf, selections } = cardSelections(geometry, budgets);
      const indices = await Promise.all(selections.map(async (s, level) => {
        if (!s) return null;
        if (s.index.length / 3 >= all && s.widen === 1) return 'all' as const;
        if (s.index.length / 3 > budgets[level]! * 1.3) return attr(await simplifiedIndexAway(geometry, budgets[level]!));
        return attr(s.index);
      }));
      plan = {
        indices,
        widen: selections.map((s, level) => (kind === 'hair' && indices[level] !== null && s && s.index.length / 3 <= budgets[level]! * 1.3 ? s.widen : 1)),
        cardOf: kind === 'hair' ? cardOf : null,
        triangles: indices.map((x) => (x === 'all' ? all : x ? x.count / 3 : 0)),
      };
    } else if (role === 'skin') {
      // The eyes apart from the body: simplified together, they were the first to go.
      const index = geometry.getIndex()!.array as ArrayLike<number>;
      const eye = geometry.getAttribute('eyeMask');
      const eyes = filterTriangles(index, (v) => eye.getX(v) > 0.5);
      const rest = filterTriangles(index, (v) => eye.getX(v) <= 0.5);
      const indices = await Promise.all(budgets.map(async (budget, level) => {
        if (level === 0) return 'all' as const;
        if (budget <= 0) return null;
        const [own, eyeIndex] = await Promise.all([simplifiedIndexAway(geometry, budget - EYE_TRIANGLES[level]!, rest),
          EYE_TRIANGLES[level]! > 0 ? simplifiedIndexAway(geometry, EYE_TRIANGLES[level]!, eyes) : null]);
        if (!own) return null;
        const both = new Uint32Array(own.length + (eyeIndex?.length ?? 0));
        both.set(own);
        if (eyeIndex) both.set(eyeIndex, own.length);
        return attr(both);
      }));
      plan = { indices, widen: [1, 1, 1, 1], cardOf: null, triangles: indices.map((x) => (x === 'all' ? all : x ? x.count / 3 : 0)) };
    } else {
      const indices = await Promise.all(budgets.map(async (budget, level) => (level === 0 ? 'all' as const
        : budget > 0 ? attr(await simplifiedIndexAway(geometry, budget)) : null)));
      plan = { indices, widen: [1, 1, 1, 1], cardOf: null, triangles: indices.map((x) => (x === 'all' ? all : x ? x.count / 3 : 0)) };
    }
    return plan;
  };

  /** The entries each kind of piece keeps a person (`aPerson` first). */
  const ENTRIES_SKIN = { aPerson: 4, aDye: 4, aWorn: 4 } as const;
  const ENTRIES = { aPerson: 4, aDye: 4 } as const;
  // The far mesh's colours are the person's row's (`zoneColours`): their entry is their row alone.
  const ENTRIES_FAR = { aPerson: 4 } as const;

  /** An item fitted to a class, drawn at every level it has: its vertices (`source`) once, an index and a mesh a level */
  const makeItem = async (cls: BodyClass, name: string, kind: Kind, role: PieceRole, source: BufferGeometry,
    map: Texture | null, eyes: Texture | null, grown: boolean): Promise<Item> => {
    await lodReady;
    sortSkinWeights(source);
    const plan = await lodPlan(role === 'skin' ? 'skin' : name, source, kind, role);
    const widen = !!plan.cardOf && plan.widen.some((w) => w !== 1);
    if (widen) source.setAttribute('aCard', new BufferAttribute(cardCentres(source, plan.cardOf!), 3));
    if (grown && !source.getAttribute('aFade')) source.setAttribute('aFade', new BufferAttribute(new Float32Array(source.getAttribute('position').count).fill(1), 1));
    const eye = source.getAttribute('eyeMask');
    const colour = role === 'skin' ? meanColour(map, source, (v) => !eye || eye.getX(v) < 0.5) : meanColour(map, source);
    if (!source.boundingBox) source.computeBoundingBox();
    const box = source.boundingBox!;
    const tall = cls.bodyHeight;
    const share = role === 'skin' || !(tall > 0) ? 1 : Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) / tall;
    const own: Item = {
      name, kind, role, source, levels: [], vertices: source.getAttribute('position').count, map, colour, share,
      ready: Promise.resolve(),
    };
    const indexAt = (level: number): BufferAttribute | null => {
      const x = plan.indices[level];
      return x === 'all' ? source.index : x ?? null;
    };
    const jobs: Promise<void>[] = [];
    for (let level = 0; level < LEVELS; level++) {
      const index = indexAt(level);
      // DO NOT draw a ring, a stud or a pin where it is under a pixel or two: a draw call a far person for nothing (the street census: a wedding
      // ring and an ear stud each a draw of their own at level 3, 2026-10-22).
      if (!index || !itemShownAt(share, level)) { own.levels.push(null); continue; }
      const v: Variant = { kind, level, widen, grown, lash: /lash/.test(name) };
      const geometry = new BufferGeometry();
      for (const [attribute, value] of Object.entries(source.attributes)) if (!INSTANCED.has(attribute)) geometry.setAttribute(attribute, value);
      geometry.setIndex(index);
      geometry.boundingSphere = source.boundingSphere;
      // Cast by the next level's triangles (`castsAt`).
      const proxy = castsAt(kind, role, level) ? indexAt(level + 1) : null;
      const depth = proxy ? depthMaterial(cls, v, plan.widen[level + 1] ?? 1) : null;
      const piece = makePiece(cls, own, v, geometry, pieceMaterial(cls, v, map, eyes, plan.widen[level] ?? 1),
        kind === 'skin' && level <= 2 ? ENTRIES_SKIN : ENTRIES, proxy, depth, plan.triangles[level] ?? 0);
      own.levels.push(piece);
      jobs.push(piece.ready);
      await breathe();
    }
    own.ready = Promise.all(jobs).then(() => {});
    return own;
  };

  /** The skin for a person: never one of the made-up skins */
  const bareSkin = (person: PersonSpec): ReturnType<typeof skinChoice> => skinChoice({ ...person, look: { ...person.look, makeup: 0 } });
  const skinsMaking = new Map<string, Promise<Item>>();
  const skinItem = (cls: BodyClass, person: PersonSpec): Promise<Item> => {
    const choice = bareSkin(person);
    const known = cls.skins.get(choice.name);
    if (known) return Promise.resolve(known);
    const key = `${cls.key}/${choice.name}`;
    let making = skinsMaking.get(key);
    if (!making) {
      making = (async () => {
        const [skin, eyes] = await skinTextures(choice.name, choice.url, choice.eyeFile);
        const geometry = new BufferGeometry();
        for (const [name, attribute] of Object.entries(cls.body.attributes)) if (!INSTANCED.has(name)) geometry.setAttribute(name, attribute);
        geometry.setIndex(cls.body.index);
        const made = await makeItem(cls, `skin-${choice.name}`, 'skin', 'skin', geometry, skin, eyes, false);
        cls.skins.set(choice.name, made);
        return made;
      })();
      skinsMaking.set(key, making);
    }
    return making;
  };

  const itemsMaking = new Map<string, Promise<Item>>();
  const wornItem = (cls: BodyClass, name: string, role: PieceRole): Promise<Item> => {
    const known = cls.items.get(name);
    if (known) return Promise.resolve(known);
    const key = `${cls.key}/${name}`;
    let making = itemsMaking.get(key);
    if (!making) {
      making = (async () => {
        const it = await item(name);
        const map = await textureOf(name, it);
        await breathe();
        const fitAt = performance.now();
        const fitted = await cls.fit(it);
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(fitted.positions, 3));
        const n = fitted.positions.length / 3;
        // DO NOT write these attributes in place: it would change the item for every class at once.
        geometry.setAttribute('uv', new BufferAttribute(it.pack.uvs ?? new Float32Array(n * 2), 2));
        geometry.setAttribute('skinIndex', new BufferAttribute(fitted.joints, 4));
        geometry.setAttribute('skinWeight', new BufferAttribute(fitted.weights, 4));
        geometry.setAttribute('aRefs', new BufferAttribute(Float32Array.from(it.pack.refs), 3));
        geometry.setAttribute('aRefW', new BufferAttribute(it.pack.weights, 3));
        if (it.pack.fade) geometry.setAttribute('aFade', new BufferAttribute(it.pack.fade, 1));
        geometry.setIndex(new BufferAttribute(it.pack.index, 1)); // DO NOT `Array.from` it: a JS array of every index, made to be turned back into this one (the page's garbage, a memory probe, 2026-10-18).
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();
        const made = await makeItem(cls, name, kindOf(it), role, geometry, map, null, name.startsWith('hair:'));
        measureHitch(`hitch:person/fit ${cls.key} ${name}`, fitAt);
        cls.items.set(name, made);
        return made;
      })();
      itemsMaking.set(key, making);
      making.catch(() => itemsMaking.delete(key));
    }
    return making;
  };

  /** The far mesh of a class (level 3): its body whole, simplified, each vertex its zone (`FarZone`); every far person of the class drawn in
   *  it, in their colours a zone (`zoneColours`). DO NOT make one a class and outfit with the hair and the accessories drawn apart: a far
   *  person 3 to 8 pixels tall was a draw call an outfit, a hairstyle, a ring and a stud (2.4 draws a person, the street census, 2026-10-22). */
  const buildFar = (cls: BodyClass): void => {
    void (async () => {
      await lodReady;
      await breathe();
      const body = cls.body;
      const eye = body.getAttribute('eyeMask');
      const open = filterTriangles(body.getIndex()!.array as ArrayLike<number>, (v) => !(eye && eye.getX(v) > 0.5));
      const geometry = farMesh([{ geometry: body, indices: open, region: REGION.skin, triangles: FAR_TRIANGLES, zoneOf: (v) => cls.zones[v]! }], 0);
      if (!geometry) return;
      await breathe();
      const v: Variant = { kind: 'far', level: 3, widen: false, grown: false, lash: false };
      const piece = makePiece(cls, null, v, geometry, farMaterial(cls), ENTRIES_FAR, null, null, (geometry.getIndex()?.count ?? 0) / 3);
      await piece.ready;
      cls.far = piece;
    })();
  };

  /** How much of each zone of its class's body an item covers (0 to 1): the body's vertices there it hides (`deleteVerts`), or its own area
   *  over the body's there (a skirt hides none of the legs under it), whichever is more. Made once a class and item. */
  const zoneCover = (cls: BodyClass, item: Item, pack: ProxyItem | null): Float32Array => {
    const known = cls.zoneCover.get(item.name);
    if (known) return known;
    const out = new Float32Array(FAR_ZONES);
    const hidden = new Float32Array(FAR_ZONES), all = new Float32Array(FAR_ZONES);
    const deleted = pack ? new Set(pack.pack.deleteVerts) : null;
    const refs = cls.body.getAttribute('aRefs');
    for (let v = 0; v < cls.zones.length; v++) {
      const z = cls.zones[v]!;
      all[z] = all[z]! + 1;
      if (deleted?.has(Math.round(refs.getX(v)))) hidden[z] = hidden[z]! + 1;
    }
    const own = item.source.getAttribute('skinIndex') ? zoneAreas(item.source, vertexZones(item.source, cls.boneZones, cls.head)) : new Float32Array(FAR_ZONES);
    for (let z = 0; z < FAR_ZONES; z++) {
      const area = cls.zoneArea[z]!;
      out[z] = Math.max(all[z]! > 0 ? hidden[z]! / all[z]! : 0, area > 0 ? Math.min(1, own[z]! / area) : 0);
    }
    cls.zoneCover.set(item.name, out);
    return out;
  };

  /** A garment covers a zone of a far body past this share of it. */
  const ZONE_COVERED = 0.4;
  /** A person's colour a zone of the far body into their row (`ZONE_AT`): the outermost garment over it, else their hair (the hair zone, with
   *  hair) or their skin; the fourth channel 0 cloth, 1 skin, 2 hair (`farMaterial`). */
  const zoneColours = (cls: BodyClass, row: number, skin: Color, hair: Color | null, worn: readonly { wear: Wear; pack: ProxyItem | null }[]): void => {
    const at = row * PERSON_FLOATS + ZONE_AT;
    const data = cls.personData;
    for (let z = 0; z < FAR_ZONES; z++) {
      const colour = z === FarZone.hair && hair ? hair : skin;
      data[at + z * 4] = colour.r; data[at + z * 4 + 1] = colour.g; data[at + z * 4 + 2] = colour.b;
      data[at + z * 4 + 3] = z === FarZone.hair && hair ? 2 : 1;
    }
    // Inner layers first, the outer over them: shoes, a garment, the outfit, a hat or a coat worn over all.
    const layer = (role: PieceRole): number => (role === 'shoes' ? 0 : role === 'garment' ? 1 : role === 'outfit' ? 2 : 3);
    const cloth = worn.filter((w) => w.wear.item.kind === 'cloth' && w.wear.item.role !== 'mouth')
      .sort((p, q) => layer(p.wear.item.role) - layer(q.wear.item.role));
    for (const { wear, pack } of cloth) {
      const cover = zoneCover(cls, wear.item, pack);
      const colour = farColour(wear.item.colour, wear.dye);
      for (let z = 0; z < FAR_ZONES; z++) {
        if (cover[z]! < ZONE_COVERED) continue;
        data[at + z * 4] = colour.r; data[at + z * 4 + 1] = colour.g; data[at + z * 4 + 2] = colour.b; data[at + z * 4 + 3] = 0;
      }
    }
    touchRows(cls.uniforms.procPerson.value, row, 1);
  };

  /** Their entry in a piece at `slot`: row, body, wounds and char; the piece's dye, cover or colours. */
  const charred = new Set<ProceduralPerson>();
  const woundedRow = (cls: BodyClass, row: number): boolean => {
    for (let s = 0; s < WOUND_SLOTS; s++) if (cls.personData[row * PERSON_FLOATS + s * 4 + 3]! >= 0) return true;
    return false;
  };
  const writeEntry = (piece: Piece, slot: number, person: ProceduralPerson, st: PersonState): void => {
    const burnt = charred.has(person);
    piece.attrs.get('aPerson')!.setXYZW(slot, person.row, st.variant, woundedRow(st.cls, person.row) ? 1 : 0, burnt ? 1 : 0);
    if (!piece.item) return;
    const dye = st.wears.find((w) => w.item === piece.item)?.dye ?? null;
    // The dye's fourth channel: 1 dyed, past 1.5 burnt (the shader's char).
    piece.attrs.get('aDye')!.setXYZW(slot, dye?.r ?? 1, dye?.g ?? 1, dye?.b ?? 1, (dye ? 1 : 0) + (burnt ? 2 : 0));
    const worn = piece.attrs.get('aWorn');
    if (worn) worn.setXYZW(slot, st.covers[0] ?? -1, st.covers[1] ?? -1, st.covers[2] ?? -1, st.covers[3] ?? -1);
  };
  const place = (piece: Piece, person: ProceduralPerson, st: PersonState): void => {
    if (piece.people.length >= piece.capacity) growPiece(piece);
    const slot = piece.people.length;
    piece.people.push(person);
    st.pieces.push(piece);
    st.slotIn.set(piece, slot);
    writeEntry(piece, slot, person, st);
    piece.dirty = true;
  };
  /** A person's slot in a piece given up: the last slot moved into it. */
  const unplace = (piece: Piece, person: ProceduralPerson): void => {
    const st = states.get(person);
    const slot = st?.slotIn.get(piece);
    if (!st || slot === undefined) return;
    st.slotIn.delete(piece);
    const last = piece.people.length - 1;
    if (slot !== last) {
      const moved = piece.people[last]!;
      piece.people[slot] = moved;
      states.get(moved)?.slotIn.set(piece, slot);
      for (const attr of piece.attrs.values()) {
        const n = attr.itemSize, a = attr.array as Float32Array;
        a.copyWithin(slot * n, last * n, last * n + n);
      }
    }
    piece.people.pop();
    piece.dirty = true;
  };
  /** Drawn at `level` from now on (-1: not drawn). */
  const moveTo = (person: ProceduralPerson, st: PersonState, level: number): void => {
    for (const piece of st.pieces) unplace(piece, person);
    st.pieces.length = 0;
    st.level = level;
    if (level < 0) return;
    // Far: the class's far mesh alone, their hair and their clothes its colours (`zoneColours`).
    if (level === 3) {
      if (st.cls.far) place(st.cls.far, person, st);
      return;
    }
    for (const w of st.wears) {
      const piece = w.item.levels[level];
      if (piece) place(piece, person, st);
    }
  };
  /** Their entries written again (wounded, burnt). */
  const refresh = (person: ProceduralPerson): void => {
    const st = states.get(person);
    if (!st) return;
    for (const piece of st.pieces) {
      const slot = st.slotIn.get(piece);
      if (slot === undefined) continue;
      writeEntry(piece, slot, person, st);
      piece.dirty = true;
    }
  };

  /** Strands close up: a grown hairstyle's strands */
  const NEAR_RANGE = 14;
  /** The nearest people with strands this frame (`update`'s `strands`). */
  let strandPeople = HAIR_STRAND_PEOPLE;
  let strandTexture: DataTexture | null = null;
  /** A strand ribbon's texture: solid across (its edges fade in the shader), root to tip in G. */
  const strandMap = (): DataTexture => {
    if (!strandTexture) {
      const data = new Uint8Array(4 * 64 * 4);
      for (let y = 0; y < 64; y++) for (let x = 0; x < 4; x++) {
        const i = (y * 4 + x) * 4;
        data[i] = 110; data[i + 1] = Math.round(y / 63 * 255); data[i + 2] = 128; data[i + 3] = 255;
      }
      strandTexture = new DataTexture(data, 4, 64, RGBAFormat, UnsignedByteType);
      strandTexture.magFilter = strandTexture.minFilter = NearestFilter;
      strandTexture.needsUpdate = true;
    }
    return strandTexture;
  };
  const strandPieces = new Map<string, Promise<Piece>>();
  const readyStrand = new Map<string, Piece>();
  /** A grown style's strands on a class body: a piece like the cards, filled each frame with the nearest people. */
  const strandPiece = (cls: BodyClass, grownName: string): Promise<Piece> => {
    const key = `${cls.key}/${grownName}`;
    let made = strandPieces.get(key);
    if (!made) {
      made = env.setup().then(async ({ assets: a, morpher: mo }) => {
        const style = HAIR_STYLES[grownName.slice(5)]!;
        const pack = generateHairStrands(style, { positions: mo.base, vertexCount: a.mesh.vertexCount, bodyRange: a.bodyRange,
          joints: a.mesh.joints, weights: a.mesh.weights, boneNames: a.mesh.boneNames, faces: a.mesh.faces });
        const it: ProxyItem = { pack, texture: null, transparent: true, textureFile: null };
        const fitted = await cls.fit(it);
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(fitted.positions, 3));
        geometry.setAttribute('uv', new BufferAttribute(pack.uvs!, 2));
        geometry.setAttribute('skinIndex', new BufferAttribute(fitted.joints, 4));
        geometry.setAttribute('skinWeight', new BufferAttribute(fitted.weights, 4));
        geometry.setAttribute('aRefs', new BufferAttribute(Float32Array.from(pack.refs), 3));
        geometry.setAttribute('aRefW', new BufferAttribute(pack.weights, 3));
        geometry.setAttribute('aFade', new BufferAttribute(pack.fade!, 1));
        geometry.setIndex(new BufferAttribute(pack.index, 1));
        geometry.computeVertexNormals();
        const v: Variant = { kind: 'hair', level: 0, widen: false, grown: true, lash: false };
        const piece = makePiece(cls, null, v, geometry, pieceMaterial(cls, v, strandMap(), null, 1), ENTRIES, null, null, pack.index.length / 3);
        piece.mesh.name = `${cls.key}/strands-${grownName}`;
        // Not one of the class's pieces: filled by `strandsUpdate` alone.
        cls.pieces.splice(cls.pieces.indexOf(piece), 1);
        readyStrand.set(key, piece);
        return piece;
      });
      strandPieces.set(key, made);
    }
    return made;
  };
  const shown = new Set<Piece>();
  /** The nearest people this frame and the strand pieces they want: DO NOT make an entry, a map or a list a frame (the entries are reused, `nearPool`). */
  const near: { p: ProceduralPerson; d: number }[] = [];
  const nearPool: { p: ProceduralPerson; d: number }[] = [];
  const wanted = new Set<Piece>();
  const byDistance = (a: { d: number }, b: { d: number }): number => a.d - b.d;
  const at3 = new Vector3();
  const strandsUpdate = (eye: Vector3): void => {
    near.length = 0;
    const range = NEAR_RANGE * (options.unit ?? 1);
    for (const p of people) {
      const st = p.grown ? states.get(p) : undefined;
      // Only the close levels: further away the strands are under a pixel.
      if (!st || st.level < 0 || st.level > 1) continue;
      const d = eye.distanceTo(at3.setFromMatrixPosition(p.matrix));
      if (d >= range) continue;
      const entry = nearPool[near.length] ??= { p, d };
      entry.p = p; entry.d = d;
      near.push(entry);
    }
    near.sort(byDistance);
    if (near.length > strandPeople) near.length = strandPeople;
    wanted.clear();
    for (const piece of shown) piece.people.length = 0;
    for (const { p } of near) {
      const cls = states.get(p)!.cls;
      const piece = readyStrand.get(`${cls.key}/${p.grown}`);
      if (!piece) { void strandPiece(cls, p.grown!); continue; }
      if (!wanted.has(piece)) { wanted.add(piece); piece.people.length = 0; }
      piece.people.push(p);
    }
    for (const piece of shown) if (!wanted.has(piece)) { piece.mesh.count = 0; piece.mesh.visible = false; }
    shown.clear();
    for (const piece of wanted) {
      const list = piece.people;
      while (piece.capacity < list.length) growPiece(piece);
      for (let slot = 0; slot < list.length; slot++) {
        const person = list[slot]!;
        const st = states.get(person)!;
        const burnt = charred.has(person);
        piece.attrs.get('aPerson')!.setXYZW(slot, person.row, st.variant, woundedRow(st.cls, person.row) ? 1 : 0, burnt ? 1 : 0);
        piece.attrs.get('aDye')!.setXYZW(slot, person.hairColour.r, person.hairColour.g, person.hairColour.b, burnt ? 3 : 1);
      }
      upload(piece, true);
      shown.add(piece);
    }
  };

  /** A piece's frame to the GPU: its count, and its entries when they changed - only the written part (the people's places are their class's, `procPlaces`). */
  const upload = (piece: Piece, entries: boolean): void => {
    const n = piece.people.length;
    piece.mesh.count = n;
    piece.mesh.visible = n > 0;
    if (!n || !entries) return;
    for (const attr of piece.attrs.values()) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * attr.itemSize);
      attr.needsUpdate = true;
    }
  };

  /** Bullets' jolts running (`jolt`): when, about which axis (model space), how hard (radians). */
  const jolts = new Map<ProceduralPerson, { start: number; axis: Vector3; strength: number }>();
  const joltRot = new Matrix4(), joltDir = new Vector3();
  const joltSpine = new Map<BodyClass, { root: number; bind: Vector3; bones: number[] } | null>();
  const joltM = new Matrix4(), joltT = new Matrix4(), joltP = new Vector3(), joltBack = new Matrix4(), joltBone = new Matrix4();
  /** A wounded body's posture over its clip (Euphoria's reach-for-wound and a body guarding a wound) */
  interface Posture { hunch: number; reach: number; part: BodyPart; cover?: number; miss?: number; hand?: 'L' | 'R' }
  const postures = new Map<ProceduralPerson, Posture>();
  interface PostureRig {
    spine: number; spineBind: Vector3; upper: number[];
    forward: Vector3; up: Vector3;
    arm: Record<'L' | 'R', { shoulder: number; elbow: number; hand: number; upperSet: number[]; foreSet: number[]; bind: [Vector3, Vector3, Vector3] } | null>;
    pelvis: number; chest: number; head: number; thigh: Record<'L' | 'R', number>; left: Vector3;
    bindOf: (i: number) => Vector3;
  }
  const postureRigs = new Map<BodyClass, PostureRig | null>();
  const postureRig = (cls: BodyClass): PostureRig | null => {
    let rig = postureRigs.get(cls);
    if (rig !== undefined) return rig;
    const bones = cls.rig.mesh.skeleton.bones;
    const name = (i: number): string => CAPTURE_NAME[bones[i]!.name] ?? bones[i]!.name;
    const find = (n: string): number => bones.findIndex((_, i) => name(i) === n);
    const parents = bones.map((b) => bones.indexOf(b.parent as never));
    const subtree = (root: number): number[] => {
      const out: number[] = [];
      for (let i = 0; i < bones.length; i++) { let j = i; while (j >= 0 && j !== root) j = parents[j]!; if (j === root) out.push(i); }
      return out;
    };
    const bindOf = (i: number): Vector3 => new Vector3().setFromMatrixPosition(new Matrix4().copy(cls.rig.mesh.skeleton.boneInverses[i]!).invert());
    const spine = find('Bip01_Spine'), pelvis = find('Bip01_Pelvis'), chest = find('Bip01_Spine2');
    const foot = find('Bip01_L_Foot'), toe = find('Bip01_L_Toe0');
    if (spine < 0 || pelvis < 0 || chest < 0 || foot < 0 || toe < 0) { postureRigs.set(cls, null); return null; }
    const forward = bindOf(toe).sub(bindOf(foot)).setY(0).normalize();
    const up = bindOf(chest).sub(bindOf(pelvis)).normalize();
    const arm = (side: 'L' | 'R') => {
      const shoulder = find(`Bip01_${side}_UpperArm`), elbow = find(`Bip01_${side}_Forearm`), hand = find(`Bip01_${side}_Hand`);
      if (shoulder < 0 || elbow < 0 || hand < 0) return null;
      return { shoulder, elbow, hand, upperSet: subtree(shoulder), foreSet: subtree(elbow), bind: [bindOf(shoulder), bindOf(elbow), bindOf(hand)] as [Vector3, Vector3, Vector3] };
    };
    rig = {
      spine, spineBind: bindOf(spine), upper: subtree(spine), forward, up, arm: { L: arm('L'), R: arm('R') },
      pelvis, chest, head: find('Bip01_Head'), thigh: { L: find('Bip01_L_Thigh'), R: find('Bip01_R_Thigh') },
      left: (() => { const l = find('Bip01_L_UpperArm'), r = find('Bip01_R_UpperArm'); return l >= 0 && r >= 0 ? bindOf(l).sub(bindOf(r)).setY(0).normalize() : new Vector3(1, 0, 0); })(),
      bindOf,
    };
    postureRigs.set(cls, rig);
    return rig;
  };
  const pM = new Matrix4(), pT = new Matrix4(), pR = new Matrix4(), pQ = new Quaternion(), pA = new Vector3(), pB = new Vector3(), pC = new Vector3(), pD = new Vector3();
  // DO NOT make the posture's points anew for every person every frame (25-30 objects each, a crowd in panic posed here: AGT-21): one each, by its part, never two parts in one.
  const postureHead = new Vector3(), postureUp = new Vector3(), postureLat = new Vector3(), postureTarget = new Vector3(), postureTmp = new Vector3(), postureAlong = new Vector3(), postureFwd = new Vector3();
  const reachFwd = new Vector3(), reachS = new Vector3(), reachE = new Vector3(), reachH = new Vector3(), reachT = new Vector3(), reachA = new Vector3(), reachB = new Vector3();
  const reachN = new Vector3(), reachH2 = new Vector3(), reachTS = new Vector3(), reachEnd = new Vector3();
  /** Where a joint (bind point `bind`) is in the posed row `at`, bone `i`. */
  const posed = (cls: BodyClass, at: number, i: number, bind: Vector3, out: Vector3): Vector3 =>
    out.copy(bind).applyMatrix4(pM.fromArray(cls.palette, at + i * SKIN_BONE_FLOATS));
  /** Every bone of `set` turned by `rot` about point `p`, in the row `at`. */
  const turnAbout = (cls: BodyClass, at: number, set: readonly number[], p: Vector3, rot: Matrix4): void => {
    pT.makeTranslation(p.x, p.y, p.z).multiply(rot).multiply(pR.makeTranslation(-p.x, -p.y, -p.z));
    for (const i of set) {
      const o = at + i * SKIN_BONE_FLOATS;
      pM.fromArray(cls.palette, o).premultiply(pT).toArray(cls.palette, o);
    }
  };
  const applyPosture = (cls: BodyClass, at: number, pose: Posture): void => {
    const rig = postureRig(cls);
    if (!rig) return;
    // Bent over: the upper body tipped forward about the lower spine.
    if (pose.hunch > 1e-3) {
      const p = posed(cls, at, rig.spine, rig.spineBind, pA);
      turnAbout(cls, at, rig.upper, p, pR.makeRotationAxis(pB.crossVectors(rig.up, rig.forward).normalize(), pose.hunch));
    }
    // Both hands over the head (somebody under fire, running or crouched: GTA's peds flee and cower so)
    if ((pose.cover ?? 0) > 1e-3 && rig.head >= 0) {
      const pelvis = posed(cls, at, rig.pelvis, rig.bindOf(rig.pelvis), pC);
      const chest = posed(cls, at, rig.chest, rig.bindOf(rig.chest), pD);
      const torsoLen = chest.distanceTo(pelvis);
      const head = posed(cls, at, rig.head, rig.bindOf(rig.head), postureHead);
      const up = postureUp.copy(chest).sub(pelvis).normalize();
      for (const side of ['L', 'R'] as const) {
        const arm = rig.arm[side];
        if (!arm) continue;
        const lateral = posed(cls, at, arm.shoulder, arm.bind[0], postureLat).sub(chest).setY(0).normalize();
        // The wrist beside the crown, a little above the ear: the hand over the top of the head.
        const target = postureTarget.copy(head).addScaledVector(up, torsoLen * 0.32).addScaledVector(lateral, torsoLen * 0.2);
        reachTo(cls, at, rig, arm, target, pose.cover!);
      }
      return;
    }
    if (pose.reach < 1e-3) return;
    // The hand on the wound: the other hand when an arm is hit; for the trunk, the right
    const side: 'L' | 'R' = pose.part === 'armR' ? 'L' : pose.part === 'armL' ? 'R' : pose.part === 'legL' ? 'L' : 'R';
    const arm = rig.arm[side];
    if (!arm) return;
    const pelvis = posed(cls, at, rig.pelvis, rig.bindOf(rig.pelvis), pC);
    const chest = posed(cls, at, rig.chest, rig.bindOf(rig.chest), pD);
    const along = postureAlong.copy(chest).sub(pelvis);
    const torsoLen = along.length();
    const fwd = postureFwd.copy(rig.forward);
    // The posed forward: the bind forward carried by the chest's turn.
    pM.fromArray(cls.palette, at + rig.chest * SKIN_BONE_FLOATS);
    fwd.transformDirection(pM).setY(0).normalize();
    let target: Vector3;
    if (pose.part === 'legL' || pose.part === 'legR') {
      const thigh = rig.thigh[pose.part === 'legL' ? 'L' : 'R'];
      target = thigh >= 0 ? posed(cls, at, thigh, rig.bindOf(thigh), postureTarget).addScaledVector(fwd, torsoLen * 0.35).addScaledVector(rig.up, -torsoLen * 0.4) : postureTarget.copy(pelvis);
    } else if (pose.part === 'armL' || pose.part === 'armR') {
      const other = rig.arm[pose.part === 'armL' ? 'L' : 'R'];
      // The wrist at the middle of the hurt upper arm, in front of it and a little in from it
      target = other ? posed(cls, at, other.shoulder, other.bind[0], postureTarget).lerp(posed(cls, at, other.elbow, other.bind[1], postureTmp), 0.6) : postureTarget.copy(chest);
      target.addScaledVector(fwd, torsoLen * 0.2).lerp(chest, 0.22);
    } else {
      // Belly or chest, a hand's breadth in front of the trunk, towards the hand's own side a little.
      target = postureTarget.copy(pelvis).addScaledVector(along, pose.part === 'head' ? 1.15 : 0.45).addScaledVector(fwd, torsoLen * 0.42);
      const lateral = posed(cls, at, arm.shoulder, arm.bind[0], postureLat).sub(chest).setY(0);
      target.addScaledVector(lateral, 0.25);
    }
    // How far the hand ended from where it was sent, against the arm's length (for probes).
    pose.miss = reachTo(cls, at, rig, arm, target, pose.reach);
    pose.hand = side;
  };

  type PostureArm = NonNullable<PostureRig['arm']['L']>;
  /** One arm's hand sent towards `target` by `weight` (0..1), a two-bone solve */
  const reachTo = (cls: BodyClass, at: number, rig: PostureRig, arm: PostureArm, target: Vector3, weight: number): number => {
    const fwd = reachFwd.copy(rig.forward);
    pM.fromArray(cls.palette, at + rig.chest * SKIN_BONE_FLOATS);
    fwd.transformDirection(pM).setY(0).normalize();
    const S = posed(cls, at, arm.shoulder, arm.bind[0], reachS);
    const E = posed(cls, at, arm.elbow, arm.bind[1], reachE);
    const H = posed(cls, at, arm.hand, arm.bind[2], reachH);
    const T = reachT.copy(H).lerp(target, weight);
    const l1 = E.distanceTo(S), l2 = H.distanceTo(E);
    const d = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-4, T.distanceTo(S)));
    // The elbow's angle for that reach.
    const want = Math.acos(Math.min(1, Math.max(-1, (l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2))));
    const a = reachA.copy(S).sub(E), b = reachB.copy(H).sub(E);
    const now = a.angleTo(b);
    // The elbow bends in the arm's natural plane, the forearm coming forward
    const n = reachN.crossVectors(a, fwd);
    if (n.lengthSq() < 1e-10) n.crossVectors(a, b);
    n.normalize();
    turnAbout(cls, at, arm.foreSet, E, pR.makeRotationAxis(n, want - now));
    // Then the arm turned at the shoulder so the hand comes onto the target.
    const H2 = posed(cls, at, arm.hand, arm.bind[2], reachH2);
    pQ.setFromUnitVectors(H2.sub(S).normalize(), reachTS.copy(T).sub(S).normalize());
    turnAbout(cls, at, arm.upperSet, S, pR.makeRotationFromQuaternion(pQ));
    return posed(cls, at, arm.hand, arm.bind[2], reachEnd).distanceTo(T) / (l1 + l2);
  };

  /** The upper body turned about the lower spine by `angle`, in a palette row at `at`. */
  const applyJolt = (cls: BodyClass, at: number, axis: Vector3, angle: number): void => {
    let spine = joltSpine.get(cls);
    if (spine === undefined) {
      const bones = cls.rig.mesh.skeleton.bones;
      const root = bones.findIndex((b) => (CAPTURE_NAME[b.name] ?? b.name) === 'Bip01_Spine');
      if (root < 0) spine = null;
      else {
        const parents = bones.map((b) => bones.indexOf(b.parent as never));
        const list: number[] = [];
        for (let i = 0; i < bones.length; i++) { let j = i; while (j >= 0 && j !== root) j = parents[j]!; if (j === root) list.push(i); }
        spine = { root, bind: new Vector3().setFromMatrixPosition(joltM.copy(cls.rig.mesh.skeleton.boneInverses[root]!).invert()), bones: list };
      }
      joltSpine.set(cls, spine);
    }
    if (!spine || Math.abs(angle) < 1e-4) return;
    const px = cls.palette;
    joltM.fromArray(px, at + spine.root * SKIN_BONE_FLOATS);
    joltP.copy(spine.bind).applyMatrix4(joltM);
    // T(p) R T(-p), before each upper-body bone's own matrix.
    joltT.makeTranslation(joltP.x, joltP.y, joltP.z).multiply(joltM.makeRotationAxis(axis, angle)).multiply(joltBack.makeTranslation(-joltP.x, -joltP.y, -joltP.z));
    const bone = joltBone;
    for (const i of spine.bones) {
      const o = at + i * SKIN_BONE_FLOATS;
      bone.fromArray(px, o).premultiply(joltT).toArray(px, o);
    }
  };

  /** Whether a person's palette is worked out here this frame rather than by the GPU pass. */
  const overridden = (person: ProceduralPerson): boolean =>
    holds.has(person) || postures.has(person) || jolts.has(person) || (person.lost?.length ?? 0) > 0;
  /** A person's palette row worked out here: held by a ragdoll */
  const poseRow = (cls: BodyClass, person: ProceduralPerson, at: number, time: number): void => {
    const width = cls.bones * SKIN_BONE_FLOATS;
    const held = holds.get(person);
    if (held && held.length === width) {
      cls.palette.set(held, at);
      for (const limb of person.lost ?? []) closeLimb(cls, at, limb);
      return;
    }
    const packed = cls.bones * PACKED_BONE_FLOATS;
    const clip = cls.clips[person.clip];
    const f = (person.phase - Math.floor(person.phase)) * clip.frames;
    const whole = Math.min(clip.frames, Math.floor(f));
    cls.palette.fill(0, at, at + width);
    blendPackedFrames(cls.palette, at, clip.data, whole * packed, packed, cls.bones, 1 - (f - whole), f - whole);
    refit(cls, person, at);
    for (const limb of person.lost ?? []) closeLimb(cls, at, limb);
    const pose = postures.get(person);
    if (pose) applyPosture(cls, at, pose);
    const jolt = jolts.get(person);
    if (jolt) {
      const age = time - jolt.start;
      if (age > 0.7 || age < 0) jolts.delete(person);
      else applyJolt(cls, at, jolt.axis, jolt.strength * (age < 0.07 ? age / 0.07 : Math.exp(-(age - 0.07) / 0.16)));
    }
  };

  /** Rows given back (`untwin`: twins, and spare bodies let go), for the next body or twin. */
  const spareRows = new Map<BodyClass, number[]>();
  const charSlots = (person: ProceduralPerson, on: boolean): void => {
    if (on) charred.add(person); else charred.delete(person);
    refresh(person);
  };

  /** A row of a class for a person (a spare one first when `spare`). */
  const takeRow = (cls: BodyClass, spare: boolean): number => {
    const free = spare ? spareRows.get(cls) : undefined;
    if (free?.length) return free.pop()!;
    if (cls.rows >= cls.capacity) growRows(cls);
    return cls.rows++;
  };

  /** What the people's worker reads of a class to work out a face (`PersonFaceJob`): its body's posture and face vertices, shared once; null where memory is not shared. */
  const faceShares = new Map<BodyClass, Pick<PersonFaceJob, 'deltas' | 'faceVerts' | 'faceFloats'> | null>();
  const faceShare = (cls: BodyClass): Pick<PersonFaceJob, 'deltas' | 'faceVerts' | 'faceFloats'> | null => {
    let share = faceShares.get(cls);
    if (share !== undefined) return share;
    // DO NOT copy the class's posture for the worker: a class made there has it shared already, its only copy (`rigFromMade`); one made here is not sent (its rig's own closures hold it).
    const d = cls.rig.deltasData;
    const sharedAlready = !!d && d.positions.buffer instanceof SharedArrayBuffer && d.linear.buffer instanceof SharedArrayBuffer && cls.faceVerts.buffer instanceof SharedArrayBuffer;
    share = sharedAlready ? { deltas: d, faceVerts: cls.faceVerts, faceFloats: cls.uniforms.procFaceRows.value * FACE_WIDTH * 4 } : null;
    faceShares.set(cls, share);
    return share;
  };
  /** Row `row`'s face as worked out in the worker (null: none, zero moves), sent up at the next flush. */
  const writeFace = (cls: BodyClass, row: number, features: Readonly<Record<string, number>> | null, face: Float32Array | null): void => {
    const faceRows = cls.uniforms.procFaceRows.value;
    cls.faceOf[row] = features;
    cls.faces.write(cls.uniforms.procFaceHead.value + row * faceRows, face ?? new Float32Array(faceRows * FACE_WIDTH * 4));
  };
  /** Row `row`'s own face: the regional sliders on the class body, posed as it is (zero: none), sent up at the next flush. */
  const setFace = (cls: BodyClass, row: number, features: Readonly<Record<string, number>> | null): void => {
    const faceRows = cls.uniforms.procFaceRows.value;
    const face = new Float32Array(faceRows * FACE_WIDTH * 4);
    const mo = env.loaded?.morpher;
    if (features && mo) {
      const offset = new Float32Array(mo.vertexCount * 3);
      mo.addRegional(offset, features);
      const moved = cls.rig.deltasAt!(offset, cls.faceVerts);
      for (let i = 0; i < cls.faceVerts.length; i++) {
        face[i * 4] = moved[i * 3]!;
        face[i * 4 + 1] = moved[i * 3 + 1]!;
        face[i * 4 + 2] = moved[i * 3 + 2]!;
      }
    }
    cls.faceOf[row] = features;
    cls.faces.write(cls.uniforms.procFaceHead.value + row * faceRows, face);
  };

  /** The GPU's copies made again after a WebGL context restored: what each class let go (atlas, bodies, faces) rebuilt. */
  let restoreHooked = false;
  const restore = (): void => {
    for (const cls of ready) {
      cls.anim.refill();
      cls.bodies.restore();
      cls.faces.reset();
      for (let r = 0; r < cls.rows; r++) setFace(cls, r, cls.faceOf[r] ?? null);
      void cls.reloadHead().then((head) => cls.faces.write(0, head), () => {});
    }
  };

  const play = { row: 0, t: 0, weight: 1 };
  const plays = [play];
  /** The clip being left in a cross-fade (`ProceduralPerson.fade`), played under `play`. */
  const leaving = { row: 0, t: 0, weight: 0 };
  const fading = [play, leaving];
  const close: ProceduralPerson[] = [];

  return {
    group,
    people,
    async add(spec) {
      const started = epoch;
      const { morpher: mo, assets: a } = await env.setup();
      const years = yearsFromAge(spec.body.age);
      const band = bandOf(years);
      const sex: WalkSex = spec.body.gender < 0.5 ? 'female' : 'male';
      const cls = await classFor(sex, band);
      const look = proceduralLook(spec, options.hair !== false);
      const names = wornItems(look).filter((nm) => nm !== 'eyes');
      const loaded = await Promise.all(names.map((nm) => item(nm).then((it) => [nm, it] as const, () => null)));
      const worn = loaded.filter((x): x is readonly [string, ProxyItem] => !!x);
      const skin = await skinItem(cls, spec);
      const pieces = await Promise.all(worn.map(([nm, it]) => wornItem(cls, nm, roleOf(nm, it, look))));
      // Shown only with every piece's shaders built: no frame waits for a compile.
      await Promise.all([skin.ready, ...pieces.map((pc) => pc.ready)]);
      await breathe();
      if (epoch !== started) throw new Error('crowd cleared');
      // DO NOT take a new row for every body made
      const row = takeRow(cls, true);
      // Their shape on the class body: their sliders at the class's height
      const level = { ...spec.body, height: cls.base.height };
      const c = mo.coefficients(level);
      const coef = new Float32Array(SHAPES);
      for (let k = 0; k < SHAPES; k++) coef[k] = (c[k] ?? 0) - (cls.coefficients[k] ?? 0);
      const body = cls.bodies.pick(coef);
      // Shown only with their body's vertices written (a new body is baked in a worker).
      await body.ready;
      if (epoch !== started) throw new Error('crowd cleared');
      // Their heights (from the vertices' Y alone, MakeHuman's `getHeightCm`) and their own face: worked out on the people's worker; here where none can.
      const features = Object.keys(spec.features).length ? spec.features : null;
      const share = faceShare(cls);
      const worked = share ? await personFaceInWorker({ body: spec.body, features: features ?? {}, classHeight: cls.base.height, ...share }) : null;
      if (epoch !== started) throw new Error('crowd cleared');
      // A reused row holds the last person's face: theirs replaces it, or none.
      if (worked) writeFace(cls, row, features, worked.face);
      else setFace(cls, row, features);
      const tall = worked ? worked.tall : mo.height(spec.body, a.bodyRange);
      const level0 = worked ? worked.level0 : mo.height(level, a.bodyRange);
      const scale = tall / Math.max(1e-3, level0);
      const person: ProceduralPerson = {
        spec, band, sex, row, scale, height: tall / 10, items: worn.map(([nm]) => nm),
        grown: worn.find(([nm]) => nm.startsWith('hair:'))?.[0] ?? null, hairColour: new Color(spec.look.hair),
        matrix: new Matrix4(), clip: 'walk', phase: 0, joints: body.joints,
      };
      const covers = worn.filter(([nm, it]) => COVERING.has(it.pack.kind) && !it.transparent && !nm.startsWith('acc:'))
        .map(([nm, it]) => coverRow(cls, nm, it)).slice(0, 4);
      const hair = new Color(spec.look.hair);
      // The outfit itself is dyed, never its shoes or glasses; hair, brows and lashes take the hair colour.
      const tint = look.outfitTint == null ? null : new Color(look.outfitTint);
      const skinTint = bareSkin(spec).tint;
      const wears: Wear[] = [{ item: skin, dye: skinTint }];
      pieces.forEach((piece, i) => {
        const kind = piece.kind;
        // A generated accessory takes a colour of the street's, never the outfit's own.
        const itemName = worn[i]![0];
        const accessory = itemName === 'acc:teeth' ? new Color(0.86, 0.83, 0.74)
          : itemName === 'acc:tongue' ? new Color(0.62, 0.3, 0.3)
          : itemName.startsWith('acc:') ? new Color(ACCESSORY_COLOURS[(spec.id * 7 + i) % ACCESSORY_COLOURS.length]!) : null;
        const dye = kind === 'hair' || kind === 'face' ? hair : accessory ?? (itemName === look.outfit ? tint : null);
        wears.push({ item: piece, dye });
      });
      // Their colours on the far mesh's zones: their skin, their hair, the clothes over them.
      const hairItem = pieces.find((p) => p.kind === 'hair' && p.role === 'hair');
      const hairFar = hairItem ? (hairItem.name.startsWith('hair:') ? hair.clone().multiplyScalar(0.85) : farColour(hairItem.colour, hair)) : null;
      zoneColours(cls, row, skin.colour.clone().multiply(skinTint), hairFar, wears.slice(1).map((wear, i) => ({ wear, pack: worn[i]![1] })));
      states.set(person, {
        cls, coef, variant: body.index, wears, covers, level: -1, want: -1, pieces: [], slotIn: new Map(), drawn: new Matrix4(),
      });
      cls.people.push(person);
      people.push(person);
      return person;
    },
    ragdoll: {
      skeleton(person) {
        const cls = classOf(person);
        if (!cls) return null;
        const mesh = cls.rig.mesh;
        const bones = mesh.skeleton.bones;
        // Each bone's bind moved to this person's own joint (`joints`, the offsets `refit` places them by)
        const d = person.joints;
        const shiftBy = new Matrix4();
        return {
          names: bones.map((b) => CAPTURE_NAME[b.name] ?? b.name),
          parents: bones.map((b) => bones.indexOf(b.parent as never)),
          inverses: mesh.skeleton.boneInverses.map((inv, i) => inv.clone().multiply(shiftBy.makeTranslation(-d[i * 3]!, -d[i * 3 + 1]!, -d[i * 3 + 2]!))),
          local: new Matrix4(),
          bind: mesh.bindMatrix,
        };
      },
      pose(person) {
        const cls = classOf(person);
        if (!cls) return null;
        const width = cls.bones * SKIN_BONE_FLOATS;
        const at = person.row * width;
        // Worked out now, as the frame draws it.
        poseRow(cls, person, at, cls.uniforms.procTime.value);
        return cls.palette.slice(at, at + width);
      },
      standing(person, phase, which = 'idle') {
        const cls = classOf(person);
        if (!cls) return null;
        const width = cls.bones * SKIN_BONE_FLOATS, packed = cls.bones * PACKED_BONE_FLOATS;
        const at = person.row * width;
        // Worked out in their own row (their proportions, `refit`), then copied out.
        const keep = cls.palette.slice(at, at + width);
        const clip = cls.clips[which];
        const f = (which === 'idle' ? phase - Math.floor(phase) : Math.min(0.999, Math.max(0, phase))) * clip.frames;
        const whole = Math.min(clip.frames, Math.floor(f));
        cls.palette.fill(0, at, at + width);
        blendPackedFrames(cls.palette, at, clip.data, whole * packed, packed, cls.bones, 1 - (f - whole), f - whole);
        refit(cls, person, at);
        const out = cls.palette.slice(at, at + width);
        cls.palette.set(keep, at);
        return out;
      },
      hold(person, palette) {
        if (palette) holds.set(person, palette.slice());
        else { holds.delete(person); if (charred.has(person)) charSlots(person, false); }
      },
      twin(person) {
        const cls = classOf(person);
        const st = states.get(person);
        if (!cls || !st) return null;
        const row = takeRow(cls, true);
        const faceRows = cls.uniforms.procFaceRows.value;
        // Their face copied on the GPU (`gpuRows.ts`), and what it was made from, for a restore.
        const head = cls.uniforms.procFaceHead.value;
        cls.faces.copy(head + person.row * faceRows, head + row * faceRows, faceRows);
        cls.faceOf[row] = cls.faceOf[person.row] ?? null;
        // Their wounds; DO NOT send the whole texture: its rows also carry the faces' expressions, sent a row at a time
        cls.personData.copyWithin(row * PERSON_FLOATS, person.row * PERSON_FLOATS, person.row * PERSON_FLOATS + EXPR_AT);
        // And their far colours (`zoneColours`): the twin far away in their clothes.
        cls.personData.copyWithin(row * PERSON_FLOATS + ZONE_AT, person.row * PERSON_FLOATS + ZONE_AT, (person.row + 1) * PERSON_FLOATS);
        touchRows(cls.uniforms.procPerson.value, row, 1);
        const twin: ProceduralPerson = { ...person, row, matrix: new Matrix4().makeScale(0, 0, 0), clip: 'idle', phase: 0, activity: undefined, lost: undefined };
        states.set(twin, { ...st, level: -1, want: -1, pieces: [], slotIn: new Map(), drawn: new Matrix4() });
        cls.people.push(twin);
        people.push(twin);
        return twin;
      },
      untwin(twin) {
        const cls = classOf(twin);
        const st = states.get(twin);
        if (!cls || !st) return;
        for (const piece of st.pieces) unplace(piece, twin);
        // Out of the strands drawn: their list kept (`strandsUpdate` fills it again each frame).
        for (const piece of shown) {
          const at = piece.people.indexOf(twin);
          if (at >= 0) piece.people.splice(at, 1);
        }
        states.delete(twin);
        cls.people.splice(cls.people.indexOf(twin), 1);
        const i = people.indexOf(twin);
        if (i >= 0) people.splice(i, 1);
        holds.delete(twin);
        charred.delete(twin);
        postures.delete(twin);
        jolts.delete(twin);
        cls.personData.fill(-1, twin.row * PERSON_FLOATS, twin.row * PERSON_FLOATS + EXPR_AT);
        touchRows(cls.uniforms.procPerson.value, twin.row, 1);
        cls.pass.rest(twin.row);
        const spare = spareRows.get(cls) ?? [];
        spare.push(twin.row);
        spareRows.set(cls, spare);
      },
      char(person, on) { charSlots(person, on); },
      duration(person, clip) { return classOf(person)?.clips[clip].duration ?? 1.2; },
      posture(person, pose) {
        const was = postures.get(person);
        if (pose) postures.set(person, { ...pose, ...(was?.miss !== undefined ? { miss: was.miss, hand: was.hand } : {}) }); else postures.delete(person);
      },
      layers(person) {
        const j = jolts.get(person);
        const p = postures.get(person);
        const own = p ? [`posture hunch ${p.hunch.toFixed(2)} rad, ${p.hand ?? '?'} hand ${p.reach.toFixed(2)} on ${p.part}, miss ${((p.miss ?? 0) * 100).toFixed(0)}%`] : [];
        if (!j) return own;
        const cls = classOf(person);
        const age = (cls?.uniforms.procTime.value ?? 0) - j.start;
        return [...own, `jolt ${(j.strength * (age < 0.07 ? age / 0.07 : Math.exp(-(age - 0.07) / 0.16))).toFixed(2)} rad`];
      },
      jolt(person, dirX, dirY, strength) {
        const cls = classOf(person);
        if (!cls) return;
        // The world direction into the person's own (model) frame.
        joltRot.extractRotation(person.matrix).invert();
        const d = joltDir.set(dirX, 0, -dirY).applyMatrix4(joltRot).setY(0);
        if (d.lengthSq() < 1e-9) return;
        d.normalize();
        // Turning the upright towards the shot's way: about up x way.
        const axis = new Vector3(0, 1, 0).cross(d).normalize();
        jolts.set(person, { start: cls.uniforms.procTime.value, axis, strength });
      },
      wound(person, part) {
        const cls = classOf(person);
        if (!cls) return;
        const spots = woundSpots(cls)[part];
        if (!spots.length) return;
        const v = spots[Math.floor(Math.random() * spots.length)]!;
        const pos = cls.rig.mesh.geometry.getAttribute('position');
        const at = person.row * PERSON_FLOATS;
        let slot = 0;
        while (slot < WOUND_SLOTS && cls.personData[at + slot * 4 + 3]! >= 0) slot++;
        if (slot === WOUND_SLOTS) slot = 1 + Math.floor(Math.random() * (WOUND_SLOTS - 1));
        cls.personData.set([pos.getX(v), pos.getY(v), pos.getZ(v), cls.uniforms.procTime.value], at + slot * 4);
        touchRows(cls.uniforms.procPerson.value, person.row, 1);
        refresh(person);
      },
      drench(person) {
        const cls = classOf(person);
        if (!cls) return;
        const spots = woundSpots(cls).torso;
        const pos = cls.rig.mesh.geometry.getAttribute('position');
        const at = person.row * PERSON_FLOATS;
        for (let slot = 0; slot < 3 && spots.length; slot++) {
          const v = spots[Math.floor(Math.random() * spots.length)]!;
          cls.personData.set([pos.getX(v), pos.getY(v), pos.getZ(v), cls.uniforms.procTime.value - 30 + 2e8], at + (WOUND_SLOTS - 1 - slot) * 4);
        }
        touchRows(cls.uniforms.procPerson.value, person.row, 1);
        refresh(person);
      },
      heal(person) {
        const cls = classOf(person);
        if (!cls) return;
        cls.personData.fill(-1, person.row * PERSON_FLOATS, person.row * PERSON_FLOATS + EXPR_AT);
        touchRows(cls.uniforms.procPerson.value, person.row, 1);
        refresh(person);
      },
    },
    update(eye, simTime, shadows = true, strands = HAIR_STRAND_PEOPLE) {
      strandPeople = strands;
      const time = simTime ?? performance.now() / 1000;
      levelCount.fill(0);
      trianglesDrawn = 0;
      castedLast = castingNow;
      castingNow = false;
      // Each person's level from their height on the screen: hidden (a zero scale) or too small, none.
      close.length = 0;
      let close0 = 0, close1 = 0;
      for (const cls of ready) {
        for (const person of cls.people) {
          const st = states.get(person)!;
          const e = person.matrix.elements;
          const hidden = e[0] === 0 && e[1] === 0 && e[2] === 0;
          let level = hidden ? -1 : levelFor(person.pixels ?? Infinity, st.level);
          // Their far mesh not made yet: a level closer meanwhile.
          if (level === 3 && !cls.far) level = 2;
          st.want = level;
          // Somebody not measured (the people lab) is drawn in full, outside the caps.
          if (person.pixels === undefined) continue;
          if (level === 0) close0++;
          if (level === 1) close1++;
          if (level === 0 || level === 1) close.push(person);
        }
      }
      // The safety caps (a street-level camera in a packed square): past them, those smallest on the screen go a level down.
      if (close0 > LEVEL_CAPS[0] || close1 > LEVEL_CAPS[1]) {
        close.sort((p, q) => (q.pixels ?? 0) - (p.pixels ?? 0));
        let n0 = 0, n1 = 0;
        for (const person of close) {
          const st = states.get(person)!;
          if (st.want === 0) { if (n0 < LEVEL_CAPS[0]) n0++; else st.want = 1; }
          if (st.want === 1) { if (n1 < LEVEL_CAPS[1]) n1++; else st.want = 2; }
        }
      }
      blobs.begin();
      for (const cls of ready) {
        cls.uniforms.procTime.value = time;
        cls.drawn = 0;
        const width = cls.bones * SKIN_BONE_FLOATS;
        for (const person of cls.people) {
          const st = states.get(person)!;
          if (st.want !== st.level) moveTo(person, st, st.want);
          if (st.level < 0) { cls.pass.rest(person.row); continue; }
          cls.drawn++;
          levelCount[st.level] = (levelCount[st.level] ?? 0) + 1;
          st.drawn.multiplyMatrices(person.matrix, scaled.makeScale(person.scale, person.scale, person.scale));
          // Their place once, in their row: every piece they are in reads it there.
          cls.personData.set(st.drawn.elements, person.row * PERSON_FLOATS + PLACE_AT);
          cls.placed.push(person.row);
          // Their skeleton: the GPU pass plays their clip on their joints; somebody held, bent, jolted or maimed is worked out here.
          if (overridden(person)) {
            const at = person.row * width;
            poseRow(cls, person, at, time);
            cls.pass.setOverride(person.row, cls.palette.subarray(at, at + width));
            cls.pass.setPlays(person.row, null, st.variant);
          } else {
            const clip = cls.clips[person.clip];
            const f = (person.phase - Math.floor(person.phase)) * clip.frames;
            const whole = Math.min(clip.frames, Math.floor(f));
            play.row = cls.anim.rowOf(person.clip) + whole;
            play.t = f - whole;
            // A cross-fade: the clip being left under the new one, the two weights summing to one
            const out = person.fade;
            const left = out && out.weight > 0 ? cls.clips[out.clip] : undefined;
            if (out && left) {
              const g = (out.phase - Math.floor(out.phase)) * left.frames;
              const at = Math.min(left.frames, Math.floor(g));
              leaving.row = cls.anim.rowOf(out.clip) + at;
              leaving.t = g - at;
              leaving.weight = Math.min(1, out.weight);
              play.weight = 1 - leaving.weight;
              cls.pass.setPlays(person.row, fading, st.variant);
            } else {
              play.weight = 1;
              cls.pass.setPlays(person.row, plays, st.variant);
            }
          }
          // The face of the moment - blinking, mood, talk, fright (`faceAt`) - only where a face is big enough to show it.
          if (st.level === 0) {
            const w = faceAt(person.spec.id, time, person.activity, person.spec.mood ?? 0);
            const at = person.row * PERSON_FLOATS + EXPR_AT;
            for (let c = 0; c < EXPR.length; c++) cls.personData[at + c] = Math.min(1, w[EXPR[c]!] ?? 0);
            // DO NOT send the whole texture: a row for every body of the class, for the few faces close enough to show.
            touchRows(cls.uniforms.procPerson.value, person.row, 1);
          }
          // The far ones' shadow: a soft disc under them.
          if (st.level >= 2 && shadows) blobs.add(person.matrix, BLOB_RADIUS * person.scale);
        }
        // The rows of the people placed, a range a row; most of the class: the whole (small) texture.
        const places = cls.uniforms.procPerson.value;
        // DO NOT send them a row a call past a few: three sends each range as its own texSubImage2D, a row high (r186 `updateTexture`), and 500 people were 500 calls a frame (AGT-06); the whole texture is one, as `crowdAnimation.ts` does past `MOST_ROW_RANGES`.
        if (cls.placed.length <= MOST_ROW_RANGES) for (const row of cls.placed) touchRows(places, row, 1);
        else if (cls.placed.length) { places.clearUpdateRanges(); places.needsUpdate = true; }
        cls.placed.length = 0;
        for (const piece of cls.pieces) {
          trianglesDrawn += piece.people.length * piece.triangles;
          if (piece.mesh.castShadow && piece.people.length > 0) castingNow = true;
          upload(piece, piece.dirty);
          piece.dirty = false;
        }
      }
      if (eye) strandsUpdate(eye);
      blobs.finish();
    },
    renderPalettes(renderer) {
      if (!restoreHooked) { restoreHooked = true; renderer.domElement.addEventListener('webglcontextrestored', restore); }
      for (const cls of ready) {
        // The bodies and faces made since the last frame, up before anybody draws them.
        cls.bodies.flush(renderer);
        cls.faces.flush(renderer);
        if (!cls.drawn) continue;
        cls.pass.render(renderer, cls.rows);
        cls.uniforms.procBones.value = cls.pass.texture;
        cls.uniforms.procBase.value = cls.pass.base;
      }
    },
    clear() {
      epoch++;
      for (const piece of shown) { piece.people = []; piece.mesh.count = 0; piece.mesh.visible = false; }
      shown.clear();
      for (const cls of ready) {
        for (const piece of cls.pieces) {
          piece.people = [];
          piece.mesh.count = 0;
          piece.mesh.visible = false;
        }
        cls.people.length = 0;
        cls.rows = 0;
        cls.faceOf.length = 0;
        cls.drawn = 0;
      }
      states.clear();
      spareRows.clear();
      charred.clear();
      holds.clear();
      postures.clear();
      jolts.clear();
      people.length = 0;
    },
    clipDuration(person, of = person.clip) {
      const cls = classOf(person) ?? ready.find((c) => c.sex === person.sex && c.band === person.band);
      return cls?.clips[of].duration ?? 1;
    },
    stride(person, of = person.clip) {
      const cls = classOf(person) ?? ready.find((c) => c.sex === person.sex && c.band === person.band);
      const clip = of === 'run' ? cls?.clips.run : of === 'sprint' ? cls?.clips.sprint
        : of === 'hurtWalk' ? cls?.clips.hurtWalk : of === 'hurtRun' ? cls?.clips.hurtRun
          : of === 'crawl' ? cls?.clips.crawl : cls?.clips.walk;
      return (clip?.stride || 1.4) * person.scale;
    },
    cook() {
      return cookAll(env);
    },
    async warmClasses() {
      for (const sex of ['female', 'male'] as const) {
        for (const band of ['adult', 'young', 'senior', 'child'] as const) {
          // One at a time: each class's rig is made on the people's worker, none on the page to space out.
          await classFor(sex, band);
        }
      }
    },
    forget(name) {
      for (const [key, piece] of readyStrand) if (key.endsWith(`/${name}`)) {
        group.remove(piece.mesh); piece.mesh.geometry.dispose(); shown.delete(piece);
        readyStrand.delete(key); strandPieces.delete(key);
      }
      items.delete(name);
      textures.delete(name);
      lodPlans.delete(name);
      for (const cls of ready) {
        const own = cls.items.get(name);
        itemsMaking.delete(`${cls.key}/${name}`);
        if (!own) continue;
        for (const piece of own.levels) {
          if (!piece) continue;
          group.remove(piece.mesh);
          piece.mesh.geometry.dispose();
          (piece.mesh.material as Material).dispose();
          piece.mesh.customDepthMaterial?.dispose();
          const at = cls.pieces.indexOf(piece);
          if (at >= 0) cls.pieces.splice(at, 1);
        }
        cls.items.delete(name);
      }
    },
    probe(person, vertices) {
      const st = states.get(person)!;
      const cls = st.cls;
      // A class made on the people's worker has its whole rig there: nothing to probe here.
      if (!cls.rig.deltas) return [];
      const exact = cls.rig.deltas(env.loaded!.morpher.shape({ ...person.spec.body, height: cls.base.height }));
      const px = cls.shapePixels;
      return vertices.map((v) => {
        const linear = [0, 0, 0];
        for (let k = 0; k < SHAPES; k++) {
          const c = st.coef[k]!;
          for (let a = 0; a < 3; a++) linear[a]! += c * px[(v * SHAPES + k) * 4 + a]!;
        }
        return { v, linear, exact: [exact[v * 3]!, exact[v * 3 + 1]!, exact[v * 3 + 2]!] };
      });
    },
    get casting() { return castingNow || castedLast; },
    stats() {
      let pieces = 0, draws = 0, vertices = 0, textureBytes = 0;
      const names = new Set<string>();
      for (const cls of ready) {
        for (const own of [...cls.skins.values(), ...cls.items.values()]) {
          vertices += own.vertices;
          names.add(own.name);
        }
        for (const piece of cls.pieces) {
          pieces++;
          if (piece.mesh.visible) draws++;
        }
        textureBytes += cls.bodies.bytes + cls.faces.bytes + cls.anim.bytes;
        textureBytes += (cls.uniforms.procCover.value.image.data as Uint8Array).byteLength;
      }
      return { classes: ready.length, people: people.length, pieces, draws, items: names.size, vertices, textureBytes, bakeMs,
        levels: [...levelCount], triangles: trianglesDrawn };
    },
  };
}

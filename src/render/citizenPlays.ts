import { DataTexture, FloatType, NearestFilter, RGBAFormat } from 'three';
import type { ClipFrames } from './citizenBake';
import { PACKED_BONE_FLOATS, SKIN_BONE_FLOATS, blendPackedFrames, copyPackedFrame } from './citizenPalette';
import type { ClassAnimation } from './people/crowdAnimation';

/** WHAT A COOKED BODY PLAYS, AS THE GPU'S PALETTE PASS BLENDS IT (`people/crowdAnimation.ts`), AND THE SAME ON THE CPU */

/** Plays the palette pass blends a person (`crowdAnimation.ts` PLAYS): more, and the person is blended on the CPU. */
export const GPU_PLAYS = 4;

/** One play of the pass: an atlas row, the share of the way to the next row, its weight. */
export interface Play { row: number; t: number; weight: number }

/** A body's clips in one atlas texture, and each clip's first row in it. */
export interface CitizenAtlas {
  /** Its texture swapped only when it grows (`appendClip`): the pass reads `anim.atlas`. */
  anim: ClassAnimation;
  readonly rowOf: ReadonlyMap<ClipFrames, number>;
  /** Rows written; the texture's height is its room. */
  rows: number;
}

/** Texels a bone takes in an atlas row (twelve floats: `crowdAnimation.ts` ATLAS_TEXELS). */
const ATLAS_TEXELS = 3;
/** Room laid past the clips baked so far, a share of them: the clips baked on first use go in without laying the atlas again. */
const ATLAS_SLACK = 0.25;

/** An atlas texture of `height` rows, its texels `pixels`. */
function atlasTexture(pixels: Float32Array, width: number, height: number): DataTexture {
  const texture = new DataTexture(pixels, width, height, RGBAFormat, FloatType);
  texture.minFilter = texture.magFilter = NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

/** The atlas as the palette pass reads it (`ClassAnimation`). */
function animationOf(texture: DataTexture, bones: number, width: number, height: number): ClassAnimation {
  return { atlas: texture, rowOf: () => 0, bones, bytes: width * height * 16, refill() {} };
}

/** DO NOT lay the atlas again for each clip baked on first use: the clips baked so far (a clip listed twice laid in once), in order, with room for more. */
export function citizenAtlas(clips: readonly (ClipFrames | undefined)[], bones: number): CitizenAtlas {
  const packed = bones * PACKED_BONE_FLOATS;
  const width = bones * ATLAS_TEXELS;
  const rowOf = new Map<ClipFrames, number>();
  let rows = 0;
  for (const clip of clips) {
    if (!clip || rowOf.has(clip)) continue;
    rowOf.set(clip, rows);
    rows += Math.round(clip.data.length / packed);
  }
  const height = Math.max(1, Math.ceil(rows * (1 + ATLAS_SLACK)));
  const pixels = new Float32Array(width * 4 * height);
  for (const [clip, row] of rowOf) pixels.set(clip.data.subarray(0, Math.round(clip.data.length / packed) * packed), row * width * 4);
  return { anim: animationOf(atlasTexture(pixels, width, height), bones, width, height), rowOf, rows };
}

/** A clip baked since the atlas was laid, written into its room (only its rows sent up); past the room the atlas doubles. Whether its texture changed. */
export function appendClip(atlas: CitizenAtlas, clip: ClipFrames): boolean {
  if (atlas.rowOf.has(clip)) return false;
  const bones = atlas.anim.bones;
  const packed = bones * PACKED_BONE_FLOATS;
  const width = bones * ATLAS_TEXELS;
  const count = Math.round(clip.data.length / packed);
  const at = atlas.rows;
  let texture = atlas.anim.atlas;
  const height = texture.image.height;
  let grown = false;
  if (at + count > height) {
    const next = Math.max(at + count, height * 2);
    const pixels = new Float32Array(width * 4 * next);
    pixels.set((texture.image.data as Float32Array).subarray(0, at * width * 4));
    texture = atlasTexture(pixels, width, next);
    atlas.anim = animationOf(texture, bones, width, next);
    grown = true;
  }
  (texture.image.data as Float32Array).set(clip.data.subarray(0, count * packed), at * width * 4);
  // Each update range is one row of the image (three's WebGLTextures): the new rows only.
  if (!grown) for (let r = 0; r < count; r++) texture.addUpdateRange((at + r) * width * 4, width * 4);
  texture.needsUpdate = true;
  (atlas.rowOf as Map<ClipFrames, number>).set(clip, at);
  atlas.rows = at + count;
  return grown;
}

/** The plays of a pose, as `cpuPose` would blend it, into `out` (its first entries); how many, or -1 when the pass cannot. */
export function gpuPlays(out: Play[], atlas: CitizenAtlas, clips: readonly ClipFrames[], phases: readonly number[],
  weights: readonly number[], single: boolean): number {
  if (single) {
    // The frame of the clip that weighs most, as it is: the row before it carried all the way (no row past the clip is read).
    let best = -1;
    for (let c = 0; c < clips.length; c++) if (best < 0 || weights[c]! > weights[best]!) best = c;
    if (best < 0) return 0;
    const clip = clips[best]!;
    const start = atlas.rowOf.get(clip);
    if (start === undefined) return -1;
    const frame = Math.round(Math.min(clip.frames, Math.max(0, phases[best]!)));
    const play = out[0]!;
    if (frame > 0) { play.row = start + frame - 1; play.t = 1; } else { play.row = start; play.t = 0; }
    play.weight = 1;
    return 1;
  }
  let total = 0;
  for (let c = 0; c < clips.length; c++) total += Math.max(0, weights[c]!);
  let n = 0;
  for (let c = 0; c < clips.length; c++) {
    const weight = Math.max(0, weights[c]!) / (total || 1);
    if (weight < 0.001) continue;
    if (n >= GPU_PLAYS) return -1;
    const clip = clips[c]!;
    const start = atlas.rowOf.get(clip);
    if (start === undefined) return -1;
    const f = Math.min(clip.frames, Math.max(0, phases[c]!));
    const whole = Math.floor(f);
    const play = out[n++]!;
    play.row = start + whole;
    play.t = f % 1;
    play.weight = weight;
  }
  return n;
}

/** The pose blended on the CPU into `out` at `offset` (a held, wounded or maimed body; a pose captured for a ragdoll). */
export function cpuPose(out: Float32Array, offset: number, clips: readonly ClipFrames[], phases: readonly number[],
  weights: readonly number[], width: number, single: boolean): void {
  const bones = width / SKIN_BONE_FLOATS;
  const packedWidth = bones * PACKED_BONE_FLOATS;
  // Far off (a body a few pixels tall), the pose is the frame of the clip that weighs most, copied as it is
  if (single) {
    let best = -1;
    for (let c = 0; c < clips.length; c++) if (best < 0 || weights[c]! > weights[best]!) best = c;
    if (best >= 0) {
      const clip = clips[best]!;
      const start = Math.round(Math.min(clip.frames, Math.max(0, phases[best]!))) * packedWidth;
      copyPackedFrame(out, offset, clip.data, start, bones);
    } else out.fill(0, offset, offset + width);
    return;
  }
  out.fill(0, offset, offset + width);
  let total = 0;
  for (let c = 0; c < clips.length; c++) total += Math.max(0, weights[c]!);
  for (let c = 0; c < clips.length; c++) {
    const weight = Math.max(0, weights[c]!) / (total || 1);
    if (weight < 0.001) continue;
    const clip = clips[c]!;
    const f = Math.min(clip.frames, Math.max(0, phases[c]!));
    const fraction = f % 1;
    const start = Math.floor(f) * packedWidth;
    blendPackedFrames(out, offset, clip.data, start, packedWidth, bones, weight * (1 - fraction), weight * fraction);
  }
}

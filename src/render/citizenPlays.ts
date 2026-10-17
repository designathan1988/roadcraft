import type { ClipFrames } from './citizenBake';
import { PACKED_BONE_FLOATS, SKIN_BONE_FLOATS, blendPackedFrames, copyPackedFrame } from './citizenPalette';
import { buildClassAnimation, type ClassAnimation } from './people/crowdAnimation';

/** WHAT A COOKED BODY PLAYS, AS THE GPU'S PALETTE PASS BLENDS IT (`people/crowdAnimation.ts`), AND THE SAME ON THE CPU */

/** Plays the palette pass blends a person (`crowdAnimation.ts` PLAYS): more, and the person is blended on the CPU. */
export const GPU_PLAYS = 4;

/** One play of the pass: an atlas row, the share of the way to the next row, its weight. */
export interface Play { row: number; t: number; weight: number }

/** A body's clips in one atlas texture, and each clip's first row in it. */
export interface CitizenAtlas {
  readonly anim: ClassAnimation;
  readonly rowOf: ReadonlyMap<ClipFrames, number>;
}

/** The atlas of the clips baked so far (a clip listed twice is laid in once). */
export function citizenAtlas(clips: readonly (ClipFrames | undefined)[], bones: number): CitizenAtlas {
  const named: Record<string, ClipFrames> = {};
  const names = new Map<ClipFrames, string>();
  clips.forEach((clip, at) => {
    if (!clip || names.has(clip)) return;
    names.set(clip, String(at));
    named[String(at)] = clip;
  });
  const anim = buildClassAnimation(named, bones);
  const rowOf = new Map<ClipFrames, number>();
  for (const [clip, name] of names) rowOf.set(clip, anim.rowOf(name));
  return { anim, rowOf };
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

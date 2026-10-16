import { describe, expect, it } from 'vitest';
import type { ClipFrames } from '@render/citizenBake';
import { GPU_PLAYS, citizenAtlas, cpuPose, gpuPlays, type Play } from '@render/citizenPlays';
import { PACKED_BONE_FLOATS, SKIN_BONE_FLOATS } from '@render/citizenPalette';

/** THE COOKED CROWD'S POSES BLENDED ON THE GPU ARE THE POSES THE CPU BLENDED (`render/citizenPlays.ts`, `people/crowdAnimation.ts`) */

const BONES = 5;

/** A small seeded generator, so a failure shows the same clips again. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** A clip of `frames` intervals: `frames + 2` rows of packed affine bones (`ClipFrames.data`). */
function clip(frames: number, r: () => number): ClipFrames {
  const data = new Float32Array((frames + 2) * BONES * PACKED_BONE_FLOATS);
  for (let i = 0; i < data.length; i++) data[i] = (r() - 0.5) * 4;
  return { data, frames, duration: frames / 30, stride: 1, pelvisY: 1, pelvisX: 0, pelvisZ: 0, loop: true } as ClipFrames;
}

/** The palette pass's fragment shader (`crowdAnimation.ts` createPalettePass), on the CPU: no parent, joints at the origin. */
function pass(atlas: Float32Array, plays: readonly Play[]): Float32Array {
  const out = new Float32Array(BONES * SKIN_BONE_FLOATS);
  const bone = (row: number, b: number): number[] => {
    const at = (row * BONES * 3 + b * 3) * 4;
    const a = atlas.subarray(at, at + 12);
    return [a[0]!, a[1]!, a[2]!, 0, a[3]!, a[4]!, a[5]!, 0, a[6]!, a[7]!, a[8]!, 0, a[9]!, a[10]!, a[11]!, 1];
  };
  for (let b = 0; b < BONES; b++) {
    for (const p of plays.slice(0, GPU_PLAYS)) {
      if (p.weight <= 0) continue;
      const A = bone(p.row, b), B = bone(p.row + 1, b);
      for (let e = 0; e < 16; e++) out[b * 16 + e] = out[b * 16 + e]! + p.weight * ((1 - p.t) * A[e]! + p.t * B[e]!);
    }
  }
  return out;
}

describe('a cooked body played on the GPU', () => {
  const r = random(11);
  const clips = [clip(8, r), clip(12, r), clip(6, r), clip(30, r), clip(4, r)];
  // The same clip under two names (a stand-in), laid in the atlas once.
  const listed = [clips[0], clips[1], undefined, clips[2], clips[3], clips[1], clips[4]];
  const atlas = citizenAtlas(listed, BONES);
  const pixels = atlas.anim.atlas.image.data as Float32Array;
  const out: Play[] = Array.from({ length: GPU_PLAYS }, () => ({ row: 0, t: 0, weight: 0 }));

  const same = (mix: readonly ClipFrames[], phases: readonly number[], weights: readonly number[], single: boolean): void => {
    const cpu = new Float32Array(BONES * SKIN_BONE_FLOATS);
    cpuPose(cpu, 0, mix, phases, weights, BONES * SKIN_BONE_FLOATS, single);
    const n = gpuPlays(out, atlas, mix, phases, weights, single);
    expect(n).toBeGreaterThanOrEqual(0);
    const gpu = pass(pixels, out.slice(0, n));
    for (let i = 0; i < cpu.length; i++) expect(gpu[i]!, `float ${i}`).toBeCloseTo(cpu[i]!, 5);
  };

  it('lays each clip in once, its frames as baked', () => {
    expect(atlas.rowOf.size).toBe(clips.length);
    for (const c of clips) {
      const row = atlas.rowOf.get(c)!;
      const width = BONES * PACKED_BONE_FLOATS;
      expect(pixels.subarray(row * width, (row + c.frames + 2) * width)).toEqual(c.data);
    }
  });

  it('blends a walk, a turn and a stop as the CPU did', () => {
    same([clips[0]!], [3.25], [1], false);
    same([clips[0]!, clips[1]!], [2.5, 11.9], [0.7, 0.3], false);
    same([clips[0]!, clips[1]!, clips[2]!, clips[3]!], [0, 7, 6, 29.99], [0.2, 0.5, 0.25, 1.4], false);
    // Past the clip's end, and before its start: held at its ends.
    same([clips[2]!, clips[4]!], [9, -2], [1, 1], false);
    // A weight under a thousandth of the whole: dropped by both.
    same([clips[0]!, clips[1]!], [1.5, 2.5], [1, 0.0004], false);
    // Nothing weighed: nothing drawn, by both.
    same([clips[0]!], [1.5], [0], false);
  });

  it('copies the frame of the clip weighing most far off, as the CPU did', () => {
    same([clips[0]!, clips[1]!], [2.4, 5.6], [0.3, 0.7], true);
    same([clips[3]!], [0.2], [1], true);
    same([clips[4]!], [4], [1], true);
    same([], [], [], true);
  });

  it('leaves to the CPU what the pass cannot play', () => {
    const five = [clips[0]!, clips[1]!, clips[2]!, clips[3]!, clips[4]!];
    expect(gpuPlays(out, atlas, five, [1, 1, 1, 1, 1], [1, 1, 1, 1, 1], false)).toBe(-1);
    const unknown = clip(5, r);
    expect(gpuPlays(out, atlas, [unknown], [1], [1], false)).toBe(-1);
  });
});

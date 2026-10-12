/** A skin matrix is affine: its fourth row is always (0, 0, 0, 1). */
export const PACKED_BONE_FLOATS = 12;
export const SKIN_BONE_FLOATS = 16;

/** Keep the twelve changing values of each bone matrix in column-major order. */
export function packBoneMatrices(source: Float32Array, target: Float32Array, at: number): void {
  const bones = source.length / SKIN_BONE_FLOATS;
  for (let bone = 0; bone < bones; bone++) {
    const s = bone * SKIN_BONE_FLOATS;
    const d = at + bone * PACKED_BONE_FLOATS;
    if (source[s + 3] !== 0 || source[s + 7] !== 0 || source[s + 11] !== 0 || source[s + 15] !== 1) {
      throw new Error('Citizen bone palette contains a non-affine matrix');
    }
    for (let column = 0; column < 4; column++) {
      const from = s + column * 4;
      const to = d + column * 3;
      target[to] = source[from]!;
      target[to + 1] = source[from + 1]!;
      target[to + 2] = source[from + 2]!;
    }
  }
}

/** Expand one baked frame directly into the GPU's ordinary 4x4 palette. */
export function copyPackedFrame(target: Float32Array, at: number, source: Float32Array, from: number, bones: number): void {
  for (let bone = 0; bone < bones; bone++) {
    const s = from + bone * PACKED_BONE_FLOATS;
    const d = at + bone * SKIN_BONE_FLOATS;
    for (let column = 0; column < 4; column++) {
      const input = s + column * 3;
      const output = d + column * 4;
      target[output] = source[input]!;
      target[output + 1] = source[input + 1]!;
      target[output + 2] = source[input + 2]!;
      target[output + 3] = column === 3 ? 1 : 0;
    }
  }
}

/** Add one clip's two neighbouring frames to a blended GPU palette. */
export function blendPackedFrames(target: Float32Array, at: number, source: Float32Array, from: number,
  frameWidth: number, bones: number, a: number, b: number): void {
  for (let bone = 0; bone < bones; bone++) {
    const s = from + bone * PACKED_BONE_FLOATS;
    const d = at + bone * SKIN_BONE_FLOATS;
    for (let column = 0; column < 4; column++) {
      const input = s + column * 3;
      const output = d + column * 4;
      for (let row = 0; row < 3; row++) {
        target[output + row] = target[output + row]! + a * source[input + row]! + b * source[input + frameWidth + row]!;
      }
    }
    target[d + 15] = target[d + 15]! + a + b;
  }
}

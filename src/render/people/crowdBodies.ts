import { DataTexture, FloatType, NearestFilter, RGBAFormat } from 'three';

/**
 * The bodies of a class baked once (`proceduralCrowd.ts`): a person's body
 * shape never changes in the game, yet its sixteen principal components were
 * summed again at every vertex, every frame, in the colour and the shadow
 * passes. Each class keeps up to `BODIES` bodies, made the first time a body
 * that far from the others comes in; anybody after that is drawn with the
 * nearest. A crowd hides its repeats by what changes from person to person -
 * colour, facing, movement (McDonnell et al., "Clone Attack! Perception of
 * Crowd Variety", SIGGRAPH 2008) - and here each still has their own clothes,
 * dyes, hair, height and face.
 *
 * `texture`: each body's move of every base vertex, `rowsPerBody` rows of
 * `WIDTH` texels a body (vertex v of body b at b * stride + v). `joints`: each
 * body's bone heads moved with it, a row of `bones` texels a body.
 */
export const BODIES = 16;
/** Texels across the bodies texture (the shader's divisor). */
export const BODY_WIDTH = 4096;
const WIDTH = BODY_WIDTH;

export interface ClassBodies {
  readonly texture: DataTexture;
  readonly joints: DataTexture;
  /** Texels between the first vertices of two bodies. */
  readonly stride: number;
  readonly count: number;
  /** The body to draw a person of these coefficients with (one made if room is left), and its joints. */
  pick(coefficients: Float32Array): { index: number; joints: Float32Array };
  dispose(): void;
}

/**
 * `shapePixels`: the class's shape basis (`proceduralCrowd.ts` classData),
 * component k of vertex v at texel v * shapes + k; `jointBasis`: each bone's
 * head per unit of each component, [bone][k][xyz].
 */
export function createClassBodies(shapePixels: Float32Array, vertexCount: number, shapes: number,
  jointBasis: Float32Array, bones: number): ClassBodies {
  const rowsPerBody = Math.ceil(vertexCount / WIDTH);
  const stride = rowsPerBody * WIDTH;
  const pixels = new Float32Array(stride * 4 * BODIES);
  const texture = new DataTexture(pixels, WIDTH, rowsPerBody * BODIES, RGBAFormat, FloatType);
  texture.minFilter = texture.magFilter = NearestFilter;
  texture.needsUpdate = true;
  const jointPixels = new Float32Array(bones * 4 * BODIES);
  const joints = new DataTexture(jointPixels, bones, BODIES, RGBAFormat, FloatType);
  joints.minFilter = joints.magFilter = NearestFilter;
  joints.needsUpdate = true;
  const coefficients: Float32Array[] = [];
  const jointsOf: Float32Array[] = [];

  /** A body baked from coefficients `c`: every vertex's move, every joint's. */
  const make = (c: Float32Array): number => {
    const b = coefficients.length;
    coefficients.push(c.slice());
    const at = b * stride * 4;
    for (let v = 0; v < vertexCount; v++) {
      let x = 0, y = 0, z = 0;
      const base = v * shapes * 4;
      for (let k = 0; k < shapes; k++) {
        const w = c[k] ?? 0;
        if (w === 0) continue;
        const t = base + k * 4;
        x += w * shapePixels[t]!; y += w * shapePixels[t + 1]!; z += w * shapePixels[t + 2]!;
      }
      const o = at + v * 4;
      pixels[o] = x; pixels[o + 1] = y; pixels[o + 2] = z;
    }
    const d = new Float32Array(bones * 3);
    for (let i = 0; i < bones; i++) for (let a = 0; a < 3; a++) {
      let s = 0;
      for (let k = 0; k < shapes; k++) s += (c[k] ?? 0) * jointBasis[(i * shapes + k) * 3 + a]!;
      d[i * 3 + a] = s;
      jointPixels[(b * bones + i) * 4 + a] = s;
    }
    jointsOf.push(d);
    // Only this body's rows go to the GPU - a range a row: three uploads each
    // update range as one row of the image (WebGLTextures.js, texSubImage2D
    // of height 1), so a range across rows would spill.
    for (let r = 0; r < rowsPerBody; r++) texture.addUpdateRange(at + r * WIDTH * 4, WIDTH * 4);
    texture.needsUpdate = true;
    joints.addUpdateRange(b * bones * 4, bones * 4);
    joints.needsUpdate = true;
    return b;
  };

  return {
    texture,
    joints,
    stride,
    get count() { return coefficients.length; },
    pick(c) {
      let best = -1, bestD = Infinity;
      for (let b = 0; b < coefficients.length; b++) {
        const own = coefficients[b]!;
        let d = 0;
        for (let k = 0; k < shapes; k++) { const e = (c[k] ?? 0) - own[k]!; d += e * e; }
        if (d < bestD) { bestD = d; best = b; }
      }
      // A new body while there is room and nobody this close is made yet.
      if (coefficients.length < BODIES && (best < 0 || bestD > 1e-6)) best = make(c);
      return { index: best, joints: jointsOf[best]! };
    },
    dispose() {
      texture.dispose();
      joints.dispose();
    },
  };
}

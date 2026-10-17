import { DataTexture, FloatType, NearestFilter, RGBAFormat, type Texture, type WebGLRenderer } from 'three';
import { createGpuRows } from './gpuRows';

/** The bodies of a class baked once (`proceduralCrowd.ts`) */
const BODIES = 16;
/** Texels across the bodies texture (the shader's divisor). */
export const BODY_WIDTH = 4096;
const WIDTH = BODY_WIDTH;

export interface ClassBodies {
  readonly texture: Texture;
  readonly joints: DataTexture;
  /** Texels between the first vertices of two bodies. */
  readonly stride: number;
  readonly count: number;
  /** The bodies' bytes on the GPU. */
  readonly bytes: number;
  /** The body to draw a person of these coefficients with (one made if room is left), and its joints. */
  pick(coefficients: Float32Array): { index: number; joints: Float32Array };
  /** The bodies made since the last frame sent up: before anybody draws them. */
  flush(renderer: WebGLRenderer): void;
  /** Every body made baked and sent up again (a WebGL context restored). */
  restore(): void;
  dispose(): void;
}

/** `shapePixels`: the class's shape basis (`proceduralCrowd.ts` classData), component k of vertex v at texel v * shapes + k */
export function createClassBodies(shapePixels: Float32Array, vertexCount: number, shapes: number,
  jointBasis: Float32Array, bones: number): ClassBodies {
  const rowsPerBody = Math.ceil(vertexCount / WIDTH);
  const stride = rowsPerBody * WIDTH;
  // DO NOT keep the bodies on the CPU: each is baked from the shape basis, sent up, and baked again only on a restore.
  const rows = createGpuRows(WIDTH, rowsPerBody * BODIES);
  const jointPixels = new Float32Array(bones * 4 * BODIES);
  const joints = new DataTexture(jointPixels, bones, BODIES, RGBAFormat, FloatType);
  joints.minFilter = joints.magFilter = NearestFilter;
  joints.needsUpdate = true;
  const coefficients: Float32Array[] = [];
  const jointsOf: Float32Array[] = [];

  /** Body `b`'s every vertex move, baked from its coefficients, sent up at the next flush. */
  const bake = (b: number): void => {
    const c = coefficients[b]!;
    const pixels = new Float32Array(stride * 4);
    for (let v = 0; v < vertexCount; v++) {
      let x = 0, y = 0, z = 0;
      const base = v * shapes * 4;
      for (let k = 0; k < shapes; k++) {
        const w = c[k] ?? 0;
        if (w === 0) continue;
        const t = base + k * 4;
        x += w * shapePixels[t]!; y += w * shapePixels[t + 1]!; z += w * shapePixels[t + 2]!;
      }
      const o = v * 4;
      pixels[o] = x; pixels[o + 1] = y; pixels[o + 2] = z;
    }
    rows.write(b * rowsPerBody, pixels);
  };

  /** A body made from coefficients `c`: its vertices baked, every joint's move. */
  const make = (c: Float32Array): number => {
    const b = coefficients.length;
    coefficients.push(c.slice());
    bake(b);
    const d = new Float32Array(bones * 3);
    for (let i = 0; i < bones; i++) for (let a = 0; a < 3; a++) {
      let s = 0;
      for (let k = 0; k < shapes; k++) s += (c[k] ?? 0) * jointBasis[(i * shapes + k) * 3 + a]!;
      d[i * 3 + a] = s;
      jointPixels[(b * bones + i) * 4 + a] = s;
    }
    jointsOf.push(d);
    joints.addUpdateRange(b * bones * 4, bones * 4);
    joints.needsUpdate = true;
    return b;
  };

  return {
    get texture() { return rows.texture; },
    joints,
    stride,
    get count() { return coefficients.length; },
    get bytes() { return rows.bytes; },
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
    flush(renderer) { rows.flush(renderer); },
    restore() {
      rows.reset();
      for (let b = 0; b < coefficients.length; b++) bake(b);
      joints.clearUpdateRanges();
      joints.needsUpdate = true;
    },
    dispose() {
      rows.dispose();
      joints.dispose();
    },
  };
}

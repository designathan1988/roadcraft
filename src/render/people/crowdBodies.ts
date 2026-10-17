import { DataTexture, FloatType, NearestFilter, RGBAFormat, type Texture, type WebGLRenderer } from 'three';
import { canQueueJobs, submitJob } from '../../jobs/jobPool';
import { type BodyBakeJob, bakeBodyPixels, isShared } from './bodyBake';
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
  /** The body to draw a person of these coefficients with (one made if room is left), its joints, and when its vertices are in the texture (baked in a job). */
  pick(coefficients: Float32Array): { index: number; joints: Float32Array; ready: Promise<void> };
  /** The bodies made since the last frame sent up: before anybody draws them. */
  flush(renderer: WebGLRenderer): void;
  /** Every body made baked and sent up again (a WebGL context restored). */
  restore(): void;
  dispose(): void;
}

/** `shapePixels`: the class's shape basis (`proceduralCrowd.ts` classData), component k of vertex v at texel v * shapes + k: in shared memory (`sharedShape`), a new body is baked in a job */
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
  /** Each body's vertices in the texture: settled once its bake was written (`bake`). */
  const ready: Promise<void>[] = [];
  let disposed = false;

  const jobOf = (b: number): BodyBakeJob => ({ shape: shapePixels, vertexCount, shapes, stride, coefficients: coefficients[b]! });
  /** Body `b`'s every vertex move, baked from its coefficients in a job reading the shared basis (here where none can), sent up at the next flush. */
  const bake = (b: number): Promise<void> => {
    const write = (pixels: Float32Array): void => { if (!disposed) rows.write(b * rowsPerBody, pixels); };
    if (!canQueueJobs() || !isShared(shapePixels)) { write(bakeBodyPixels(jobOf(b))); return Promise.resolve(); }
    return new Promise<void>((resolve) => {
      submitJob({
        service: 'crowdBodies', key: null, priority: -1,
        write: () => ({ data: jobOf(b), transfer: [] }),
        done: (answer) => { write(answer as Float32Array); resolve(); },
        // The worker could not: baked here, as an event.
        failed: () => { write(bakeBodyPixels(jobOf(b))); resolve(); },
      });
    });
  };

  /** A body made from coefficients `c`: its vertices baked, every joint's move. */
  const make = (c: Float32Array): number => {
    const b = coefficients.length;
    coefficients.push(c.slice());
    ready[b] = bake(b);
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
      return { index: best, joints: jointsOf[best]!, ready: ready[best]! };
    },
    flush(renderer) { rows.flush(renderer); },
    restore() {
      rows.reset();
      for (let b = 0; b < coefficients.length; b++) ready[b] = bake(b);
      joints.clearUpdateRanges();
      joints.needsUpdate = true;
    },
    dispose() {
      disposed = true;
      rows.dispose();
      joints.dispose();
    },
  };
}

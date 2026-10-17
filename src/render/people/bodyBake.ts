/** ONE BODY OF A PROCEDURAL CLASS FROM ITS SHAPE BASIS: every vertex's move for a person's shape coefficients (`crowdBodies.ts`), the same on the page and in a job worker */

/** What a body is baked from: the class's shape basis (component k of vertex v at texel v * shapes + k), its sizes, the coefficients. */
export interface BodyBakeJob {
  readonly shape: Float32Array;
  readonly vertexCount: number;
  readonly shapes: number;
  /** Texels a body takes in the bodies texture (its rows' width times their count). */
  readonly stride: number;
  readonly coefficients: Float32Array;
}

/** The body's pixels: each vertex's move, an RGBA texel each (alpha unused). */
export function bakeBodyPixels(job: BodyBakeJob): Float32Array {
  const { shape, vertexCount, shapes, stride, coefficients: c } = job;
  const pixels = new Float32Array(stride * 4);
  for (let v = 0; v < vertexCount; v++) {
    let x = 0, y = 0, z = 0;
    const base = v * shapes * 4;
    for (let k = 0; k < shapes; k++) {
      const w = c[k] ?? 0;
      if (w === 0) continue;
      const t = base + k * 4;
      x += w * shape[t]!; y += w * shape[t + 1]!; z += w * shape[t + 2]!;
    }
    const o = v * 4;
    pixels[o] = x; pixels[o + 1] = y; pixels[o + 2] = z;
  }
  return pixels;
}

/** Whether memory can be shared with the workers: a cross-origin isolated page (MDN, `SharedArrayBuffer`, COOP/COEP), or Node. */
const canShare = (): boolean => typeof SharedArrayBuffer !== 'undefined' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated !== false;

/** The shape basis in shared memory, once a class: a job reads it where it is, never a copy a body (a plain copy where nothing can be shared). */
export function sharedShape(pixels: Float32Array): Float32Array {
  if (!canShare() || pixels.buffer instanceof SharedArrayBuffer) return pixels;
  const shared = new Float32Array(new SharedArrayBuffer(pixels.byteLength));
  shared.set(pixels);
  return shared;
}

/** Whether a job can read the basis without its being copied into the message. */
export const isShared = (pixels: Float32Array): boolean => typeof SharedArrayBuffer !== 'undefined' && pixels.buffer instanceof SharedArrayBuffer;

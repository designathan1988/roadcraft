import { MeshoptSimplifier } from 'meshoptimizer';

/** THE FAR LEVEL OF A BLOCK OF ROAD SURFACE, as arrays (`roadLod.ts` makes the mesh) */

/** A block's arrays, as `tileArrays` makes them: `color` and `roadSection` only where the surface's material reads them. */
export type BlockArrays = {
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly uv: Float32Array;
  readonly color?: Float32Array;
  readonly roadSection?: Float32Array;
  readonly index: Uint16Array | Uint32Array;
};

/** A block's typed arrays, to transfer them to or from a worker. */
export function blockBuffers(arrays: BlockArrays): ArrayBuffer[] {
  return [arrays.position, arrays.normal, arrays.uv, arrays.color, arrays.roadSection, arrays.index]
    .flatMap((a) => (a ? [a.buffer as ArrayBuffer] : []));
}

/** What a coarse block may deviate by from the block, metres (absolute: a 1 % error of a 250 m block is 2.5 m). */
export const COARSE_ERROR = 0.12;
/** The share of the triangles aimed at: the simplifier stops sooner when the error is reached. */
const COARSE_RATIO = 0.08;
/** A block with fewer triangles than this is not simplified: its far level would save nothing. */
const COARSE_MIN_TRIANGLES = 160;

/** The coarse arrays of a block, or null when it is too small to be worth it or the simplifier cannot run. */
export function coarseArrays(block: BlockArrays, lock: readonly [number, number, number, number]): BlockArrays | null {
  const count = block.position.length / 3;
  const indices = block.index.length;
  if (indices / 3 < COARSE_MIN_TRIANGLES || !MeshoptSimplifier.supported) return null;
  const locked = new Uint8Array(count);
  const eps = 1e-3;
  const [minX, minY, maxX, maxY] = lock;
  for (let i = 0; i < count; i++) {
    const x = block.position[i * 3]!, y = -block.position[i * 3 + 2]!;
    if (Math.abs(x - minX) < eps || Math.abs(x - maxX) < eps || Math.abs(y - minY) < eps || Math.abs(y - maxY) < eps) locked[i] = 1;
  }
  // Normals and tints weigh in the error: a skirt's hard edge, a paint's colour are kept where they matter (a tint only where it is drawn).
  const color = block.color;
  const stride = color ? 6 : 3;
  const attributes = new Float32Array(count * stride);
  for (let i = 0; i < count; i++) {
    const at = i * stride;
    attributes[at] = block.normal[i * 3]!; attributes[at + 1] = block.normal[i * 3 + 1]!; attributes[at + 2] = block.normal[i * 3 + 2]!;
    if (color) { attributes[at + 3] = color[i * 3]!; attributes[at + 4] = color[i * 3 + 1]!; attributes[at + 5] = color[i * 3 + 2]!; }
  }
  const from = block.index instanceof Uint32Array ? block.index : Uint32Array.from(block.index);
  const target = Math.max(6, Math.floor((indices * COARSE_RATIO) / 3) * 3);
  let kept: Uint32Array;
  try {
    [kept] = MeshoptSimplifier.simplifyWithAttributes(from, block.position, 3, attributes, stride, [0.4, 0.4, 0.4, 0.15, 0.15, 0.15].slice(0, stride), locked, target, COARSE_ERROR, ['ErrorAbsolute', 'Prune']);
  } catch (error) {
    // The block is drawn at full detail wherever it is: reported, not hidden.
    console.error('[road lod] a block could not be simplified', error);
    return null;
  }
  if (kept.length === 0 || kept.length >= indices) return null;
  // Only the vertices the coarse triangles use, in the order they are first used.
  const remap = new Int32Array(count).fill(-1);
  let used = 0;
  for (let i = 0; i < kept.length; i++) if (remap[kept[i]!]! < 0) remap[kept[i]!] = used++;
  const take = (src: Float32Array, size: number): Float32Array => {
    const out = new Float32Array(used * size);
    for (let v = 0; v < count; v++) {
      const at = remap[v]!;
      if (at < 0) continue;
      for (let k = 0; k < size; k++) out[at * size + k] = src[v * size + k]!;
    }
    return out;
  };
  const index = used > 0xffff ? new Uint32Array(kept.length) : new Uint16Array(kept.length);
  for (let i = 0; i < kept.length; i++) index[i] = remap[kept[i]!]!;
  const section = block.roadSection;
  return {
    position: take(block.position, 3), normal: take(block.normal, 3), uv: take(block.uv, 2),
    ...(color ? { color: take(color, 3) } : {}), ...(section ? { roadSection: take(section, 3) } : {}), index,
  };
}


import { MeshoptSimplifier } from 'meshoptimizer';

/**
 * The coarser levels of a person, simplified off the main thread: building
 * them there took a quarter of every frame while people came into view, and
 * the game stuttered each time a new kind of person appeared.
 *
 * In: positions, colours, the index, its material ranges and the levels
 * (share kept, error allowed). Out: per level, the index and its ranges.
 */
export interface LodRequest {
  readonly id: number;
  readonly positions: Float32Array;
  readonly colours: Float32Array;
  readonly index: Uint32Array;
  readonly ranges: readonly { start: number; count: number }[];
  /** Per level: share of triangles kept, error allowed, and whether the seams between garments may move (`loose`). */
  readonly levels: readonly (readonly [number, number, boolean?])[];
}

/** One index simplified to about `triangles` triangles (`simplifyIndex`): a procedural crowd's piece (`crowdLod.ts`). */
export interface IndexRequest {
  readonly id: number;
  readonly kind: 'index';
  readonly positions: Float32Array;
  readonly index: Uint32Array;
  readonly triangles: number;
}

export interface LodLevel {
  readonly index: Uint32Array;
  readonly groups: { start: number; count: number; materialIndex: number }[];
}

export function simplifyLevels(req: Omit<LodRequest, 'id'>): LodLevel[] {
  const out: LodLevel[] = [];
  for (const [ratio, error, loose] of req.levels) {
    const kept: number[] = [];
    const groups: { start: number; count: number; materialIndex: number }[] = [];
    req.ranges.forEach((range, materialIndex) => {
      const start = kept.length;
      if (range.count >= 3) {
        const part = req.index.slice(range.start, range.start + range.count);
        const target = Math.max(3, Math.floor((range.count * ratio) / 3) * 3);
        const [indices] = MeshoptSimplifier.simplifyWithAttributes(part, req.positions, 3, req.colours, 3, [0.6, 0.6, 0.6], null, target, error, loose ? ['Sparse'] : ['LockBorder', 'Sparse']);
        for (let i = 0; i < indices.length; i++) kept.push(indices[i]!);
      }
      groups.push({ start, count: kept.length - start, materialIndex });
    });
    out.push({ index: Uint32Array.from(kept), groups });
  }
  return out;
}

/**
 * `source` (triangles over `positions`) simplified to about `triangles`
 * triangles over the same vertices; `source` itself when it is within it,
 * null when the simplifier cannot run. No error bound: the budget decides,
 * the cheapest collapses first; attribute seams (UV splits) are kept
 * consistent by the simplifier. Too far over, the sloppy simplifier.
 */
export function simplifyIndex(source: Uint32Array, positions: Float32Array, triangles: number): Uint32Array | null {
  if (!Number.isFinite(triangles) || source.length <= triangles * 3) return source;
  if (!MeshoptSimplifier.supported || triangles <= 0) return null;
  const target = Math.max(3, Math.floor(triangles) * 3);
  try {
    let [kept] = MeshoptSimplifier.simplify(source, positions, 3, target, 1);
    if (kept.length > target * 1.3) [kept] = MeshoptSimplifier.simplifySloppy(source, positions, 3, null, target, 1);
    return kept;
  } catch {
    return null;
  }
}

// In a worker: answer each request.
const scope = globalThis as unknown as { onmessage: ((e: MessageEvent<LodRequest | IndexRequest>) => void) | null; postMessage?: (m: unknown, t: Transferable[]) => void; document?: unknown };
if (typeof scope.document === 'undefined' && typeof scope.postMessage === 'function' && typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined') {
  scope.onmessage = async (e) => {
    await MeshoptSimplifier.ready;
    const req = e.data;
    if ('kind' in req) {
      const index = simplifyIndex(req.index, req.positions, req.triangles);
      // The source comes back when it was kept whole: transferred, not copied.
      scope.postMessage!({ id: req.id, index }, index ? [index.buffer] : []);
      return;
    }
    const levels = simplifyLevels(req);
    scope.postMessage!({ id: req.id, levels }, levels.map((l) => l.index.buffer));
  };
}

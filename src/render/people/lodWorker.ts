import type { JobScope } from '../../jobs/jobScope';
import { MeshoptSimplifier } from 'meshoptimizer';

/** The coarser levels of a person, simplified off the main thread */
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

/** One welded mesh simplified once per error (`ladderIndices`): a vehicle part's levels (`vehicleLevels.ts`). */
export interface LadderRequest {
  readonly id: number;
  readonly kind: 'ladder';
  readonly positions: Float32Array;
  readonly attributes: Float32Array;
  readonly weights: readonly number[];
  readonly index: Uint32Array;
  /** Absolute errors, in the mesh's own units, finest first. */
  readonly errors: readonly number[];
}

/** `index` simplified to the fewest triangles each error allows (meshoptimizer README: `ErrorAbsolute`, `Prune`), finest first. */
export function ladderIndices(req: Omit<LadderRequest, 'id' | 'kind'>): Uint32Array[] {
  const stride = req.weights.length;
  return req.errors.map((error) => MeshoptSimplifier.simplifyWithAttributes(req.index, req.positions, 3, req.attributes, stride,
    [...req.weights], null, 3, error, ['ErrorAbsolute', 'Prune'])[0]);
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

/** `source` (triangles over `positions`) simplified to about `triangles` triangles over the same vertices */
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

/** The people's levels' service of the job system (`job.worker.ts`): each request answered. */
export function serve(self: JobScope): void {
  self.onmessage = async (e: MessageEvent<LodRequest | IndexRequest | LadderRequest>) => {
    const req = e.data;
    // Every request answered, a failure too (`lodPool.ts` rejects it)
    try {
      await MeshoptSimplifier.ready;
      if ('kind' in req && req.kind === 'ladder') {
        const ladder = ladderIndices(req);
        self.postMessage({ id: req.id, ladder }, ladder.map((l) => l.buffer));
        return;
      }
      if ('kind' in req) {
        const index = simplifyIndex(req.index, req.positions, req.triangles);
        // The source comes back when it was kept whole: transferred, not copied.
        self.postMessage({ id: req.id, index }, index ? [index.buffer] : []);
        return;
      }
      const levels = simplifyLevels(req);
      self.postMessage({ id: req.id, levels }, levels.map((l) => l.index.buffer));
    } catch (error) {
      console.error('[lod worker]', error);
      self.postMessage({ id: req.id, error: String(error) }, []);
    }
  };
}

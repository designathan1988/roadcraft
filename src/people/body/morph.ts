import { macroTargetWeights, type MacroDefinition, type MacroParams } from './macro';

/**
 * The MakeHuman base mesh, morphed: the person model's body (Person track H1).
 *
 * A body is the base mesh plus a weighted sum of targets. The macro targets
 * (sex, age, muscle, weight, ethnicity, height, proportions) come from the
 * principal-component pack, so however many of them a person blends, the work
 * is one pass over its 64 basis shapes; the breast macro targets and the 231
 * regional sliders (nose, ears, hands...) come from the sparse regional pack.
 *
 * Pure: it takes the decoded packs and returns positions. Loading the files is
 * `assets.ts`; the renderer turns positions into a mesh.
 */

/** `base.json` (the parts used here). */
export interface BaseMeta {
  readonly vertexCount: number;
  readonly sections: readonly { readonly name: string; readonly type: string; readonly itemSize: number; readonly count: number; readonly byteOffset: number }[];
  readonly faceGroups: readonly string[];
  readonly vertexGroups: Readonly<Record<string, readonly (readonly [number, number])[]>>;
}

/** `targets-macro-pca.json`. */
export interface MacroPcaMeta {
  readonly components: number;
  readonly vertexCount: number;
  readonly layout: {
    readonly basis: { readonly byteOffset: number; readonly count: number; readonly scales: readonly number[] };
    readonly coefficients: { readonly byteOffset: number; readonly count: number };
    readonly residualIndices: { readonly byteOffset: number; readonly count: number };
    readonly residualDeltas: { readonly byteOffset: number; readonly count: number };
  };
  readonly targets: readonly { readonly name: string; readonly row: number; readonly residualStart: number; readonly residualCount: number; readonly residualScale: number }[];
}

/** `targets-local.json`. */
export interface LocalMeta {
  readonly entryCount: number;
  readonly layout: { readonly indices: { readonly byteOffset: number }; readonly deltas: { readonly byteOffset: number } };
  readonly targets: readonly { readonly name: string; readonly group: string; readonly start: number; readonly count: number; readonly scale: number }[];
}

/** One regional slider (`modifiers.json` `.regional[group].categories[]`). */
export interface RegionalCategory {
  readonly name: string;
  readonly has_left_and_right: boolean;
  /** Two-way sliders: the target either way. One-target sliders (`head-oval`) have none. */
  readonly opposites?: Readonly<Record<string, string>>;
  readonly targets?: readonly string[];
}

export interface PeoplePacks {
  readonly base: BaseMeta;
  readonly baseBin: ArrayBuffer;
  readonly macro: MacroPcaMeta;
  readonly macroBin: ArrayBuffer;
  readonly local: LocalMeta;
  readonly localBin: ArrayBuffer;
  readonly modifiers: {
    readonly macro: MacroDefinition;
    readonly regional: Readonly<Record<string, { readonly categories: readonly RegionalCategory[] }>>;
  };
}

/**
 * A regional slider's value, -1..1: negative towards its "decr/down/..."
 * target, positive towards the other. Sided sliders take `l-`/`r-` keys, or
 * the bare name for both sides together.
 */
export type RegionalValues = Readonly<Record<string, number>>;

export class Morpher {
  readonly vertexCount: number;
  /** Base positions, decimetres, the OBJ frame (+Y up, +Z forward). */
  readonly base: Float32Array;
  private readonly basis: Int16Array;
  private readonly coeff: Float32Array;
  private readonly rIdx: Uint16Array;
  private readonly rDelta: Int16Array;
  private readonly lIdx: Uint16Array;
  private readonly lDelta: Int16Array;
  private readonly macroNames: string[];
  private readonly macroRow = new Map<string, MacroPcaMeta['targets'][number]>();
  private readonly localByName = new Map<string, LocalMeta['targets'][number]>();
  /** Every regional slider, by name. */
  readonly sliders = new Map<string, { readonly group: string; readonly category: RegionalCategory }>();

  constructor(private readonly packs: PeoplePacks) {
    const { base, baseBin, macro, macroBin, local, localBin } = packs;
    this.vertexCount = base.vertexCount;
    const positions = base.sections.find((s) => s.name === 'positions');
    if (!positions) throw new Error('base.json has no positions');
    this.base = new Float32Array(baseBin, positions.byteOffset, base.vertexCount * 3);
    const D = macro.vertexCount * 3;
    if (macro.vertexCount !== base.vertexCount) throw new Error('macro pack and base mesh disagree on the vertex count');
    this.basis = new Int16Array(macroBin, macro.layout.basis.byteOffset, macro.components * D);
    this.coeff = new Float32Array(macroBin, macro.layout.coefficients.byteOffset, macro.layout.coefficients.count);
    this.rIdx = new Uint16Array(macroBin, macro.layout.residualIndices.byteOffset, macro.layout.residualIndices.count);
    this.rDelta = new Int16Array(macroBin, macro.layout.residualDeltas.byteOffset, macro.layout.residualDeltas.count * 3);
    this.lIdx = new Uint16Array(localBin, local.layout.indices.byteOffset, local.entryCount);
    this.lDelta = new Int16Array(localBin, local.layout.deltas.byteOffset, local.entryCount * 3);
    this.macroNames = macro.targets.map((t) => t.name);
    for (const t of macro.targets) this.macroRow.set(t.name, t);
    for (const t of local.targets) this.localByName.set(t.name, t);
    for (const [group, { categories }] of Object.entries(packs.modifiers.regional)) {
      for (const category of categories) this.sliders.set(category.name, { group, category });
    }
  }

  /** How many basis shapes the macro sliders fold into (`shape`). */
  get components(): number {
    return this.packs.macro.components;
  }

  /**
   * The macro sliders folded into one coefficient per basis shape, as `shape`
   * folds them: the body's macro part is the base plus the sum over k of
   * `coefficients[k]` times `component(k)` (less each target's residual).
   */
  coefficients(params: MacroParams): Float64Array {
    const K = this.packs.macro.components;
    const c = new Float64Array(K);
    for (const [name, w] of macroTargetWeights(this.packs.modifiers.macro, this.macroNames, params)) {
      const t = this.macroRow.get(name);
      if (!t) continue;
      for (let k = 0; k < K; k++) c[k] = (c[k] ?? 0) + w * (this.coeff[t.row * K + k] ?? 0);
    }
    return c;
  }

  /** Basis shape `k` as moves of the base mesh per unit of its coefficient, decimetres. */
  component(k: number, out?: Float32Array): Float32Array {
    const D = this.vertexCount * 3;
    const result = out && out.length === D ? out : new Float32Array(D);
    const scale = this.packs.macro.layout.basis.scales[k] ?? 0;
    const offset = k * D;
    for (let j = 0; j < D; j++) result[j] = scale * (this.basis[offset + j] ?? 0);
    return result;
  }

  /** The breast macro targets live in the regional pack; the rest in the PCA one. */
  private breastNames(): string[] {
    return this.packs.local.targets.filter((t) => t.group === 'breast').map((t) => t.name);
  }

  /**
   * The body for these macro sliders and regional values, as positions in the
   * base frame (decimetres). `out` is reused when given.
   */
  shape(params: MacroParams, regional: RegionalValues = {}, out?: Float32Array): Float32Array {
    const D = this.vertexCount * 3;
    const result = out && out.length === D ? out : new Float32Array(D);
    result.set(this.base);
    const K = this.packs.macro.components;
    const scales = this.packs.macro.layout.basis.scales;

    // Macro: the weights fold into one coefficient per basis shape...
    const weights = macroTargetWeights(this.packs.modifiers.macro, this.macroNames, params);
    const c = new Float64Array(K);
    for (const [name, w] of weights) {
      const t = this.macroRow.get(name);
      if (!t) continue;
      for (let k = 0; k < K; k++) c[k] = (c[k] ?? 0) + w * (this.coeff[t.row * K + k] ?? 0);
    }
    for (let k = 0; k < K; k++) {
      const ck = (c[k] ?? 0) * (scales[k] ?? 0);
      if (ck === 0) continue;
      const offset = k * D;
      for (let j = 0; j < D; j++) result[j] = (result[j] ?? 0) + ck * (this.basis[offset + j] ?? 0);
    }
    // ...and each target's own residual is added at its weight.
    for (const [name, w] of weights) {
      const t = this.macroRow.get(name);
      if (!t) continue;
      const s = w * t.residualScale;
      for (let e = t.residualStart; e < t.residualStart + t.residualCount; e++) {
        const v = (this.rIdx[e] ?? 0) * 3;
        result[v] = (result[v] ?? 0) + s * (this.rDelta[e * 3] ?? 0);
        result[v + 1] = (result[v + 1] ?? 0) + s * (this.rDelta[e * 3 + 1] ?? 0);
        result[v + 2] = (result[v + 2] ?? 0) + s * (this.rDelta[e * 3 + 2] ?? 0);
      }
    }

    // Breast macro targets (sparse, regional pack).
    for (const [name, w] of macroTargetWeights(this.packs.modifiers.macro, this.breastNames(), params)) this.addLocal(result, name, w);

    this.addRegional(result, regional);
    return result;
  }

  /**
   * The regional sliders' moves added into `into` (decimetres, base frame):
   * sparse targets summed at their weights, as MakeHuman applies a target
   * (`algos3d.Target.apply`), whatever the macro shape under them. `shape`
   * is the macro body plus exactly this.
   */
  addRegional(into: Float32Array, regional: RegionalValues): void {
    for (const [key, value] of Object.entries(regional)) {
      if (!value) continue;
      const side = key.startsWith('l-') ? 'left' : key.startsWith('r-') ? 'right' : null;
      const name = side ? key.slice(2) : key;
      const slider = this.sliders.get(name);
      if (!slider) continue;
      const sign = value < 0 ? 'negative' : 'positive';
      const sides = slider.category.has_left_and_right ? (side ? [side] : ['left', 'right']) : ['unsided'];
      for (const s of sides) {
        // A one-target slider (a head shape) only goes one way, 0..1.
        const target = slider.category.opposites
          ? slider.category.opposites[`${sign}-${s}`]
          : value > 0 ? slider.category.targets?.[0] : undefined;
        if (target) this.addLocal(into, `${slider.group}/${target}`, Math.min(1, Math.abs(value)));
      }
    }
  }

  /**
   * `bodyHeight(shape(params), bodyRange)` from the heights alone: only each
   * vertex's Y of the macro sum, its residuals and the breast targets - a
   * third of the work of the whole shape, for a body's standing height.
   */
  height(params: MacroParams, bodyRange: readonly (readonly [number, number])[]): number {
    const K = this.packs.macro.components;
    const table = this.heightTable(bodyRange);
    const weights = macroTargetWeights(this.packs.modifiers.macro, this.macroNames, params);
    const c = new Float64Array(K);
    for (const [name, w] of weights) {
      const t = this.macroRow.get(name);
      if (!t) continue;
      for (let k = 0; k < K; k++) c[k] = (c[k] ?? 0) + w * (this.coeff[t.row * K + k] ?? 0);
    }
    // The sparse moves - each macro target's residual, the breast targets -
    // as one weight a source (`sources`); their entries are read per vertex,
    // only for the vertices measured.
    const { baseY, yBasis, starts, top, bottom, lead, reach, sources, entryStart, entrySource, entryDy, sourceReach } = table;
    const S = sources.length;
    const sourceWeight = new Float64Array(S);
    const active: number[] = [];
    for (const [name, w] of weights) {
      const s = this.residualSource.get(name);
      const t = this.macroRow.get(name);
      if (s === undefined || !t || w === 0) continue;
      sourceWeight[s] = w * t.residualScale;
      active.push(s);
    }
    for (const [name, w] of macroTargetWeights(this.packs.modifiers.macro, this.breastNames(), params)) {
      const s = this.breastSource.get(name);
      const t = this.localByName.get(name);
      if (s === undefined || !t || w === 0) continue;
      sourceWeight[s] = w * t.scale;
      active.push(s);
    }
    const yOf = (i: number): number => {
      let y = baseY[i]!;
      const at = i * K;
      for (let k = 0; k < K; k++) y += (c[k] ?? 0) * yBasis[at + k]!;
      for (let e = entryStart[i]!; e < entryStart[i + 1]!; e++) y += sourceWeight[entrySource[e]!]! * entryDy[e]!;
      return y;
    };
    // Branch and bound over small clusters of neighbouring vertices: the
    // basis shapes and the sparse targets move no vertex of a cluster farther
    // up or down than the cluster's bound (each one's largest move there, by
    // its weight), so a cluster whose highest base plus its bound stays under
    // the highest point found holds no higher one - and likewise for the
    // lowest. The same max and min as every vertex measured (`bodyHeight` of
    // the whole shape).
    // A cluster moves as its first vertex does (`lead`), give or take how far
    // any of its vertices strays from that under each shape (`reach`).
    const clusters = starts.length - 1;
    const upper = new Float64Array(clusters);
    const lower = new Float64Array(clusters);
    for (let g = 0; g < clusters; g++) {
      let move = 0, b = 0;
      const at = g * K;
      for (let k = 0; k < K; k++) {
        const ck = c[k] ?? 0;
        move += ck * lead[at + k]!;
        b += Math.abs(ck) * reach[at + k]!;
      }
      for (const s of active) b += Math.abs(sourceWeight[s]!) * sourceReach[g * S + s]!;
      // (A hair over the bound, for the rounding of the sums.)
      upper[g] = top[g]! + move + b + 1e-9;
      lower[g] = bottom[g]! + move - b - 1e-9;
    }
    let lo = Infinity, hi = -Infinity;
    const ids = Array.from({ length: clusters }, (_, g) => g);
    ids.sort((p, q) => upper[q]! - upper[p]!);
    for (const g of ids) {
      if (upper[g]! < hi) break;
      for (let i = starts[g]!; i < starts[g + 1]!; i++) { const y = yOf(i); if (y > hi) hi = y; }
    }
    ids.sort((p, q) => lower[p]! - lower[q]!);
    for (const g of ids) {
      if (lower[g]! > lo) break;
      for (let i = starts[g]!; i < starts[g + 1]!; i++) { const y = yOf(i); if (y < lo) lo = y; }
    }
    return hi - lo;
  }

  /** `height`'s tables for one body range, built once. */
  private heightTables = new WeakMap<object, {
    /** The range's vertices, cluster by cluster. */
    readonly order: Int32Array;
    /** A vertex's place in `order` (only in range). */
    readonly rank: Int32Array;
    readonly inRange: Uint8Array;
    /** Base heights in `order`. */
    readonly baseY: Float64Array;
    /** Each basis shape's Y move per unit coefficient, `K` a vertex, in `order`. */
    readonly yBasis: Float32Array;
    /** Where each cluster starts in `order` (one more entry: the end). */
    readonly starts: Int32Array;
    /** Each cluster's highest and lowest base height. */
    readonly top: Float64Array;
    readonly bottom: Float64Array;
    /** Each cluster's first vertex's Y move of each basis shape, per unit coefficient, `K` a cluster. */
    readonly lead: Float64Array;
    /** How far any vertex of a cluster strays from `lead` under each basis shape, `K` a cluster. */
    readonly reach: Float64Array;
    /** The sparse sources: each macro target's residual, then each breast target. */
    readonly sources: readonly string[];
    /** Each vertex's sparse entries (in `order`): where they start (one more: the end), their source and raw Y move. */
    readonly entryStart: Int32Array;
    readonly entrySource: Uint16Array;
    readonly entryDy: Float32Array;
    /** Each cluster's largest raw Y move of each source, `sources.length` a cluster. */
    readonly sourceReach: Float32Array;
  }>();
  /** A macro target's (a breast target's) place among the sparse sources (`heightTable`). */
  private readonly residualSource = new Map<string, number>();
  private readonly breastSource = new Map<string, number>();

  private heightTable(bodyRange: readonly (readonly [number, number])[]) {
    const known = this.heightTables.get(bodyRange);
    if (known) return known;
    const n = this.vertexCount;
    const D = n * 3;
    const K = this.packs.macro.components;
    const scales = this.packs.macro.layout.basis.scales;
    const inRange = new Uint8Array(n);
    for (const [a, b] of bodyRange) for (let v = a; v <= b; v++) inRange[v] = 1;
    // Clusters: the base mesh's vertices by a grid of 0.4 dm cells, so the
    // vertices of a cluster move alike under every basis shape.
    const CELL = 0.4;
    const byCell = new Map<string, number[]>();
    for (let v = 0; v < n; v++) {
      if (!inRange[v]) continue;
      const key = `${Math.floor(this.base[v * 3]! / CELL)}:${Math.floor(this.base[v * 3 + 1]! / CELL)}:${Math.floor(this.base[v * 3 + 2]! / CELL)}`;
      const list = byCell.get(key);
      if (list) list.push(v); else byCell.set(key, [v]);
    }
    const groups = [...byCell.values()];
    const count = groups.reduce((s, g) => s + g.length, 0);
    const order = new Int32Array(count);
    const rank = new Int32Array(n).fill(-1);
    const baseY = new Float64Array(count);
    const yBasis = new Float32Array(count * K);
    const starts = new Int32Array(groups.length + 1);
    const top = new Float64Array(groups.length).fill(-Infinity);
    const bottom = new Float64Array(groups.length).fill(Infinity);
    const lead = new Float64Array(groups.length * K);
    const reach = new Float64Array(groups.length * K);
    let i = 0;
    groups.forEach((list, g) => {
      starts[g] = i;
      for (const v of list) {
        order[i] = v;
        rank[v] = i;
        const y = this.base[v * 3 + 1]!;
        baseY[i] = y;
        if (y > top[g]!) top[g] = y;
        if (y < bottom[g]!) bottom[g] = y;
        for (let k = 0; k < K; k++) {
          const dy = Math.fround((scales[k] ?? 0) * (this.basis[k * D + v * 3 + 1] ?? 0));
          yBasis[i * K + k] = dy;
          if (i === starts[g]) lead[g * K + k] = dy;
          const stray = Math.abs(dy - lead[g * K + k]!);
          if (stray > reach[g * K + k]!) reach[g * K + k] = stray;
        }
        i++;
      }
    });
    starts[groups.length] = i;
    // The sparse sources, transposed to the vertices: each vertex's entries
    // of every macro target's residual and every breast target.
    const sources: string[] = [];
    // Each source's entries as (index list, delta list), visited twice: once
    // to count each vertex's entries, once to file them.
    const lists: { readonly source: number; readonly idx: Uint16Array; readonly delta: Int16Array; readonly from: number; readonly to: number }[] = [];
    for (const t of this.packs.macro.targets) {
      this.residualSource.set(t.name, sources.length);
      lists.push({ source: sources.length, idx: this.rIdx, delta: this.rDelta, from: t.residualStart, to: t.residualStart + t.residualCount });
      sources.push(t.name);
    }
    for (const t of this.packs.local.targets) {
      if (t.group !== 'breast') continue;
      this.breastSource.set(t.name, sources.length);
      lists.push({ source: sources.length, idx: this.lIdx, delta: this.lDelta, from: t.start, to: t.start + t.count });
      sources.push(t.name);
    }
    const S = sources.length;
    const entryStart = new Int32Array(count + 1);
    for (const l of lists) for (let e = l.from; e < l.to; e++) { const v = l.idx[e] ?? 0; if (inRange[v]) entryStart[rank[v]! + 1]!++; }
    for (let j = 0; j < count; j++) entryStart[j + 1] = entryStart[j + 1]! + entryStart[j]!;
    const fill = entryStart.slice();
    const total = entryStart[count]!;
    const entrySource = new Uint16Array(total);
    const entryDy = new Float32Array(total);
    const clusterOf = new Int32Array(count);
    for (let g = 0; g < groups.length; g++) for (let j = starts[g]!; j < starts[g + 1]!; j++) clusterOf[j] = g;
    const sourceReach = new Float32Array(groups.length * S);
    for (const l of lists) {
      for (let e = l.from; e < l.to; e++) {
        const v = l.idx[e] ?? 0;
        if (!inRange[v]) continue;
        const j = rank[v]!;
        const at = fill[j]!++;
        const dy = l.delta[e * 3 + 1] ?? 0;
        entrySource[at] = l.source;
        entryDy[at] = dy;
        const slot = clusterOf[j]! * S + l.source;
        if (Math.abs(dy) > sourceReach[slot]!) sourceReach[slot] = Math.abs(dy);
      }
    }
    const table = { order, rank, inRange, baseY, yBasis, starts, top, bottom, lead, reach, sources, entryStart, entrySource, entryDy, sourceReach };
    this.heightTables.set(bodyRange, table);
    return table;
  }

  private addLocal(into: Float32Array, name: string, w: number): void {
    const t = this.localByName.get(name);
    if (!t || w === 0) return;
    const s = w * t.scale;
    for (let e = t.start; e < t.start + t.count; e++) {
      const v = (this.lIdx[e] ?? 0) * 3;
      into[v] = (into[v] ?? 0) + s * (this.lDelta[e * 3] ?? 0);
      into[v + 1] = (into[v + 1] ?? 0) + s * (this.lDelta[e * 3 + 1] ?? 0);
      into[v + 2] = (into[v + 2] ?? 0) + s * (this.lDelta[e * 3 + 2] ?? 0);
    }
  }
}

/** Standing height of a body, from its lowest to its highest skin vertex, decimetres. */
export function bodyHeight(positions: Float32Array, bodyRange: readonly (readonly [number, number])[]): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const [a, b] of bodyRange) {
    for (let v = a; v <= b; v++) {
      const y = positions[v * 3 + 1] ?? 0;
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
  }
  return hi - lo;
}

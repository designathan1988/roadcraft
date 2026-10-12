import type { ProxyPack } from '../body/proxy';

/**
 * Procedural hairstyles, as MakeHuman hair items (`ProxyPack`), so the crowd
 * draws, fits and dyes them as it does any other hair.
 *
 * The pipeline games use for hair cards (Houdini's Hair Card Generate,
 * Unreal's Hair Card Generator): guide strands grown from the scalp, each
 * the centre of a clump, and each clump drawn as a strip or two of polygons
 * - cards - carrying a texture of many strands (`render/people/hairTexture`).
 * Here the guides are grown by the style's parameters instead of groomed:
 * combed away from a parting, pulled down by gravity, sliding over the skull
 * and the shoulders (an ellipsoid and a tapered body), waved, cut to length,
 * a fringe brushed forwards, or gathered into a ponytail or a bun.
 *
 * Built once per style on the MakeHuman base mesh (decimetres, +Y up, +Z
 * forwards, +X the body's left); every card vertex is pinned to the scalp
 * vertices nearest it, so on each body it follows that body's head
 * (`fitProxy`), as the stock hair does.
 */

export interface HairStyle {
  readonly name: string;
  /** Strand length from the root, decimetres. */
  readonly length: number;
  /** The parting across the head, -1 (right) .. 1 (left); 0 a centre parting. */
  readonly part: number;
  /** How far the hair stands off the skull, decimetres. */
  readonly volume: number;
  /** How hard each step bends down, 0..1. */
  readonly gravity: number;
  readonly wave?: { readonly amplitude: number; readonly wavelength: number };
  readonly fringe?: { readonly length: number; readonly width: number };
  /**
   * Gathered at a point of the head, then a tail (plaited when `braid`) or a
   * bun; at two points (`also`, mirrored across the head) for pigtails.
   */
  readonly gather?: { readonly at: readonly [number, number, number]; readonly tail: number; readonly bun?: number; readonly braid?: boolean; readonly twin?: boolean };
  /** Each strand wound in a helix: corkscrew curls. */
  readonly curl?: { readonly radius: number; readonly pitch: number };
  /** All the hair brushed towards one side, -1 (right) .. 1 (left). */
  readonly sweep?: number;
  /** Brushed straight back from the brow (a slick). */
  readonly back?: boolean;
  /** The front lifted up and back off the brow (a quiff), decimetres. */
  readonly quiff?: number;
  /** Worn with a headband (`acc:headband`, `generateHeadband`). */
  readonly headband?: boolean;
  /**
   * Length by region of the head, as multipliers of `length` - front, crown,
   * temples, back of the head, nape - blended by where the root is: how a
   * fade, a crop or a bob's shape is set (as Mirage Mane's hair catalogue does).
   */
  readonly regions?: { readonly front?: number; readonly crown?: number; readonly temple?: number; readonly occipital?: number; readonly nape?: number };
  /** Guides (clumps), and the width of each clump's card, decimetres. */
  readonly clumps: number;
  readonly cardWidth: number;
  /** Two cards a clump for body; short crops lie flat with one. */
  readonly layers: 1 | 2;
  /** The texture's strands: 'straight' or 'wavy'. */
  readonly strands: 'straight' | 'wavy';
}

/** The styles by name; the hair editor (`people-lab.html?editor`) adds its own. */
export const HAIR_STYLES: Record<string, HairStyle> = {
  longStraight: { name: 'longStraight', length: 4.6, part: 0.25, volume: 0.1, gravity: 0.55, clumps: 230, cardWidth: 0.42, layers: 2, strands: 'straight' },
  longWavy: { name: 'longWavy', length: 4.4, part: -0.3, volume: 0.16, gravity: 0.5, wave: { amplitude: 0.07, wavelength: 1.3 }, clumps: 230, cardWidth: 0.44, layers: 2, strands: 'wavy' },
  midLayered: { name: 'midLayered', length: 3.0, part: 0.35, volume: 0.14, gravity: 0.5, wave: { amplitude: 0.06, wavelength: 1.4 }, clumps: 220, cardWidth: 0.42, layers: 2, strands: 'straight' },
  bob: { name: 'bob', regions: { front: 0.95, crown: 0.95, temple: 1.05, occipital: 1, nape: 0.85 }, length: 1.9, part: 0.3, volume: 0.12, gravity: 0.6, clumps: 220, cardWidth: 0.4, layers: 2, strands: 'straight' },
  bobFringe: { name: 'bobFringe', length: 1.8, part: 0, volume: 0.12, gravity: 0.6, fringe: { length: 1.25, width: 0.55 }, clumps: 220, cardWidth: 0.4, layers: 2, strands: 'straight' },
  ponytail: { name: 'ponytail', length: 3.4, part: 0, volume: 0.05, gravity: 0.5, gather: { at: [0, 7.75, -0.55], tail: 3.2 }, clumps: 200, cardWidth: 0.36, layers: 2, strands: 'straight' },
  bun: { name: 'bun', length: 2.0, part: 0, volume: 0.05, gravity: 0.5, gather: { at: [0, 8.05, -0.45], tail: 0, bun: 0.42 }, clumps: 200, cardWidth: 0.36, layers: 2, strands: 'straight' },
  ponytailFringe: { name: 'ponytailFringe', length: 3.4, part: 0, volume: 0.05, gravity: 0.5, fringe: { length: 1.2, width: 0.55 }, gather: { at: [0, 7.75, -0.55], tail: 3.2 }, clumps: 210, cardWidth: 0.34, layers: 2, strands: 'straight' },
  longFringe: { name: 'longFringe', length: 4.6, part: 0, volume: 0.1, gravity: 0.55, fringe: { length: 1.25, width: 0.55 }, clumps: 240, cardWidth: 0.4, layers: 2, strands: 'straight' },
  longHeadband: { name: 'longHeadband', length: 4.6, part: 0, volume: 0.08, gravity: 0.55, back: true, headband: true, clumps: 230, cardWidth: 0.42, layers: 2, strands: 'straight' },
  shoulderBob: { name: 'shoulderBob', length: 2.6, part: 0.25, volume: 0.12, gravity: 0.6, clumps: 230, cardWidth: 0.42, layers: 2, strands: 'straight' },
  fade: { name: 'fade', regions: { front: 1.1, crown: 1, temple: 0.35, occipital: 0.5, nape: 0.25 }, length: 0.75, part: 0.3, volume: 0.06, gravity: 0.1, clumps: 220, cardWidth: 0.32, layers: 1, strands: 'straight' },
  buzz: { name: 'buzz', length: 0.22, part: 0, volume: 0.02, gravity: 0, back: true, clumps: 220, cardWidth: 0.34, layers: 1, strands: 'straight' },
  slickedBack: { name: 'slickedBack', length: 1.5, part: 0, volume: 0.06, gravity: 0.15, back: true, clumps: 200, cardWidth: 0.36, layers: 1, strands: 'straight' },
  quiff: { name: 'quiff', regions: { front: 1.4, crown: 1.05, temple: 0.45, occipital: 0.6, nape: 0.35 }, length: 0.9, part: 0.3, volume: 0.07, gravity: 0.1, quiff: 0.35, clumps: 220, cardWidth: 0.34, layers: 1, strands: 'straight' },
  manBun: { name: 'manBun', length: 1.8, part: 0, volume: 0.05, gravity: 0.4, back: true, gather: { at: [0, 8.1, -0.5], tail: 0, bun: 0.32 }, clumps: 200, cardWidth: 0.34, layers: 2, strands: 'straight' },
  longMale: { name: 'longMale', length: 3.0, part: 0.1, volume: 0.1, gravity: 0.55, clumps: 220, cardWidth: 0.4, layers: 2, strands: 'straight' },
  curlyShort: { name: 'curlyShort', length: 0.8, part: 0, volume: 0.16, gravity: 0.1, curl: { radius: 0.06, pitch: 0.22 }, clumps: 260, cardWidth: 0.24, layers: 1, strands: 'wavy' },
  afro: { name: 'afro', length: 1.5, part: 0, volume: 0.85, gravity: 0.02, curl: { radius: 0.09, pitch: 0.24 }, clumps: 300, cardWidth: 0.26, layers: 2, strands: 'wavy' },
  shortCrop: { name: 'shortCrop', regions: { front: 1.2, crown: 1, temple: 0.55, occipital: 0.7, nape: 0.45 }, length: 0.55, part: 0.4, volume: 0.05, gravity: 0.1, clumps: 160, cardWidth: 0.34, layers: 1, strands: 'straight' },
  pigtails: { name: 'pigtails', length: 2.6, part: 0, volume: 0.05, gravity: 0.5, gather: { at: [0.62, 7.55, -0.2], tail: 2.4, twin: true }, clumps: 200, cardWidth: 0.34, layers: 2, strands: 'straight' },
  braid: { name: 'braid', length: 3.4, part: 0, volume: 0.05, gravity: 0.5, gather: { at: [0, 7.45, -0.6], tail: 3.6, braid: true }, clumps: 200, cardWidth: 0.32, layers: 2, strands: 'straight' },
  twinBraids: { name: 'twinBraids', length: 3, part: 0, volume: 0.05, gravity: 0.5, gather: { at: [0.6, 7.3, -0.25], tail: 3.2, braid: true, twin: true }, clumps: 200, cardWidth: 0.32, layers: 2, strands: 'straight' },
  curly: { name: 'curly', length: 2.3, part: 0, volume: 0.45, gravity: 0.3, curl: { radius: 0.16, pitch: 0.45 }, clumps: 260, cardWidth: 0.3, layers: 2, strands: 'wavy' },
  sideSwept: { name: 'sideSwept', length: 3.6, part: 0.85, volume: 0.12, gravity: 0.5, sweep: 0.7, clumps: 230, cardWidth: 0.42, layers: 2, strands: 'straight' },
  pixie: { name: 'pixie', length: 0.75, part: 0.6, volume: 0.1, gravity: 0.15, fringe: { length: 0.9, width: 0.6 }, sweep: 0.5, clumps: 220, cardWidth: 0.32, layers: 1, strands: 'straight' },
  topKnot: { name: 'topKnot', length: 2.2, part: 0, volume: 0.05, gravity: 0.4, gather: { at: [0, 8.55, 0.15], tail: 0, bun: 0.38 }, clumps: 200, cardWidth: 0.34, layers: 2, strands: 'straight' },
  shortSide: { name: 'shortSide', regions: { front: 1.25, crown: 1.05, temple: 0.55, occipital: 0.72, nape: 0.42 }, length: 0.95, part: 0.5, volume: 0.08, gravity: 0.15, clumps: 160, cardWidth: 0.34, layers: 1, strands: 'straight' },
};

/**
 * Drawn for the crowd: straight hair only (the player, 2026-10-05: "faça
 * cabelo liso, nada de afro"); the wavy and curly styles stay for the editor.
 */
export const FEMALE_HAIR = ['longStraight', 'midLayered', 'bob', 'bobFringe', 'ponytail', 'bun',
  'pigtails', 'braid', 'twinBraids', 'sideSwept', 'pixie', 'topKnot',
  'ponytailFringe', 'longFringe', 'longHeadband', 'shoulderBob'] as const;
export const MALE_HAIR = ['shortCrop', 'shortSide', 'fade', 'buzz', 'slickedBack', 'quiff', 'manBun', 'longMale'] as const;

export interface HairBase {
  /** The base mesh, decimetres. */
  readonly positions: Float32Array;
  readonly vertexCount: number;
  readonly bodyRange: readonly (readonly [number, number])[];
  readonly joints: Uint8Array;
  readonly weights: Uint16Array;
  readonly boneNames: readonly string[];
  /** Quads (a, b, c, d), d === c for a triangle. */
  readonly faces: Uint16Array;
}

type V3 = [number, number, number];
const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The skull as an ellipsoid, from the head-bone vertices of the base mesh. */
interface Skull { readonly c: V3; readonly r: V3 }

/** Where the hair grows: above a hairline that runs low at the nape, high on the brow. */
function hairlineY(theta: number): number {
  const a = Math.abs(theta);
  // Low at the temples and over the ears (down to the top of the ear), as a
  // real hairline: set higher, the sides read as shaved (the player: "mulher
  // não usa cabeça com lateral raspada").
  // Sideburn down to mid-ear (1.3), over the ear just above it (1.55),
  // behind it down to the lobe, the nape at the lobe's height.
  const knots: [number, number][] = [[0, 0.36], [0.6, 0.3], [1.0, 0.0], [1.3, -0.35], [1.55, -0.1], [1.85, -0.35], [2.2, -0.62], [2.6, -0.78], [Math.PI, -0.82]];
  // Never a perfect curve: a little irregular, as a real hairline is.
  const wobble = 0.035 * Math.sin(theta * 9 + 0.7) + 0.02 * Math.sin(theta * 23 + 2.1);
  for (let i = 1; i < knots.length; i++) {
    const [x0, y0] = knots[i - 1]!, [x1, y1] = knots[i]!;
    if (a <= x1) return y0 + (y1 - y0) * (a - x0) / (x1 - x0) + wobble;
  }
  return -0.55 + wobble;
}

/** The head on the base mesh: its vertices, and the skull as an ellipsoid. */
function headOf(base: HairBase) {
  const P = base.positions;
  const at = (v: number): V3 => [P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!];
  const head = base.boneNames.indexOf('head');
  const inBody = (v: number): boolean => base.bodyRange.some(([a, b]) => v >= a && v <= b);
  const headVerts: number[] = [];
  for (let v = 0; v < base.vertexCount; v++) {
    if (!inBody(v)) continue;
    let w = 0;
    for (let k = 0; k < 4; k++) if (base.joints[v * 4 + k] === head) w += base.weights[v * 4 + k]! / 65535;
    // Half the head's is enough: the nape's skin is shared with the neck
    // bone, and left out the hair stopped above it.
    if (w >= 0.5) headVerts.push(v);
  }
  // The cranium: the head's box less the face's jut (nose, chin).
  let lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const v of headVerts) {
    const p = at(v);
    lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1]), Math.min(lo[2], p[2])];
    hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1]), Math.max(hi[2], p[2])];
  }
  const ry = (hi[1] - lo[1]) * 0.39;
  const skull: Skull = { c: [0, hi[1] - ry, lo[2] + (hi[1] - lo[1]) * 0.36], r: [(hi[0] - lo[0]) * 0.47, ry, (hi[1] - lo[1]) * 0.375] };
  const local = (p: V3): V3 => [(p[0] - skull.c[0]) / skull.r[0], (p[1] - skull.c[1]) / skull.r[1], (p[2] - skull.c[2]) / skull.r[2]];
  const outward = (p: V3): V3 => { const q = local(p); return norm([q[0] / skull.r[0], q[1] / skull.r[1], q[2] / skull.r[2]]); };
  return { P, at, headVerts, skull, local, outward };
}

/**
 * The three anchors nearest a point, as [squared distance, vertex], nearest
 * first; equal distances go to the anchor earlier in the list. A k-d tree
 * (Friedman, Bentley and Finkel 1977): a hairstyle pins tens of thousands of
 * vertices to some three thousand head vertices, and the search over all of
 * them stalled the game 70-225 ms on each new hairstyle. A uniform grid was
 * tried first: hair standing well off the scalp (an afro) made it sweep most
 * of its cells per point, and a NaN point never ended it (docs/performance.md #5).
 */
export function nearestThree(P: ArrayLike<number>, anchors: readonly number[]): (p: V3) => [number, number][] {
  // The tree: anchors (as their order in the list) laid out in place, each
  // node the median of its range on the axis of its depth.
  const order = Int32Array.from(anchors.keys());
  const coord = (o: number, axis: number): number => P[anchors[o]! * 3 + axis]!;
  // Each subtree's box, kept at its median's slot: a point far from the head
  // has every anchor about as far, and only the boxes tell the subtrees apart.
  const box = new Float64Array(order.length * 6);
  const build = (lo: number, hi: number, axis: number): void => {
    if (hi <= lo) return;
    const mid = (lo + hi) >> 1;
    const part = Array.from(order.subarray(lo, hi)).sort((a, b) => coord(a, axis) - coord(b, axis) || a - b);
    order.set(part, lo);
    for (let c = 0; c < 3; c++) { box[mid * 6 + c] = Infinity; box[mid * 6 + 3 + c] = -Infinity; }
    for (let i = lo; i < hi; i++) for (let c = 0; c < 3; c++) {
      const x = coord(order[i]!, c);
      if (x < box[mid * 6 + c]!) box[mid * 6 + c] = x;
      if (x > box[mid * 6 + 3 + c]!) box[mid * 6 + 3 + c] = x;
    }
    build(lo, mid, (axis + 1) % 3);
    build(mid + 1, hi, (axis + 1) % 3);
  };
  build(0, order.length, 0);
  // The search's state, reused (no allocation per candidate): the three best
  // as (distance, order), sorted by both.
  let d0 = 0, d1 = 0, d2 = 0, o0 = 0, o1 = 0, o2 = 0, px = 0, py = 0, pz = 0;
  const less = (d: number, o: number, e: number, q: number): boolean => d < e || (d === e && o < q);
  const consider = (o: number): void => {
    const v = anchors[o]! * 3;
    const dx = P[v]! - px, dy = P[v + 1]! - py, dz = P[v + 2]! - pz;
    const d = dx * dx + dy * dy + dz * dz;
    if (!less(d, o, d2, o2)) return;
    if (less(d, o, d1, o1)) {
      d2 = d1; o2 = o1;
      if (less(d, o, d0, o0)) { d1 = d0; o1 = o0; d0 = d; o0 = o; } else { d1 = d; o1 = o; }
    } else { d2 = d; o2 = o; }
  };
  const visit = (lo: number, hi: number, axis: number): void => {
    if (hi <= lo) return;
    const mid = (lo + hi) >> 1;
    // Nothing in this subtree is nearer than its box (an equally near one
    // can still win on its place in the list).
    const b = mid * 6;
    const ex = box[b]! - px > 0 ? box[b]! - px : px - box[b + 3]! > 0 ? px - box[b + 3]! : 0;
    const ey = box[b + 1]! - py > 0 ? box[b + 1]! - py : py - box[b + 4]! > 0 ? py - box[b + 4]! : 0;
    const ez = box[b + 2]! - pz > 0 ? box[b + 2]! - pz : pz - box[b + 5]! > 0 ? pz - box[b + 5]! : 0;
    if (ex * ex + ey * ey + ez * ez > d2) return;
    const o = order[mid]!;
    consider(o);
    const gap = (axis === 0 ? px : axis === 1 ? py : pz) - coord(o, axis);
    const next = axis === 2 ? 0 : axis + 1;
    if (gap < 0) { visit(lo, mid, next); visit(mid + 1, hi, next); } else { visit(mid + 1, hi, next); visit(lo, mid, next); }
  };
  return (p) => {
    // A point that is not a number is nearest to nothing, as the search over
    // every anchor found.
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) return [[Infinity, 0], [Infinity, 0], [Infinity, 0]];
    px = p[0]; py = p[1]; pz = p[2];
    d0 = d1 = d2 = Infinity; o0 = o1 = o2 = Infinity;
    visit(0, order.length, 0);
    const vertex = (o: number): number => (o === Infinity ? 0 : anchors[o]!);
    return [[d0, vertex(o0)], [d1, vertex(o1)], [d2, vertex(o2)]];
  };
}

/** An item from generated geometry: each vertex pinned to the three nearest head vertices. */
function pinned(head: ReturnType<typeof headOf>, name: string, kind: ProxyPack['kind'],
  positions: readonly number[], uvs: readonly number[], index: readonly number[], fade?: readonly number[],
  via?: { readonly of: Int32Array; readonly points: readonly V3[] }): ProxyPack {
  const { P, at, headVerts } = head;
  // Pinned to the three nearest scalp (and head) vertices - of the vertex
  // itself, or of the point `via` names for it (a strand's guide point:
  // thousands of strand vertices share a few hundred searches).
  const n = positions.length / 3;
  const refs = new Uint32Array(n * 3), weights = new Float32Array(n * 3), offsets = new Float32Array(n * 3);
  const nearest = nearestThree(P, headVerts);
  const shared = via ? via.points.map(nearest) : null;
  for (let i = 0; i < n; i++) {
    const p: V3 = [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
    const best = shared ? shared[via!.of[i]!]! : nearest(p);
    let total = 0;
    const w = best.map(([d]) => 1 / (Math.sqrt(d) + 0.05));
    for (const x of w) total += x;
    const fit: V3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      refs[i * 3 + k] = best[k]![1];
      weights[i * 3 + k] = w[k]! / total;
      const r = at(best[k]![1]);
      fit[0] += r[0] * w[k]! / total; fit[1] += r[1] * w[k]! / total; fit[2] += r[2] * w[k]! / total;
    }
    offsets[i * 3] = p[0] - fit[0]; offsets[i * 3 + 1] = p[1] - fit[1]; offsets[i * 3 + 2] = p[2] - fit[2];
  }
  // The scale axes of the stock long hair: measured across the head.
  const scaleRefs = [5399, 11998, 791, 881, 962, 5320];
  const axis = (i: number): number => Math.abs(P[scaleRefs[i * 2]! * 3 + i]! - P[scaleRefs[i * 2 + 1]! * 3 + i]!);
  return {
    name, kind, scaleRefs, scaleBase: [axis(0), axis(1), axis(2)],
    refs, weights, offsets, index: Uint32Array.from(index), deleteVerts: new Uint32Array(0),
    colour: 0xffffff, zDepth: 50, uvs: Float32Array.from(uvs),
    ...(fade ? { fade: Float32Array.from(fade) } : {}),
  };
}

/**
 * The same style as strands to draw as lines over its cards, close up: about
 * a dozen fine strands round each guide, spread over its card's width and
 * drawn in to it towards the tip (the clumping of Blender's Clump Hair
 * Curves and Mirage Mane's groom), each its own shade, darker at the root.
 * `fade` carries each vertex's shade. Its index is line segments.
 */
export function generateHairStrands(style: HairStyle, base: HairBase, seed = 1): ProxyPack {
  return generateHair(style, base, seed, true);
}

export function generateHair(style: HairStyle, base: HairBase, seed = 1, strands = false): ProxyPack {
  const head = headOf(base);
  const { at, headVerts, skull, local, outward } = head;

  // Scalp: head vertices above the hairline.
  const headSet = new Set(headVerts);
  // Not the ears: they stand out of the skull's ellipsoid.
  const scalp = headVerts.filter((v) => {
    const q = local(at(v));
    // The ear only: what stands out past the side of the head (the
    // outermost centimetre), from its top to its lobe - not the skin above it.
    const ear = Math.abs(at(v)[0]) > skull.r[0] * 1.0 && q[1] < 0.12 && q[1] > -0.85;
    return !ear && len(q) > 0.75 && len(q) < 1.25 && q[1] > hairlineY(Math.atan2(q[0], q[2]));
  });
  const rnd = random(seed * 7919 + style.name.length * 104729);
  // Roots: the scalp thinned to an even spread (dart throwing).
  const area = 2 * Math.PI * skull.r[0] * skull.r[2] * 1.15;
  const spacing = Math.sqrt(area / style.clumps) * 0.85;
  const order = scalp.map((v) => [v, rnd()] as const).sort((a, b) => a[1] - b[1]).map(([v]) => v);
  // Closer together along the hairline, where fine clumps make the edge.
  const edge = (p: V3): number => { const q = local(p); return q[1] - hairlineY(Math.atan2(q[0], q[2])); };
  const roots: V3[] = [];
  for (const v of order) {
    const p = at(v);
    const gap = edge(p) < 0.25 ? spacing * 0.6 : spacing;
    if (roots.every((r) => len(sub(r, p)) > gap)) roots.push(p);
  }

  const neckY = skull.c[1] - skull.r[1] * 1.55;
  // The shoulders and back the hair falls over: an ellipse in plan that
  // widens from the neck to the shoulders.
  const body = (y: number): { rx: number; rz: number; cz: number } => {
    const t = Math.max(0, Math.min(1, (neckY - y) / (skull.r[1] * 0.9)));
    return { rx: 0.45 + 1.35 * t, rz: 0.45 + 0.35 * t, cz: skull.c[2] - 0.15 - 0.1 * t };
  };
  const collide = (p: V3, lift: number): V3 => {
    const q = local(p);
    const s = len(q), inflate = 1 + lift / skull.r[1];
    let out = p;
    if (s < inflate) out = [skull.c[0] + q[0] / s * inflate * skull.r[0], skull.c[1] + q[1] / s * inflate * skull.r[1], skull.c[2] + q[2] / s * inflate * skull.r[2]];
    // The face: hair from the front of the head goes round it, to the
    // sides, never down over the eyes (a fringe stops short of them).
    const f = local(out);
    if (f[2] > 0.15 && f[1] < 0.45 && f[1] > -1.7) {
      // Eased in below the hairline, so the hair parts round the brow
      // instead of being cut square across it.
      const clear = 0.8 * Math.min(1, (0.45 - f[1]) / 0.35);
      if (Math.abs(f[0]) < clear) out = [Math.sign(f[0] || 1) * clear * skull.r[0] + skull.c[0], out[1], out[2]];
    }
    if (out[1] < neckY + 0.2) {
      const b = body(out[1]);
      const ex = out[0] / (b.rx + lift), ez = (out[2] - b.cz) / (b.rz + lift);
      const e = Math.hypot(ex, ez);
      if (e < 1) out = [out[0] / e, out[1], b.cz + (out[2] - b.cz) / e];
    }
    return out;
  };

  const partX = style.part * skull.r[0] * 0.55;
  // Which way a card faces: out of the skull over the head; below it, out of
  // the body's vertical axis, a curtain round it - facing out of the skull
  // there, the cards lay flat on the shoulders as planks.
  const facing = (p: V3): V3 => {
    const below = (skull.c[1] - p[1]) / skull.r[1];
    if (below <= 0.2) return outward(p);
    const radial = norm([p[0], 0, p[2] - skull.c[2]]);
    const k = Math.min(1, (below - 0.2) / 0.5);
    return norm(add(outward(p), sub(radial, outward(p)), k));
  };
  const regional = (q: V3): number => {
    const r = style.regions;
    if (!r) return 1;
    const crown = r.crown ?? 1, front = r.front ?? crown, temple = r.temple ?? crown;
    const occipital = r.occipital ?? crown, nape = r.nape ?? occipital;
    const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
    const frontW = clamp01((q[2] - 0.12) / 0.72), rearW = clamp01((-q[2] - 0.1) / 0.9);
    const sideW = clamp01((Math.abs(q[0]) - 0.56) / 0.36), napeW = rearW * clamp01((-q[1] - 0.05) / 0.7);
    return crown + (front - crown) * frontW + (occipital - crown) * rearW * (1 - napeW)
      + (temple - crown) * sideW * (1 - rearW * 0.35) + (nape - occipital) * napeW;
  };
  const guides: V3[][] = [];
  /** Which guides are the fringe's: drawn with narrower cards. */
  const fringes: boolean[] = [];
  /** How far inside the hairline each guide's root is (local units): near it, the card feathers in. */
  const inside: number[] = [];
  /** Guides at the front hairline: strands only, no cards. */
  const edgeFront: boolean[] = [];
  // A curl needs about eight points a turn, or it is drawn square.
  const segments = style.curl ? Math.ceil(style.length / (style.curl.pitch / 8))
    : style.length > 2.5 ? 16 : style.length > 1 ? 10 : 5;
  for (const root of roots) {
    const q = local(root);
    const n = outward(root);
    const lift = style.volume * (0.6 + 0.8 * rnd()) + (style.quiff && q[2] > 0.3 ? style.quiff * Math.min(1, (q[2] - 0.3) / 0.4) : 0);
    const fringe = style.fringe && q[2] > 0.25 && Math.abs(q[0]) < style.fringe.width && q[1] > 0.2;
    const length = (fringe ? style.fringe!.length : style.length * regional(q)) * (0.8 + 0.35 * rnd());
    // Combed away from the parting and back; a fringe brushed forwards.
    // Sideways from the parting only on the crown and the front; from the
    // back of the head the hair falls straight, or it parts down the nape.
    const sideways = Math.max(0, Math.min(1, (q[2] + 0.35) / 0.6)) * (0.4 + 0.8 * Math.max(0, q[1]));
    let comb: V3 = fringe ? [0, -0.15, 1]
      : style.back ? [0, q[1] > 0.3 ? 0.1 : -0.7, -1]
      : style.quiff && q[2] > 0.3 ? [0, 1, -0.4]
      : [Math.sign(root[0] - partX || 1) * sideways + (style.sweep ?? 0) * Math.max(0.3, sideways), -0.7, -0.55 * Math.max(0, q[1]) - 0.25 - 0.5 * Math.max(0, q[2])];
    comb = norm(sub(comb, [n[0] * dot(comb, n), n[1] * dot(comb, n), n[2] * dot(comb, n)]));
    // Rooted on the skin; the lift (volume) builds over the first steps, or
    // the root ends of the cards stood off the brow as a step.
    let p = add(root, n, 0.004);
    let dir = comb;
    const pts: V3[] = [p];
    const step = length / segments;
    let gathered = false;
    const gatherAt: V3 | null = style.gather
      ? (style.gather.twin && root[0] < 0 ? [-style.gather.at[0], style.gather.at[1], style.gather.at[2]] : [...style.gather.at] as V3)
      : null;
    for (let i = 0; i < segments; i++) {
      if (style.gather && !fringe) {
        const g = gatherAt!;
        const toward = sub(g, p);
        if (!gathered && len(toward) > step * 1.1) dir = norm(add(norm(toward), outward(p), 0.15));
        else {
          // At the tie the strand takes the tail's direction at once: one
          // rooted right at it still pointed where it was combed, and rose
          // over the head in a loop before falling.
          if (!gathered) dir = norm([0, -1, -0.15]);
          gathered = true;
          if (style.gather.bun || style.gather.braid) break;
          dir = norm(add(dir, [0, -1, -0.15], 0.5));
        }
      } else {
        dir = norm(add(dir, [0, -1, 0], style.gravity * (fringe ? 0.25 : 1)));
        // Below the skull, hair behind the ears closes in like a curtain.
        if (p[1] < skull.c[1] && p[2] < skull.c[2]) dir = norm(add(dir, [-p[0] / skull.r[0], 0, 0], 0.18));
      }
      const layerLift = lift * Math.min(1, (i + 1) / 3);
      p = collide(add(p, dir, step), layerLift);
      // Over the top half of the skull hair lies on it, at the style's
      // volume: grown along the tangent alone it left the curving head, and
      // short or slicked hair (little gravity) stood out in spikes.
      const lq = local(p);
      if (lq[1] > -0.1 && !(style.gather && gathered)) {
        const k = (1 + layerLift / skull.r[1]) / Math.max(1e-6, len(lq));
        if (k < 1) p = [skull.c[0] + lq[0] * k * skull.r[0], skull.c[1] + lq[1] * k * skull.r[1], skull.c[2] + lq[2] * k * skull.r[2]];
        const o = outward(p);
        dir = norm(sub(dir, [o[0] * dot(dir, o), o[1] * dot(dir, o), o[2] * dot(dir, o)]));
        // On the front of the skull hair goes back or to the side, never
        // forwards and down over the brow (only a fringe does): gravity along
        // the forehead pulled the hairline's strands down into dark teeth.
        if (!fringe && lq[2] > 0 && dir[2] > 0) dir = norm([dir[0], Math.max(dir[1], -0.2), -0.05]);
      }
      pts.push(p);
    }
    if (style.gather?.bun) {
      // Wound round the gathering point: a coil facing back.
      const g = gatherAt!, r = style.gather.bun;
      const a0 = rnd() * Math.PI * 2;
      for (let i = 1; i <= 8; i++) {
        const a = a0 + i * 0.7, rr = r * (0.55 + 0.45 * Math.sin(i * 0.4));
        pts.push([g[0] + Math.cos(a) * rr, g[1] + Math.sin(a) * rr * 0.8, g[2] - 0.15 - 0.05 * i]);
      }
    }
    if (style.gather?.tail && gathered) {
      const g = gatherAt!;
      const tail = style.gather.tail * (style.gather.braid ? 1 : 0.85 + 0.3 * rnd());
      if (style.gather.braid) {
        // The strands stop at the tie; the plait itself is built below.
        void tail;
      } else {
        // The tail: a bundle round its own axis.
        const off: V3 = [(rnd() - 0.5) * 0.35, 0, (rnd() - 0.5) * 0.25];
        let tp = add(g, off);
        for (let i = 1; i <= 10; i++) {
          tp = collide(add(tp, norm([off[0] * 0.3, -1, -0.12 - off[2] * 0.3]), tail / 10), 0.05);
          pts.push(tp);
        }
      }
    }
    if (style.curl) {
      // Corkscrews: the strand wound round its own line, growing in from the root.
      const phase = rnd() * Math.PI * 2;
      const radius = style.curl.radius * (0.7 + 0.6 * rnd());
      let s = 0;
      for (let i = 1; i < pts.length; i++) {
        s += len(sub(pts[i]!, pts[i - 1]!));
        const t = norm(sub(pts[i]!, pts[i - 1]!));
        const out = outward(pts[i]!);
        const side = norm(cross(t, out)), up = norm(cross(side, t));
        const a = 2 * Math.PI * s / style.curl.pitch + phase, k = Math.min(1, s / 0.4) * radius;
        pts[i] = add(add(pts[i]!, side, Math.cos(a) * k), up, Math.sin(a) * k);
      }
    }
    if (style.wave) {
      const phase = rnd() * Math.PI * 2;
      let s = 0;
      for (let i = 1; i < pts.length; i++) {
        s += len(sub(pts[i]!, pts[i - 1]!));
        const t = norm(sub(pts[i]!, pts[i - 1]!));
        const side = norm(cross(t, outward(pts[i]!)));
        const amp = style.wave.amplitude * Math.min(1, s / 0.6) * Math.sin(2 * Math.PI * s / style.wave.wavelength + phase);
        pts[i] = add(pts[i]!, side, amp);
      }
    }
    guides.push(pts);
    fringes.push(!!fringe);
    inside.push(q[1] - hairlineY(Math.atan2(q[0], q[2])));
    edgeFront.push(!fringe && q[1] - hairlineY(Math.atan2(q[0], q[2])) < 0.2 && Math.abs(Math.atan2(q[0], q[2])) < 1.2);
  }

  if (strands) {
    // Ribbons a millimetre and a bit wide, lying on the hair's surface, a
    // couple of dozen round each guide: each spread over the card's width
    // at the root and drawn in to the guide towards the tip (a clump), its
    // own length, thinning out at the tip.
    const positions: number[] = [], uvs: number[] = [], index: number[] = [], shades: number[] = [];
    const points: V3[] = [];
    const of: number[] = [];
    for (const [g, pts] of guides.entries()) {
      const first = points.length;
      points.push(...pts);
      if (pts.length < 2) continue;
      const count = fringes[g] ? 14 : inside[g]! < 0.25 ? 12 : 26;
      const width = style.cardWidth * (fringes[g] ? 0.55 : inside[g]! < 0.25 ? 0.5 : 1.1);
      for (let c = 0; c < count; c++) {
        const across = (rnd() - 0.5) * width, lift = 0.005 + rnd() * 0.03;
        const end = Math.min(pts.length - 1, Math.max(1, Math.round((pts.length - 1) * (0.8 + 0.2 * rnd()))));
        const half = 0.0055 + rnd() * 0.003;
        const start = positions.length / 3;
        for (let i = 0; i <= end; i++) {
          const t = i / (pts.length - 1);
          const p = pts[i]!;
          const along = norm(sub(pts[Math.min(pts.length - 1, i + 1)]!, pts[Math.max(0, i - 1)]!));
          const out = facing(p);
          const side = norm(cross(along, out));
          const centre = add(add(p, side, across * (1 - 0.75 * Math.pow(t, 1.4))), out, lift * (1 - 0.6 * t));
          const w = half * (1 - 0.5 * i / end);
          positions.push(...add(centre, side, -w), ...add(centre, side, w));
          uvs.push(0.0, t * 0.98 + 0.01, 0.25, t * 0.98 + 0.01);
          const f = i / end > 0.85 ? 1 - (i / end - 0.85) / 0.15 * 0.8 : 1;
          shades.push(f, f);
          of.push(first + i, first + i);
        }
        for (let i = 0; i < end; i++) {
          const k = start + i * 2;
          index.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
        }
      }
    }
    return pinned(head, `strands:${style.name}`, 'hair', positions, uvs, index, shades, { of: Int32Array.from(of), points });
  }

  // Cards: a strip along each guide facing out of the head; a second,
  // turned and lifted, for body. UVs: one of four strand strips across, root
  // (v = 0) to tip.
  const positions: number[] = [], uvs: number[] = [], index: number[] = [], fades: number[] = [];
  for (const [g, pts] of guides.entries()) {
    // The hairline's own clumps are drawn as strands and the painted cap
    // only: as cards their root ends stood on the brow as dark teeth.
    if (edgeFront[g]) continue;
    // A strand rooted at a braid's tie stops there at once: one point is no
    // card (t = 0 / 0 made its corners NaN, and the whole mesh's bounds).
    if (pts.length < 2) continue;
    for (let layer = 0; layer < style.layers; layer++) {
      const strip = Math.floor(rnd() * 4);
      const u0 = strip / 4 + 0.01, u1 = (strip + 1) / 4 - 0.01;
      const first = positions.length / 3;
      const fine = fringes[g] ? 0.55 : inside[g]! < 0.25 ? 0.5 : 1;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i]!;
        const t = i / (pts.length - 1);
        const along = norm(sub(pts[Math.min(pts.length - 1, i + 1)]!, pts[Math.max(0, i - 1)]!));
        const out = facing(p);
        let side = norm(cross(along, out));
        let centre = add(p, out, 0.015);
        if (layer === 1) {
          // Flat on the head at the root, turning out along the length:
          // turned from the root, the cards stood up on the crown like fins.
          const open = Math.min(1, t * 2.5);
          side = norm(add(side, out, 0.5 * open));
          centre = add(p, out, 0.015 + 0.035 * open);
        }
        const w = fine * style.cardWidth * (layer === 1 ? 0.8 : 1) * (1 - 0.65 * t * t) / 2;
        const a = add(centre, side, -w), b = add(centre, side, w);
        positions.push(...a, ...b);
        uvs.push(u0, t * 0.98 + 0.01, u1, t * 0.98 + 0.01);
        // At the hairline the strands thin in from the root: a feathered
        // edge, not the straight root ends of the cards (a visor).
        // Every card's root feathered (the cap shows through), more so at
        // the hairline: hard root ends read as shingles on the crown.
        const rootFade = Math.min(0.4, Math.max(0.3, Math.min(1, inside[g]! / 0.22)));
        const f = Math.min(1, rootFade + t * 6);
        fades.push(f, f);
      }
      for (let i = 0; i < pts.length - 1; i++) {
        const k = first + i * 2;
        index.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
  }

  // The cap: the scalp itself under the cards, lifted a little and painted
  // with the solid band at the top of the strand texture - as hair cards
  // sit on a painted scalp in games, or the skin shows through the parting.
  const capOf = new Map<string, number>();
  const scalpSet = new Set(scalp);
  const capStart = positions.length / 3;
  // Each cap point's own fade from where it is (not interpolated across the
  // mesh's squares), and the cap's triangles split twice where the fade
  // changes, so its edge follows the hairline's curve, not the mesh's steps.
  const capFade = (p: V3): number => {
    const q = local(p);
    if (Math.abs(p[0]) > skull.r[0] * 1.0 && q[1] < 0.12 && q[1] > -0.85) return 0;
    // A soft, wide edge only on the brow; over the ears and at the nape hair
    // is full right to its edge (a wide fade there read as shaved sides).
    const theta = Math.atan2(q[0], q[2]);
    const width = 0.12 + 0.25 * Math.max(0, 1 - Math.abs(theta) / 0.9);
    const t = Math.max(0, Math.min(1, (q[1] - hairlineY(theta)) / width));
    return t * t * (3 - 2 * t) * 0.95;
  };
  const capKey = (p: V3): string => `${Math.round(p[0] * 2000)},${Math.round(p[1] * 2000)},${Math.round(p[2] * 2000)}`;
  const capPoint = (p: V3): number => {
    const key = capKey(p);
    let k = capOf.get(key);
    if (k === undefined) {
      k = positions.length / 3;
      capOf.set(key, k);
      positions.push(...add(p, outward(p), 0.012));
      const q = local(p);
      // Strands of the atlas running down from the crown to the hairline.
      const around = Math.atan2(q[0], q[2]) / Math.PI * 0.5 + 0.5;
      uvs.push(0.02 + 0.21 * ((around * 6) % 1), 0.05 + 0.4 * Math.max(0, Math.min(1, 0.95 - q[1])));
      fades.push(capFade(p));
    }
    return k;
  };
  const mid = (x: V3, y: V3): V3 => [(x[0] + y[0]) / 2, (x[1] + y[1]) / 2, (x[2] + y[2]) / 2];
  const capTriangle = (x: V3, y: V3, z: V3, level: number): void => {
    const fx = capFade(x), fy = capFade(y), fz = capFade(z);
    if (level < 2 && Math.max(fx, fy, fz) - Math.min(fx, fy, fz) > 0.05) {
      const xy = mid(x, y), yz = mid(y, z), zx = mid(z, x);
      capTriangle(x, xy, zx, level + 1); capTriangle(xy, y, yz, level + 1);
      capTriangle(zx, yz, z, level + 1); capTriangle(xy, yz, zx, level + 1);
      return;
    }
    if (fx + fy + fz === 0) return;
    index.push(capPoint(x), capPoint(y), capPoint(z));
  };
  for (let f = 0; f < base.faces.length; f += 4) {
    const a = base.faces[f]!, b = base.faces[f + 1]!, c = base.faces[f + 2]!, d = base.faces[f + 3]!;
    // The cap reaches a ring past the hairline so its edge hides under the cards.
    const near = [a, b, c, d].filter((v) => scalpSet.has(v)).length;
    if (near < 1 || ![a, b, c, d].every((v) => headSet.has(v))) continue;
    capTriangle(at(a), at(b), at(c), 0);
    if (d !== c) capTriangle(at(a), at(c), at(d), 0);
  }
  void capStart;

  // A plait: a chain of lobes from the tie down, each a short tube tilted
  // alternately left and right - the chevrons of a three-strand braid seen
  // from behind - narrowing to the end, strands running along each lobe.
  if (style.gather?.braid) {
    const ties: V3[] = [[...style.gather.at] as V3];
    if (style.gather.twin) ties.push([-style.gather.at[0], style.gather.at[1], style.gather.at[2]]);
    for (const tie of ties) {
      const lobes = Math.max(4, Math.round(style.gather.tail / 0.22));
      let axis: V3 = [...tie];
      const down: V3 = norm([tie[0] * 0.08, -1, -0.12]);
      for (let k = 0; k < lobes; k++) {
        const t = k / lobes;
        const r = 0.2 * (1 - 0.55 * t);
        axis = collide(add(axis, down, 0.22 * (1 - 0.3 * t)), r * 0.8);
        const back = norm([axis[0] * 0.3, 0, -1]);
        const side = norm(cross(down, back));
        const lean = k % 2 ? 1 : -1;
        const d = norm(add(down, side, 0.75 * lean));
        const e1 = norm(cross(d, back)), e2 = norm(cross(e1, d));
        const centre = add(axis, side, -0.35 * r * lean);
        const strip = Math.floor(rnd() * 4);
        const first = positions.length / 3;
        const A = 6, L = 5, length = r * 2.6;
        for (let i = 0; i <= L; i++) {
          const v = i / L;
          const rr = r * Math.pow(Math.sin(Math.PI * v), 0.6) + 0.01;
          for (let j = 0; j <= A; j++) {
            const th = (j / A) * Math.PI * 2;
            const p = add(add(add(centre, d, (v - 0.5) * length), e1, Math.cos(th) * rr), e2, Math.sin(th) * rr * 0.65);
            positions.push(...p);
            uvs.push(strip / 4 + 0.01 + (j / A) * 0.23, 0.05 + v * 0.6);
            fades.push(1);
          }
        }
        for (let i = 0; i < L; i++) for (let j = 0; j < A; j++) {
          const k0 = first + i * (A + 1) + j, k1 = k0 + A + 1;
          index.push(k0, k1, k0 + 1, k0 + 1, k1, k1 + 1);
        }
      }
    }
  }

  return pinned(head, `hair:${style.name}`, 'hair', positions, uvs, index, fades);
}

/**
 * A headband: a band over the crown from ear to ear, a little forward of the
 * top, standing on the hair (so above any style's volume), slightly rounded
 * in section. Dyed as an accessory, not as the hair.
 */
export function generateHeadband(base: HairBase): ProxyPack {
  const head = headOf(base);
  const { skull } = head;
  const positions: number[] = [], uvs: number[] = [], index: number[] = [];
  const steps = 28, across = 4, width = 0.2;
  const lift = 1 + 0.26 / skull.r[1];
  const tilt = 0.32;
  for (let i = 0; i <= steps; i++) {
    const phi = (i / steps - 0.5) * Math.PI * 1.08;
    for (let j = 0; j <= across; j++) {
      const w = (j / across - 0.5) * width;
      // A great circle over the head, leaned forwards by `tilt`.
      const dir: V3 = norm([Math.sin(phi), Math.cos(phi) * Math.cos(tilt), Math.cos(phi) * Math.sin(tilt) + w / skull.r[2]]);
      const bulge = 1 + 0.025 * Math.cos((j / across - 0.5) * Math.PI);
      positions.push(skull.c[0] + dir[0] * skull.r[0] * lift * bulge, skull.c[1] + dir[1] * skull.r[1] * lift * bulge, skull.c[2] + dir[2] * skull.r[2] * lift * bulge);
      uvs.push(j / across, i / steps);
    }
  }
  for (let i = 0; i < steps; i++) for (let j = 0; j < across; j++) {
    const k = i * (across + 1) + j;
    index.push(k, k + across + 1, k + 1, k + 1, k + across + 1, k + across + 2);
  }
  return pinned(head, 'acc:headband', 'hat', positions, uvs, index);
}

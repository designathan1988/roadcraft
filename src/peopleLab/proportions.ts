import type { PeopleAssets } from '@people/body/assets';
import type { Morpher } from '@people/body/morph';
import type { PersonSpec } from '@people/spec';

/** THE FACE'S PROPORTIONS, measured and set to the classical canons (Da Vinci and Dürer's neoclassical canons; the drawing manuals' rules):
 *  eyes halfway down the head, the face in equal thirds (brow, nose base, chin), one eye's width between the eyes, the nose as wide as that gap,
 *  the mouth half as wide again as the nose and a third of the way from the nose to the chin. Each feature is found by the very target that
 *  shapes it (the vertices the slider moves), never by guessed heights; each slider is solved by the secant method on the measure it controls. */

/** The base mesh's vertices a slider moves, weighted 0..1 by how far (its target at +1 against the face at rest). */
export type Influence = Float32Array;

export interface FaceMeasure {
  /** Down from the skull's top to the eyes, over the skull's top to the chin: 0.5 in the canon. */
  readonly eyeLine: number;
  /** Nose base to chin over brow to nose base: 1 in the canon. */
  readonly thirds: number;
  /** The gap between the eyes over one eye's width: 1. */
  readonly eyeGap: number;
  /** The nose's width over the gap between the eyes: 1. */
  readonly nose: number;
  /** The mouth's width over the nose's: 1.5. */
  readonly mouth: number;
  /** Nose base to mouth over nose base to chin: 1/3. */
  readonly mouthLine: number;
  /** One eye's width over the head's width at the eyes: the head is five eyes wide, 0.2. */
  readonly eyeSize: number;
  /** The jaw's width (the head's width a little below the mouth) over the cheekbones' (at the nose's base): bigonial over bizygomatic. */
  readonly jaw: number;
}

export const CANON: FaceMeasure = { eyeLine: 0.5, thirds: 1, eyeGap: 1, nose: 1, mouth: 1.5, mouthLine: 1 / 3, jaw: 0.8, eyeSize: 0.2 };

/** A woman's face against the canon (sexual dimorphism: a vertically shorter lower face, a smaller nose and mouth - the Buryat and Caucasian 3D studies, the
 *  geometric-morphometrics work on the jaw and chin): `fit` blends towards it by how feminine the body is. */
export const FEMININE: FaceMeasure = { eyeLine: 0.5, thirds: 0.9, eyeGap: 1, nose: 0.92, mouth: 1.45, mouthLine: 1 / 3, jaw: 0.73, eyeSize: 0.2 };

/** A woman's features the canon does not measure: a narrow, gracile jaw and chin with a soft point, cheekbones ahead of the brow ridge,
 *  a rounder face, a fuller lower lip with its corners lifted, a slimmer neck. Each is applied at full strength on the most feminine body. */
const FEMININE_FEATURES: Readonly<Record<string, number>> = {
  'chin-width-decr-incr': -0.3, 'chin-triangle': 0.2,
  'cheek-bones-decr-incr': 0.3, 'head-invertedtriangular': 0.35,
  // Brows set high and arched over an upright forehead: a low, flat brow over a sloping forehead reads as a caveman's.
  'eyebrows-trans-down-up': 0.35, 'eyebrows-angle-down-up': 0.25, 'forehead-trans-backward-forward': 0.15,
  'mouth-lowerlip-volume-decr-incr': 0.35, 'mouth-angles-down-up': 0.2, 'measure-neck-circ-decr-incr': -0.3,
};

/** How feminine a body is, 0 (the gender slider at the middle or above) to 1 (all the way female). */
export const femininity = (gender: number): number => Math.max(0, Math.min(1, (0.5 - gender) * 2.5));

/** The canon for this body: between the canon and the feminine one by its femininity. */
export function canonFor(gender: number): FaceMeasure {
  const f = femininity(gender);
  const mix = (k: keyof FaceMeasure): number => CANON[k] + (FEMININE[k] - CANON[k]) * f;
  return { eyeLine: mix('eyeLine'), thirds: mix('thirds'), eyeGap: mix('eyeGap'), nose: mix('nose'), mouth: mix('mouth'), mouthLine: mix('mouthLine'), jaw: mix('jaw'), eyeSize: mix('eyeSize') };
}

/** The feminine features, by the body's femininity, over the face's own. */
export function withFeminine(features: Readonly<Record<string, number>>, gender: number): Record<string, number> {
  const f = femininity(gender);
  const out: Record<string, number> = { ...features };
  for (const [k, v] of Object.entries(FEMININE_FEATURES)) out[k] = Math.max(-1, Math.min(1, v * f));
  return out;
}

/** The sliders that set each measure, the first tried first; the next takes over where it reaches its end (each swept from -1 to 1 on the lab's face:
 *  the eye line 0.54..0.50 by the eyes' height, 0.51..0.59 by the forehead's; the thirds 0.88..0.68 by the nose's length, 0.65..0.96 by the chin's). */
const SOLVE: readonly (readonly [keyof FaceMeasure, readonly string[]])[] = [
  ['eyeSize', ['eye-scale-decr-incr']],
  ['jaw', ['chin-bones-decr-incr', 'head-fat-decr-incr']],
  ['eyeLine', ['eye-trans-down-up', 'forehead-scale-vert-decr-incr']],
  ['thirds', ['nose-scale-vert-decr-incr', 'chin-height-decr-incr']],
  ['eyeGap', ['eye-trans-in-out']],
  ['nose', ['nose-scale-horiz-decr-incr']],
  ['mouth', ['mouth-scale-horiz-decr-incr']],
  ['mouthLine', ['mouth-trans-down-up']],
];

/** The sliders whose targets mark the landmarks: each landmark is the vertex its slider moves most (on the left side, x > 0, where paired). */
const MARKERS = {
  outerCorner: 'eye-corner1-down-up', innerCorner: 'eye-corner2-down-up', alar: 'nose-nostrils-width-decr-incr', noseBase: 'nose-base-down-up',
  mouthCorner: 'mouth-angles-down-up', mouthMiddle: 'mouth-upperlip-middle-down-up', brows: 'eyebrows-trans-down-up',
} as const;

export class FaceProportions {
  private readonly influence = new Map<string, Influence>();
  private readonly head: Uint32Array;
  private readonly eyes: Uint32Array;

  constructor(assets: PeopleAssets, private readonly morpher: Morpher,
    private readonly shapeOf: (spec: PersonSpec) => Float32Array) {
    const m = assets.mesh;
    const headBone = m.boneNames.indexOf('head');
    const head: number[] = [];
    for (let v = 0; v < m.vertexCount; v++) {
      for (let k = 0; k < 4; k++) if (m.joints[v * 4 + k] === headBone && m.weights[v * 4 + k]! > 40000) { head.push(v); break; }
    }
    this.head = Uint32Array.from(head);
    const eyeGroups = new Set([m.faceGroups.indexOf('helper-l-eye'), m.faceGroups.indexOf('helper-r-eye')]);
    const eyes = new Set<number>();
    for (let f = 0; f < m.faceGroup.length; f++) if (eyeGroups.has(m.faceGroup[f]!)) for (let k = 0; k < 4; k++) eyes.add(m.faces[f * 4 + k]!);
    this.eyes = Uint32Array.from(eyes);
  }

  /** How much each base vertex a slider moves, 0..1: its target at +1 against the face at rest. */
  influenceOf(slider: string, spec: PersonSpec): Influence {
    let out = this.influence.get(slider);
    if (out) return out;
    const rest = this.morpher.shape(spec.body, {});
    const moved = this.morpher.shape(spec.body, { [slider]: 1 });
    out = new Float32Array(this.morpher.vertexCount);
    let most = 0;
    for (let v = 0; v < out.length; v++) {
      const d = Math.hypot(moved[v * 3]! - rest[v * 3]!, moved[v * 3 + 1]! - rest[v * 3 + 1]!, moved[v * 3 + 2]! - rest[v * 3 + 2]!);
      out[v] = d;
      most = Math.max(most, d);
    }
    if (most > 0) for (let v = 0; v < out.length; v++) out[v] = out[v]! / most;
    this.influence.set(slider, out);
    return out;
  }

  /** The landmark a slider marks: the vertex it moves most, on the left (x > 0) or across the middle. */
  private landmark(slider: string, spec: PersonSpec, side: 'left' | 'any'): number {
    const inf = this.influenceOf(slider, spec);
    const base = this.morpher.base;
    let best = -1, most = -1;
    for (let v = 0; v < inf.length; v++) {
      if (side === 'left' && base[v * 3]! <= 0.02) continue;
      if (inf[v]! > most) { most = inf[v]!; best = v; }
    }
    return best;
  }

  measure(spec: PersonSpec): FaceMeasure {
    const p = this.shapeOf(spec);
    const x = (v: number): number => p[v * 3]!, y = (v: number): number => p[v * 3 + 1]!;
    let top = -Infinity;
    for (const v of this.head) top = Math.max(top, y(v));
    let eyeY = 0;
    for (const v of this.eyes) eyeY += y(v);
    eyeY /= Math.max(1, this.eyes.length);
    const L = (k: keyof typeof MARKERS, side: 'left' | 'any' = 'left'): number => this.landmark(MARKERS[k], spec, side);
    // The left eye's corners: its width; twice the inner corner's distance from the middle: the gap between the eyes.
    const eyeWidth = Math.abs(x(L('outerCorner')) - x(L('innerCorner')));
    const eyeGap = 2 * Math.abs(x(L('innerCorner')));
    const noseWidth = 2 * Math.abs(x(L('alar')));
    const mouthWidth = 2 * Math.abs(x(L('mouthCorner')));
    const noseBase = y(L('noseBase', 'any'));
    const mouthY = (y(L('mouthCorner')) + y(L('mouthMiddle', 'any'))) / 2;
    const brow = y(L('brows'));
    // The chin: the head's lowest point on the middle line, in front of the eyes' plane (the chin-height target moves the chin's middle, not its tip).
    const z = (v: number): number => p[v * 3 + 2]!;
    const front = z(L('innerCorner')) - 1;
    let chin = Infinity;
    for (const v of this.head) if (Math.abs(x(v)) < 0.12 && z(v) > front) chin = Math.min(chin, y(v));
    // The head's width at a height: its widest pair of front vertices within 3 mm of it.
    const widthAt = (h: number): number => {
      let lo = Infinity, hi = -Infinity;
      for (const v of this.head) if (Math.abs(y(v) - h) < 0.03 && z(v) > front) { lo = Math.min(lo, x(v)); hi = Math.max(hi, x(v)); }
      return hi - lo;
    };
    return {
      jaw: widthAt(mouthY - (mouthY - chin) * 0.4) / widthAt(noseBase),
      eyeSize: eyeWidth / widthAt(eyeY),
      eyeLine: (top - eyeY) / (top - chin),
      thirds: (noseBase - chin) / (brow - noseBase),
      eyeGap: eyeGap / eyeWidth,
      nose: noseWidth / eyeGap,
      mouth: mouthWidth / noseWidth,
      mouthLine: (noseBase - mouthY) / (noseBase - chin),
    };
  }

  /** The person's face set to the canon (`target`, the canon by default): each slider solved by the secant method, in passes until all agree. */
  fit(spec: PersonSpec, target: FaceMeasure = canonFor(spec.body.gender)): PersonSpec {
    // The sex's features first: they move the chin and mouth the canon then measures.
    let features: Record<string, number> = withFeminine(spec.features, spec.body.gender);
    // A fitting slider moves at most this far: pushed to its end, a slider deforms the face more than any proportion it buys (a nose or mouth at -1 is a pout, a 'testicle' face).
    const REACH = 0.45;
    // The eye's size may go all the way: it is the one slider the five-eyes rule leans on, and it keeps the eye's shape.
    const reach = (slider: string): number => (slider === 'eye-scale-decr-incr' ? 1 : REACH);
    const at = (slider: string, v: number): Record<string, number> => ({ ...features, [slider]: Math.max(-reach(slider), Math.min(reach(slider), v)) });
    // Passes until every measure is within 1% of the canon (the sliders touch each other: a longer chin lowers the eye line's share).
    for (let pass = 0; pass < 8; pass++) {
      const now = this.measure({ ...spec, features });
      if (SOLVE.every(([key]) => Math.abs(now[key] - target[key]) < 0.01 * target[key])) break;
      for (const [key, sliders] of SOLVE) {
        for (const slider of sliders) {
          const err = (v: number): number => this.measure({ ...spec, features: at(slider, v) })[key] - target[key];
          let a = features[slider] ?? 0, b = a + 0.25;
          let fa = err(a), fb = err(b);
          for (let i = 0; i < 6 && Math.abs(fb) > 1e-3 && Math.abs(fb - fa) > 1e-6; i++) {
            const c = Math.max(-reach(slider), Math.min(reach(slider), b - fb * (b - a) / (fb - fa)));
            a = b; fa = fb; b = c; fb = err(c);
          }
          features = at(slider, b);
          if (Math.abs(fb) < 0.01 * target[key]) break;
        }
      }
    }
    return { ...spec, features };
  }
}

/** The body's proportions, measured on the shaped mesh as drawn (the lab's style applied), against the anthropometric and figure-drawing canons:
 *  ~7.5 heads tall; a woman's shoulders ~1.15 times her hips, a man's ~1.35; the neck ~0.6 of the head's width in a woman, ~0.75 in a man
 *  (neck circumference over pi against head breadth: 293.5/154 mm in women, 350/158 in men). */
export interface BodyMeasure { readonly heads: number; readonly shoulders: number; readonly neck: number }

/** Heads tall as a stylized game figure is drawn (The Sims' adults ~6-6.5; a real adult's 7.5 left the head small and plain, 2026-10-21). */
/** The neck slimmer than the anthropometric mean (0.6, 0.75): a stylized figure's neck at the mean read thick, 'a horse's' (the player, 2026-10-21). */
export const BODY_CANON = { female: { heads: 6.3, shoulders: 1.15, neck: 0.48 }, male: { heads: 6.5, shoulders: 1.35, neck: 0.66 } } as const;

export function measureBody(assets: PeopleAssets, p: Float32Array): BodyMeasure {
  const m = assets.mesh;
  const y = (v: number): number => p[v * 3 + 1]!, x = (v: number): number => p[v * 3]!;
  const centre = (group: string): number => {
    let s = 0, c = 0;
    for (const [a, b] of m.vertexGroups[group] ?? []) for (let v = a; v <= b; v++) { s += y(v); c++; }
    return c ? s / c : 0;
  };
  const bones = m.boneNames;
  const main = (v: number): string => {
    let best = 0, bone = 0;
    for (let k = 0; k < 4; k++) if (m.weights[v * 4 + k]! > best) { best = m.weights[v * 4 + k]!; bone = m.joints[v * 4 + k]!; }
    return bones[bone] ?? '';
  };
  // The skin only (no helpers, eyes or teeth): the body's own vertex range.
  const skin: number[] = [];
  for (const [a, b] of assets.bodyRange) for (let v = a; v <= b; v++) skin.push(v);
  let top = -Infinity, bottom = Infinity;
  for (const v of skin) { top = Math.max(top, y(v)); bottom = Math.min(bottom, y(v)); }
  const width = (h: number, band: number, ok: (bone: string) => boolean): number => {
    let lo = Infinity, hi = -Infinity;
    for (const v of skin) if (Math.abs(y(v) - h) < band && ok(main(v))) { lo = Math.min(lo, x(v)); hi = Math.max(hi, x(v)); }
    return hi - lo;
  };
  // The chin: the head's lowest skin point near the middle line.
  let chin = Infinity;
  for (const v of skin) if (main(v) === 'head' && Math.abs(x(v)) < 0.15) chin = Math.min(chin, y(v));
  const head = top - chin;
  const shoulderY = (centre('joint-l-shoulder') + centre('joint-r-shoulder')) / 2;
  const hipY = (centre('joint-l-upper-leg') + centre('joint-r-upper-leg')) / 2;
  const notHand = (b: string): boolean => !/hand|thumb|index|middle|ring|pinky|lowerarm/.test(b);
  const neckY = centre('joint-neck');
  return {
    heads: (top - bottom) / head,
    // Across the deltoids, and the hips' widest at the hip joints (the hands hanging there left out).
    shoulders: width(shoulderY - 0.35, 0.25, notHand) / width(hipY - 0.4, 0.4, notHand),
    neck: width(neckY + 0.25, 0.08, (b) => b.startsWith('neck')) / width(chin + head * 0.62, 0.08, (b) => b === 'head'),
  };
}

/** The secant method on one value: `f(x) = 0` within `lo..hi`, from `x0`. */
export function solve(f: (x: number) => number, x0: number, lo: number, hi: number): number {
  let a = x0, b = Math.min(hi, x0 + (hi - lo) * 0.1);
  if (b === a) b = Math.max(lo, x0 - (hi - lo) * 0.1);
  let fa = f(a), fb = f(b);
  for (let i = 0; i < 8 && Math.abs(fb) > 1e-3 && Math.abs(fb - fa) > 1e-7; i++) {
    const c = Math.max(lo, Math.min(hi, b - fb * (b - a) / (fb - fa)));
    a = b; fa = fb; b = c; fb = f(c);
  }
  return Math.abs(fb) < Math.abs(fa) ? b : a;
}

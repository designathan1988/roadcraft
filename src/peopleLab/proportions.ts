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
}

export const CANON: FaceMeasure = { eyeLine: 0.5, thirds: 1, eyeGap: 1, nose: 1, mouth: 1.5, mouthLine: 1 / 3 };

/** The sliders that set each measure, the first tried first; the next takes over where it reaches its end (each swept from -1 to 1 on the lab's face:
 *  the eye line 0.54..0.50 by the eyes' height, 0.51..0.59 by the forehead's; the thirds 0.88..0.68 by the nose's length, 0.65..0.96 by the chin's). */
const SOLVE: readonly (readonly [keyof FaceMeasure, readonly string[]])[] = [
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
    return {
      eyeLine: (top - eyeY) / (top - chin),
      thirds: (noseBase - chin) / (brow - noseBase),
      eyeGap: eyeGap / eyeWidth,
      nose: noseWidth / eyeGap,
      mouth: mouthWidth / noseWidth,
      mouthLine: (noseBase - mouthY) / (noseBase - chin),
    };
  }

  /** The person's face set to the canon (`target`, the canon by default): each slider solved by the secant method, in passes until all agree. */
  fit(spec: PersonSpec, target: FaceMeasure = CANON): PersonSpec {
    let features: Record<string, number> = { ...spec.features };
    const at = (slider: string, v: number): Record<string, number> => ({ ...features, [slider]: Math.max(-1, Math.min(1, v)) });
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
            const c = Math.max(-1, Math.min(1, b - fb * (b - a) / (fb - fa)));
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

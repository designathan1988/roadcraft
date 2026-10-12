import type { PersonMeshData } from './personMesh';

/**
 * PEOPLE IN AN ANIMATED FILM'S STYLE: a MakeHuman body reproportioned the way
 * Pixar's people are drawn, as parameters.
 *
 * Disney Research measured what makes an animated character read younger and
 * more appealing (Carter et al., "Designing Animated Characters for Children
 * of Different Ages"): a bigger head for the height, bigger and rounder eyes,
 * set lower; studios' style guides add shorter legs, larger hands and feet,
 * round forms. Each of those is a parameter here, applied to the morphed body
 * before it is rigged (`riggedCitizens.ts`), so everything built on the body
 * follows it: the skeleton is fitted to the moved joints, the clothes and the
 * eyes are fitted to the moved skin, the hair grows on the moved scalp, and
 * every animation plays on it as on any body.
 *
 * Positions are MakeHuman's: decimetres, +Y up. A vertex belongs to a part by
 * its skin weights (the game-engine rig's bones); the joint helper vertices
 * (no weights) by their group's name.
 */

export interface CartoonStyle {
  /** Head size, 1 as the body has it. */
  readonly head: number;
  /** The eyes and their lids, 1 as they are. */
  readonly eyes: number;
  /** Leg length, thigh and shin, 1 as they are. */
  readonly legs: number;
  readonly hands: number;
  readonly feet: number;
}

/** No change. */
export const REALISTIC: CartoonStyle = { head: 1, eyes: 1, legs: 1, hands: 1, feet: 1 };

/** An adult as Pixar draws one: head near a fifth of the height, eyes large, legs a little short. */
export const PIXAR: CartoonStyle = { head: 1.42, eyes: 1.45, legs: 0.84, hands: 1.15, feet: 1.12 };

/** A person's own proportions within the style, from their id: no two the same. */
export function styleFor(base: CartoonStyle, id: number): CartoonStyle {
  if (base === REALISTIC) return base;
  const h = (n: number): number => {
    let x = Math.imul(id ^ (n * 0x9e3779b1), 0x85ebca6b);
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
    return (((x ^ (x >>> 16)) >>> 0) / 4294967296) * 2 - 1;
  };
  return {
    head: base.head * (1 + 0.06 * h(1)),
    eyes: base.eyes * (1 + 0.08 * h(2)),
    legs: base.legs * (1 + 0.05 * h(3)),
    hands: base.hands * (1 + 0.05 * h(4)),
    feet: base.feet * (1 + 0.04 * h(5)),
  };
}

const LEG_BONES = ['thigh', 'calf', 'foot', 'ball'];
const HEAD_HELPERS = /^joint-(head|jaw|mouth|[lr]-eye|[lr]-upperlid|[lr]-lowerlid)/;

/** The body reproportioned; a new array, the input untouched. */
export function cartoonBody(input: Float32Array, data: PersonMeshData, style: CartoonStyle): Float32Array {
  const p = new Float32Array(input);
  if (style === REALISTIC) return p;
  const n = data.vertexCount;
  const bones = data.boneNames;
  const helperOf = new Map<number, string>();
  for (const [name, ranges] of Object.entries(data.vertexGroups)) {
    if (!name.startsWith('joint-')) continue;
    for (const [a, b] of ranges) for (let v = a; v <= b; v++) helperOf.set(v, name);
  }
  /** How much of a vertex the bones matching `test` carry, 0..1. */
  const weightOf = (v: number, test: (bone: string) => boolean): number => {
    let w = 0;
    for (let k = 0; k < 4; k++) {
      const j = data.joints[v * 4 + k]!, x = data.weights[v * 4 + k]! / 65535;
      if (x > 0 && test(bones[j] ?? '')) w += x;
    }
    return Math.min(1, w);
  };
  const centre = (group: string): [number, number, number] => {
    let x = 0, y = 0, z = 0, c = 0;
    for (const [a, b] of data.vertexGroups[group] ?? []) for (let v = a; v <= b; v++) { x += p[v * 3]!; y += p[v * 3 + 1]!; z += p[v * 3 + 2]!; c++; }
    return c ? [x / c, y / c, z / c] : [0, 0, 0];
  };
  const scaleAbout = (pivot: readonly [number, number, number], factor: number, part: (v: number) => number): void => {
    if (Math.abs(factor - 1) < 1e-4) return;
    for (let v = 0; v < n; v++) {
      const w = part(v);
      if (w <= 0) continue;
      const s = 1 + (factor - 1) * w;
      for (let a = 0; a < 3; a++) p[v * 3 + a] = pivot[a]! + (p[v * 3 + a]! - pivot[a]!) * s;
    }
  };

  // ---- the legs: shorter between ankle and hip; everything above comes down with the hip
  if (Math.abs(style.legs - 1) > 1e-4) {
    const hipY = (centre('joint-l-upper-leg')[1] + centre('joint-r-upper-leg')[1]) / 2;
    const ankleY = (centre('joint-l-ankle')[1] + centre('joint-r-ankle')[1]) / 2;
    const drop = (hipY - ankleY) * (1 - style.legs);
    for (let v = 0; v < n; v++) {
      const helper = helperOf.get(v);
      const leg = helper !== undefined
        ? (/^joint-[lr]-(upper-leg|knee|ankle|foot|toe)/.test(helper) ? 1 : 0)
        : weightOf(v, (b) => LEG_BONES.some((l) => b.startsWith(l)));
      const y = p[v * 3 + 1]!;
      const asLeg = y <= ankleY ? y : y >= hipY ? y - drop : ankleY + (y - ankleY) * style.legs;
      p[v * 3 + 1] = (y - drop) * (1 - leg) + asLeg * leg;
    }
  }

  // ---- the head, about the neck
  const headPart = (v: number): number => {
    const helper = helperOf.get(v);
    if (helper !== undefined) return HEAD_HELPERS.test(helper) ? 1 : 0;
    return weightOf(v, (b) => b === 'head') + 0.35 * weightOf(v, (b) => b.startsWith('neck'));
  };
  const neck = centre('joint-neck');
  scaleAbout(neck, style.head, headPart);

  // ---- the eyes: their region swells about each eye, fading out round it
  for (const side of ['l', 'r'] as const) {
    const eye = centre(`joint-${side}-eye`);
    // The eyeball is about 0.24 dm across; the lids and the socket round it.
    const inner = 0.16 * style.head, outer = 0.42 * style.head;
    scaleAbout(eye, style.eyes, (v) => {
      if (headPart(v) <= 0) return 0;
      const d = Math.hypot(p[v * 3]! - eye[0], p[v * 3 + 1]! - eye[1], p[v * 3 + 2]! - eye[2]);
      if (d >= outer) return 0;
      const t = Math.max(0, (d - inner) / (outer - inner));
      return 1 - t * t * (3 - 2 * t);
    });
  }

  // ---- hands about the wrists, feet about the ankles
  for (const side of ['l', 'r'] as const) {
    const suffix = `_${side}`;
    scaleAbout(centre(`joint-${side}-hand`), style.hands, (v) => {
      const helper = helperOf.get(v);
      if (helper !== undefined) return new RegExp(`^joint-${side}-(hand|finger)`).test(helper) ? 1 : 0;
      return weightOf(v, (b) => b.endsWith(suffix) && /^(hand|thumb|index|middle|ring|pinky)/.test(b));
    });
    scaleAbout(centre(`joint-${side}-ankle`), style.feet, (v) => {
      const helper = helperOf.get(v);
      if (helper !== undefined) return new RegExp(`^joint-${side}-(foot|toe)`).test(helper) ? 1 : 0;
      return weightOf(v, (b) => b.endsWith(suffix) && /^(foot|ball)/.test(b));
    });
  }
  return p;
}

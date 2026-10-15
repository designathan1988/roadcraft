import type { BayComponent, BuildingUse } from '@world/buildings/types';
import { m } from '@world/units';

/** WHAT HANGS ON A FACADE AND STANDS ON ITS BALCONIES: the life of a Brazilian block of flats */

export type FacadePropKind = 'acUnit' | 'pot' | 'foliage' | 'bush' | 'chair' | 'table' | 'airer' | 'dish' | 'lounger' | 'bike';
export const FACADE_PROP_KINDS: readonly FacadePropKind[] = ['acUnit', 'pot', 'foliage', 'bush', 'chair', 'table', 'airer', 'dish', 'lounger', 'bike'];
/** The props whose shadow is worth its pass: the condensers, the pots and the plants. */
export const SHADOWED_PROPS: readonly FacadePropKind[] = ['acUnit', 'pot', 'foliage', 'bush'];
/** The props of thin bars, pre-filtered as the frames are (`thinParts.ts`): bar width, m, and the tone behind. */
export const THIN_PROPS: readonly (readonly [FacadePropKind, number, number])[] = [['chair', 0.025, 0.3], ['airer', 0.02, 0.3], ['table', 0.04, 0.3], ['bike', 0.03, 0.3]];
/** A plant pot's height, m (`facadePropModels.ts`). */
export const POT_HIGH = 0.32;

/** The condenser's case: width, height, depth (m), and its clearance off the wall. */
export const AC = { w: 0.72, h: 0.48, d: 0.23, gap: 0.08 } as const;

// ------------------------------------------------------------------ where they go

/** A prop placed on a bay: along it (`a`), up from its storey's floor (`h`, the model's origin), out of the wall (`out`), turned (`turn`, radians about up), scaled, tinted. */
export interface FacadeProp {
  readonly kind: FacadePropKind;
  readonly a: number;
  readonly h: number;
  /** Out of the wall (+) or into it (-, a loggia's floor). */
  readonly out: number;
  readonly turn: number;
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  readonly colour: number;
}

/** A condenser's cases: white, off-white, beige, grey, and the yellowed white of an old one. */
const AC_CASES = [0xf2f2ee, 0xe9e7df, 0xddd6c4, 0xc8cbca, 0xd6cba8];
/** Pots: terracotta, cement, white, black, a glazed blue, an ochre. */
const POTS = [0xb5643c, 0xa35a3a, 0x9c9a94, 0xe6e3dc, 0x2f2f2f, 0x3d5b7c, 0xc98a4a];
const GREENS = [0x4f7a3a, 0x3d6b33, 0x6a8f45, 0x2f5a3a, 0x58803f, 0x7a9a4a, 0x8a9a5a];
/** A plain block's plastic chairs (white, green, blue, red) and a better one's (wood, black, natural fibre). */
const PLASTIC = [0xf0f0ec, 0xf0f0ec, 0x3f8a52, 0x3a62a8, 0xb8342e];
const FINE = [0x8a5a36, 0x2b2b2b, 0xb8875a, 0xd9d4c8, 0x6d6a64];
const LOUNGERS = [0xece6d8, 0x2f3a46, 0x7a8a6a, 0xb08a5a];
const BIKES = [0xc0392b, 0x2c3e50, 0x16a085, 0xf1c40f, 0x9a9a9a, 0x2b2b2b];

/** The bay's opening, in its own frame: `a0`..`a1` along, `h0`..`h1` up, `depth` into the wall. */
export interface PropOpening { a0: number; a1: number; h0: number; h1: number; depth: number }

/** Which flats a balcony belongs to: a block's varandas gourmet are its better flats; a plain block's balconies */
type Standard = 'high' | 'middle' | 'popular' | 'office';
function standardOf(component: BayComponent, use: BuildingUse, old: number): Standard {
  if (use === 'commercial' || use === 'industrial') return 'office';
  if (component === 'gourmet') return 'high';
  return use === 'mixed' || old > 0.35 ? 'popular' : 'middle';
}

/** The props of one bay. */
export function facadeProps(component: BayComponent, level: number, use: BuildingUse, old: number, hash: number, W: number, o: PropOpening): FacadeProp[] {
  const out: FacadeProp[] = [];
  let state = hash >>> 0;
  const rnd = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const pick = (list: readonly number[]): number => list[Math.floor(rnd() * list.length) % list.length]!;
  const one = (kind: FacadePropKind, a: number, h: number, o0: number, turn: number, colour: number, s = 1): void => {
    out.push({ kind, a, h, out: o0, turn, sx: m(s), sy: m(s), sz: m(s), colour });
  };
  // A split under a window, by the window
  const acShare = use === 'residential' ? 0.07 : use === 'mixed' ? 0.06 : use === 'commercial' ? 0.04 : 0.02;
  const acCase = (): number => (rnd() < old * 0.8 ? AC_CASES[4]! : pick(AC_CASES.slice(0, 4)));
  /** A pot of 30 to 55 cm and its plant: a rosette (a lily, a spider plant) or a round shrub. */
  const plant = (a: number, out0: number, h: number): void => {
    const s = 0.9 + rnd() * 0.7, tall = s * (0.9 + rnd() * 0.4);
    out.push({ kind: 'pot', a, h, out: out0, turn: 0, sx: m(s), sy: m(tall), sz: m(s), colour: pick(POTS) });
    // The leaves out of the soil, 3 cm under the rim.
    const lift = m((POT_HIGH - 0.03) * tall);
    const spread = s * (0.7 + rnd() * 0.5);
    out.push({ kind: rnd() < 0.5 ? 'foliage' : 'bush', a, h: h + lift, out: out0, turn: rnd() * Math.PI * 2, sx: m(spread), sy: m(s * (0.7 + rnd() * 0.6)), sz: m(spread), colour: pick(GREENS) });
  };

  /** A balcony's floor from `a0` to `a1` along, out to `deep`, `gourmet` a varanda gourmet. */
  const furnish = (standard: Standard, gourmet: boolean, a0: number, a1: number, deep: number): void => {
    const colour = pick(standard === 'popular' ? PLASTIC : FINE);
    const mid = (a0 + a1) / 2 + (rnd() - 0.5) * m(0.3);
    const corner = (): number => (rnd() < 0.5 ? a0 + m(0.25) : a1 - m(0.25));
    const chair = (a: number, o0: number, turn: number): void => one('chair', a, m(0.002), o0, turn, colour);
    const airer = (): void => { if (a1 - a0 > m(1.3)) one('airer', (a0 + a1) / 2, m(0.002), deep * 0.5, rnd() < 0.5 ? 0 : Math.PI, 0xffffff); };
    const table = (): void => {
      const big = gourmet ? 1.15 : 0.65;
      out.push({ kind: 'table', a: mid, h: m(0.002), out: deep * 0.55, turn: 0, sx: m(big), sy: m(gourmet ? 1 : 0.75), sz: m(big), colour });
      for (const side of [-1, 1]) {
        const sa = mid + side * m(big * 0.34 + 0.32);
        if (sa > a0 + m(0.2) && sa < a1 - m(0.2)) chair(sa, deep * 0.55, side < 0 ? Math.PI / 2 : -Math.PI / 2);
      }
    };
    const r = rnd();
    if (standard === 'office') {
      // A meeting room's balcony: bare, now and then a pot.
      if (r < 0.08) plant(corner(), deep - m(0.3), m(0.003));
      return;
    }
    // Some 45 % bare.
    if (r < 0.45) return;
    if (r < 0.7) {
      // One thing: a chair, a small pot, the washing (more on a plain block).
      const t = rnd();
      if (t < 0.4) chair(mid, deep * 0.5, (rnd() - 0.5) * 0.8);
      else if (t < 0.7) plant(corner(), deep - m(0.3), m(0.003));
      else if (standard === 'popular' || t < 0.8) airer();
      else one('lounger', mid, m(0.002), deep * 0.5, 0, pick(LOUNGERS));
      return;
    }
    if (r < 0.85) {
      // Two or three: a table and two chairs, or a chair and a pot.
      if (rnd() < 0.55) table();
      else { chair(mid, deep * 0.5, (rnd() - 0.5) * 0.8); plant(mid < (a0 + a1) / 2 ? a1 - m(0.25) : a0 + m(0.25), deep - m(0.3), m(0.003)); }
      return;
    }
    if (r < 0.95) {
      // The thing of its kind of flat.
      const t = rnd();
      // No barbecue on any balcony (the player, 2026-10-14): where one stood, the balcony is bare
      if (standard === 'high') {
        // A lounger on a varanda gourmet: on two in five, and on every narrow one.
        if (t >= 0.6 || a1 - a0 <= m(1.8)) one('lounger', mid, m(0.002), deep * 0.5, 0, pick(LOUNGERS));
      } else if (t >= 0.65) {
        airer();
        if (standard === 'popular') chair(rnd() < 0.5 ? a0 + m(0.3) : a1 - m(0.3), deep * 0.35, (rnd() - 0.5) * 0.8);
      } else if (t >= 0.35) {
        // A bicycle along the wall.
        one('bike', (a0 + a1) / 2, m(0.002), m(0.22), 0, pick(BIKES));
      }
      return;
    }
    // At most one in twenty: a small garden of three or four pots along the rail.
    const n = rnd() < 0.5 ? 3 : 4;
    const step = (a1 - a0 - m(0.5)) / (n - 1);
    for (let k = 0; k < n; k++) plant(a0 + m(0.25) + k * step, deep - m(0.3), m(0.003));
  };

  switch (component) {
    case 'window':
    case 'sashWindow':
    case 'shutteredWindow':
    case 'ribbon': {
      if (level < 1) break;
      // Under the sill, on its brackets, the case's top 12 cm under the sill.
      const room = o.h0 - m(0.12) - m(AC.h);
      if (room > m(0.2) && rnd() < acShare) {
        const side = rnd();
        const a = side < 0.5 ? (o.a0 + o.a1) / 2 : side < 0.75 ? o.a0 + m(AC.w) / 2 : o.a1 - m(AC.w) / 2;
        const lo = m(AC.w) / 2 + m(0.15), hi = W - m(AC.w) / 2 - m(0.15);
        if (hi > lo) one('acUnit', Math.min(hi, Math.max(lo, a)), o.h0 - m(0.12) - m(AC.h) / 2, m(AC.gap + AC.d / 2), 0, acCase());
      } else if (use !== 'industrial' && rnd() < 0.05 && o.a1 + m(0.75) < W) {
        // A dish beside the window, at its head.
        one('dish', o.a1 + m(0.45), o.h1 - m(0.25), 0, 0, 0xe8e8e4);
      }
      break;
    }
    case 'balcony':
    case 'gourmet': {
      if (level < 1) break;
      // The balcony's floor: in from its rails (a gourmet's from its cheeks), out to its front rail.
      const gourmet = component === 'gourmet';
      const a0 = gourmet ? m(0.45) : m(0.3), a1 = W - a0, deep = gourmet ? m(1.6) : m(1.3);
      if (a1 - a0 < m(1.4)) break;
      furnish(standardOf(component, use, old), gourmet, a0, a1, deep);
      break;
    }
    case 'loggia': {
      // Let into the wall: its floor at the opening's foot, between its cheeks.
      if (level < 1 || use === 'commercial' || use === 'industrial') break;
      const a0 = o.a0 + m(0.3), a1 = o.a1 - m(0.3);
      if (a1 - a0 < m(1)) break;
      const r = rnd();
      if (r < 0.15) plant(rnd() < 0.5 ? a0 + m(0.1) : a1 - m(0.1), -m(0.35), o.h0 + m(0.003));
      else if (r < 0.35) one('chair', (a0 + a1) / 2, o.h0 + m(0.002), -m(0.7), (rnd() - 0.5) * 0.5, pick(FINE));
      else if (r < 0.42) one('lounger', (a0 + a1) / 2, o.h0 + m(0.002), -m(0.7), 0, pick(LOUNGERS));
      break;
    }
    default:
      break;
  }
  return out;
}

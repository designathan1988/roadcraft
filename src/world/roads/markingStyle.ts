import { m } from '../units';

/**
 * THE REGIONAL STANDARD OF ROAD PAINT (docs/VIAS.md V6), chosen for the map:
 *
 * - 'br', Brasil/CONTRAN (MBST vol. IV, Sinalização Horizontal, 2007, lido em
 *   texto): opposing flows split by YELLOW lines (LFO), same-direction flows
 *   by WHITE (LMS); a broken line's dash and gap by the speed - under
 *   60 km/h 1:2 (3 m and 6 m here), 60 to 80 km/h 1:3 (3 m and 9 m), 80 and
 *   over 1:3 (4 m and 12 m); the legend of an exclusive lane, "ÔNIBUS",
 *   1,60 m tall in urban roads up to 80 km/h, 2,40 m over.
 * - 'us', MUTCD (2009, 3A.05-3A.06): yellow between directions, white within
 *   one; 10 ft dashes and 30 ft gaps (3 m and 9 m); "BUS".
 * - 'eu', the Vienna Convention as most of Europe paints it: white between
 *   directions too; 3 m and 9 m; "BUS".
 * - 'classic': the game's paint before the regions (every map saved before
 *   them keeps it, so it opens identical): the class's own centre colour,
 *   8-unit dashes and gaps.
 */
export type MarkingStyleId = 'classic' | 'br' | 'us' | 'eu';
export const MARKING_STYLES: readonly MarkingStyleId[] = ['br', 'us', 'eu', 'classic'];

const YELLOW = '#e1c45a';
const WHITE = '#eee8d7';

export interface MarkingStyle {
  readonly id: MarkingStyleId;
  /** Colour of a line between opposing flows; null: the road class's own. */
  readonly centre: string | null;
  /** A broken line's dash and gap, world units, by the road's speed. */
  dash(speedKmh: number): readonly [number, number];
  /** The word painted along a bus lane. */
  readonly busText: string;
  /** The word painted before a stop line where the leg must stop. */
  readonly stopText: string;
  /** Height of a legend's letters along the road, world units, by the road's speed. */
  legendHeight(speedKmh: number): number;
}

const CLASSIC_DASH: readonly [number, number] = [m(3.2), m(3.2)];

export function markingStyle(id: MarkingStyleId | undefined): MarkingStyle {
  switch (id) {
    case 'br':
      return {
        id, centre: YELLOW, busText: 'ÔNIBUS', stopText: 'PARE',
        dash: (v) => (v < 60 ? [m(3), m(6)] : v < 80 ? [m(3), m(9)] : [m(4), m(12)]),
        legendHeight: (v) => (v > 80 ? m(2.4) : m(1.6)),
      };
    case 'us':
      return { id, centre: YELLOW, busText: 'BUS', stopText: 'STOP', dash: () => [m(3), m(9)], legendHeight: (v) => (v > 80 ? m(2.4) : m(1.6)) };
    case 'eu':
      return { id, centre: WHITE, busText: 'BUS', stopText: 'STOP', dash: () => [m(3), m(9)], legendHeight: (v) => (v > 80 ? m(2.4) : m(1.6)) };
    default:
      return { id: 'classic', centre: null, busText: 'ÔNIBUS', stopText: 'PARE', dash: () => CLASSIC_DASH, legendHeight: () => m(1.6) };
  }
}

export const isMarkingStyle = (v: unknown): v is MarkingStyleId =>
  v === 'classic' || v === 'br' || v === 'us' || v === 'eu';

/**
 * The letters of the legends, stroked: each a list of polylines in a box one
 * unit wide (x, to the driver's right) and one tall (y, along the road away
 * from the driver). Only what the legends spell.
 */
const GLYPHS: Readonly<Record<string, readonly (readonly [number, number])[][]>> = {
  O: [ring(0.5, 0.41, 0.5, 0.41)],
  Ô: [ring(0.5, 0.36, 0.5, 0.36), [[0.15, 0.82], [0.5, 1], [0.85, 0.82]]],
  N: [[[0, 0], [0, 1], [1, 0], [1, 1]]],
  I: [[[0.5, 0], [0.5, 1]]],
  B: [[[0, 0], [0, 1], [0.7, 1], [0.9, 0.88], [0.9, 0.62], [0.7, 0.52], [0, 0.52]], [[0.7, 0.52], [0.95, 0.4], [0.95, 0.12], [0.75, 0], [0, 0]]],
  U: [[[0, 1], [0, 0.18], [0.18, 0], [0.82, 0], [1, 0.18], [1, 1]]],
  P: [[[0, 0], [0, 1], [0.75, 1], [1, 0.85], [1, 0.62], [0.75, 0.48], [0, 0.48]]],
  A: [[[0, 0], [0.5, 1], [1, 0]], [[0.22, 0.42], [0.78, 0.42]]],
  R: [[[0, 0], [0, 1], [0.75, 1], [1, 0.85], [1, 0.62], [0.75, 0.48], [0, 0.48]], [[0.5, 0.48], [1, 0]]],
  E: [[[1, 1], [0, 1], [0, 0], [1, 0]], [[0, 0.5], [0.8, 0.5]]],
  T: [[[0, 1], [1, 1]], [[0.5, 1], [0.5, 0]]],
  S: [[[1, 0.88], [0.85, 1], [0.15, 1], [0, 0.86], [0, 0.62], [0.15, 0.52], [0.85, 0.48], [1, 0.38], [1, 0.14], [0.85, 0], [0.15, 0], [0, 0.12]]],
};

function ring(cx: number, cy: number, rx: number, ry: number): [number, number][] {
  return Array.from({ length: 17 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2;
    return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry] as [number, number];
  });
}

/**
 * The give-way symbol on the floor (MBST vol. IV, "SIP" / Vienna "shark's
 * tooth"): a long triangle pointing at the driver who must give way, in a
 * box one wide and one long.
 */
export const YIELD_SYMBOL: { strokes: [number, number][][]; width: number } = {
  strokes: [[[0.5, 0], [1, 1], [0, 1], [0.5, 0]], [[0.5, 0.3], [0.78, 0.9], [0.22, 0.9], [0.5, 0.3]]],
  width: 1,
};

/** A word's strokes in the unit box per letter, letters side by side with a gap of `gap` letter widths. */
export function wordStrokes(text: string, gap = 0.35): { strokes: [number, number][][]; width: number } {
  const strokes: [number, number][][] = [];
  let x = 0;
  for (const ch of text) {
    const glyph = GLYPHS[ch];
    if (glyph) for (const line of glyph) strokes.push(line.map(([gx, gy]) => [gx + x, gy] as [number, number]));
    x += 1 + gap;
  }
  return { strokes, width: Math.max(0, x - gap) };
}

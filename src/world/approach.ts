import { m } from './units';
/** The approach zone: what sits between a road and a junction mouth. */

/** Clear space between the junction mouth and the near edge of the zebra. */
const CROSSWALK_SETBACK = m(1.2);
/** Depth of the zebra along the direction of travel: 3 m, the Brazilian minimum for an urban crossing */
export const CROSSWALK_DEPTH = m(3);
/** Clear space between the far edge of the zebra and the stop line. */
export const STOP_BAR_SETBACK = m(0.64);
/** Painted width of the stop bar itself. */
export const STOP_BAR_WIDTH = m(0.4);

/** Distance from the node to the centre of the crossing. */
export const crosswalkDistance = (trim: number): number =>
  trim + CROSSWALK_SETBACK + CROSSWALK_DEPTH / 2;

/** Distance from the node to the stop line, i.e. the end of a link lanelet. */
export const stopLineDistance = (trim: number): number =>
  trim + CROSSWALK_SETBACK + CROSSWALK_DEPTH + STOP_BAR_SETBACK;

/** How much further back than the junction mouth the approach zone reaches. */
const APPROACH_DEPTH =
  CROSSWALK_SETBACK + CROSSWALK_DEPTH + STOP_BAR_SETBACK;

/** Drivable length every link must retain between two approach zones. */
export const MIN_LINK_LENGTH = m(14.4);

/** Total length a segment must reserve for drivable road plus both approaches. */
export const MIN_DRIVABLE_RESERVE = MIN_LINK_LENGTH + 2 * APPROACH_DEPTH;

/** The fractional caps that stop one end of a segment eating the whole thing. */

/** Ceiling on one leg's own trim guess, before the solver reconciles legs. */
export const LEG_TRIM_CAP = 0.48;

/** Ceiling on the drivable reserve a short segment is asked to keep. */
export const RESERVE_CAP = 0.86;

/** Ceiling on the stop line's distance from a node. */
export const STOP_LINE_CAP = 0.45;

/** Ceiling on the crossing's distance from a node. */
export const CROSSWALK_CAP = 0.49;

/** THE ERROR SCALE THAT FITS THE FRAME: the levels are chosen by their error on the screen (`massCells.ts` `measureSeen`, 2 px at scale 1); when what they add up to passes the view's budget of triangles, the scale rises until it fits, and it comes back down a step at a time while there is room (Cesium's `maximumScreenSpaceError` adjusted to memory and time) */

/** Each step of the scale: a quarter coarser or finer. */
export const ERROR_STEP = 1.25;
/** The coarsest scale: 64 px of error, every cell at its masses or its plate (DO NOT climb for ever: a count that never fits, a view of nothing, would spin). */
export const MOST_ERROR_SCALE = 32;
/** Under this share of the budget the scale may come down a step (a gap under the budget, so a step down does not step up again next frame). */
export const SLACK = 0.6;

/** THE CELLS HELD BACK THAT THE EYE CAME NEARER TO THAN A CELL KEPT (`layer.ts` capTriangles): let go. The budget coarsens the farthest first; a cell held in one view stayed held when the eye went down into it, its neighbours farther off kept in detail: the street view showed the building at the camera at its facade level (conferencia 09-street, 2026-10-17). `kept`: the cells drawn near now, each with whether at full detail; `away`: a cell's distance from the eye. */
export function letGoPassed(heldFar: Set<string>, heldCoarse: Set<string>, kept: Iterable<{ readonly key: string; readonly fine: boolean }>, away: (key: string) => number): void {
  let nearest = -1, finest = -1;
  for (const { key, fine } of kept) {
    const d = away(key);
    if (d > nearest) nearest = d;
    if (fine && d > finest) finest = d;
  }
  for (const key of heldFar) if (away(key) < nearest) heldFar.delete(key);
  for (const key of heldCoarse) if (away(key) < finest) heldCoarse.delete(key);
}

/** THE CELLS HELD BACK THAT FIT AGAIN (`layer.ts` capTriangles): each a level back, the ones spanning most of the screen first (`rank`, least first), while `drawn` with what it adds (`more`: far to its facade level, facade level to its detail) stays within `budget`; a far one comes back to its facade level only (held coarse), its detail when that fits too. DO NOT wait for the view to fall under `SLACK` of the budget: a still view never does, and the cells cut stayed cut (conferencia 40). */
export function letBackFitting(heldFar: Set<string>, heldCoarse: Set<string>, drawn: number, budget: number, rank: (key: string) => number, more: (key: string, far: boolean) => number): void {
  // Each key ranked once, not twice per comparison (PRD-30): the same stable order.
  const keys = new Set(heldCoarse);
  for (const key of heldFar) keys.add(key);
  const ranked: { key: string; rank: number }[] = [];
  for (const key of keys) ranked.push({ key, rank: rank(key) });
  ranked.sort((a, b) => a.rank - b.rank);
  for (const { key } of ranked) {
    const far = heldFar.has(key);
    const add = more(key, far);
    if (drawn + add > budget) continue;
    drawn += add;
    if (far) { heldFar.delete(key); heldCoarse.add(key); } else heldCoarse.delete(key);
  }
}

/** The scale that fits `budget`: `count(scale)` chooses the levels at that scale and says their triangles; `floor`, the least scale the frame's time allows (`layer.ts` `pressTime`).
 *  - Over the budget: coarser, step by step, until it fits or the coarsest is reached. Under `SLACK` of it and above the floor: one step finer, kept only if that still fits. */
export function fitErrorScale(scale: number, floor: number, budget: number, count: (scale: number) => number): number {
  let k = Math.max(floor, Math.min(MOST_ERROR_SCALE, scale));
  let n = count(k);
  while (n > budget && k < MOST_ERROR_SCALE) {
    k = Math.min(MOST_ERROR_SCALE, k * ERROR_STEP);
    n = count(k);
  }
  if (n <= budget * SLACK && k > floor) {
    const finer = Math.max(floor, k / ERROR_STEP);
    // `count` chooses as it counts: the scale kept is the one chosen last.
    if (count(finer) <= budget) k = finer; else count(k);
  }
  return k;
}

/** THE SCALE OF A FRAME (`layer.ts` `levelOfDetail`): the most triangles the levels may add up to (`budget`, the view's, `core/perfBudget.ts`) and the scale that fits it (`scale`). The frame's time is the quality governor's (`render/quality.ts` QualityGovernor), never the levels': the detail is kept to 1.4 km. */
export class FrameScale {
  budget = Infinity;
  scale = 1;
  /** The levels chosen at the scale that fits the budget: `count` chooses at a scale and says their triangles. */
  fit(count: (scale: number) => number): void {
    this.scale = fitErrorScale(this.scale, 1, this.budget, count);
  }
}

/** What a cell's level is reckoned to draw before any of its kind landed: a dense cell's detail and facade level with their parts, as measured by the predios session (2026-10-17: 1.3 M and 0.6 M, twice the 2026-10-16 figures). */
export const TYPICAL_LEVEL_TRIANGLES: Readonly<Record<'cell' | 'facade', number>> = { cell: 1_300_000, facade: 600_000 };

/** WHAT A LEVEL DRAWS OR HOLDS, reckoned before it lands (`layer.ts` `chosenTriangles`, `capNow`): as it measured when it last landed, else the mean of its kind's landed, else `typical`. */
export class LandedMeasure<K extends string> {
  private readonly landed = new Map<string, number>();
  private readonly sums = new Map<K, { sum: number; n: number }>();
  /** Each landed level's weight when it landed (`weightOf`), and per kind the levels' sum over their weights' sum. */
  private readonly weights = new Map<string, number>();
  private readonly ratios = new Map<K, { measured: number; weight: number }>();
  /** Called whenever what it answers may change (`layer.ts` levelOfDetail chooses the levels again then). */
  changed: () => void = () => {};
  /** What a cell weighs whatever its level (`layer.ts`: its masses' triangles, always at hand), 0 when unknown: a level never landed, or let go, is reckoned at its weight times what the landed ones measured per unit of theirs. DO NOT reckon it at a dense cell's `typical`: a suburb's cell let go came back as 1.3 M triangles, never fitted the budget again and stood in its masses for good. */
  weightOf: (key: string) => number = () => 0;
  constructor(private readonly typical: Readonly<Record<K, number>>) {}
  set(kind: K, key: string, triangles: number): void {
    const at = `${kind}|${key}`;
    const s = this.sums.get(kind) ?? { sum: 0, n: 0 };
    const was = this.landed.get(at);
    if (was === triangles) return;
    this.changed();
    if (was !== undefined) s.sum -= was; else s.n++;
    s.sum += triangles;
    this.sums.set(kind, s);
    this.landed.set(at, triangles);
    this.unweigh(kind, at, was);
    const weight = this.weightOf(key);
    if (weight > 0) {
      const r = this.ratios.get(kind) ?? { measured: 0, weight: 0 };
      r.measured += triangles; r.weight += weight;
      this.ratios.set(kind, r);
      this.weights.set(at, weight);
    }
  }
  /** The cell's levels of the other kinds that landed, with what they measured (none when the typical figures are not numbers). */
  private *othersOf(kind: K, key: string): Generator<[K, number]> {
    for (const other of Object.keys(this.typical) as K[]) {
      if (other === kind || !(this.typical[other] > 0) || !(this.typical[kind] > 0)) continue;
      const measured = this.landed.get(`${other}|${key}`);
      if (measured !== undefined) yield [other, measured];
    }
  }
  private unweigh(kind: K, at: string, was: number | undefined): void {
    const weight = this.weights.get(at);
    if (weight === undefined || was === undefined) return;
    const r = this.ratios.get(kind)!;
    r.measured -= was; r.weight -= weight;
    this.weights.delete(at);
  }
  /** A cell gone from the town (its tile left the active region): its measures let go, out of the means too (DO NOT keep every cell the camera ever passed: the books grew with the road walked, not with the view). */
  forget(key: string): void {
    for (const [kind, s] of this.sums) {
      const at = `${kind}|${key}`;
      const was = this.landed.get(at);
      if (was === undefined) continue;
      this.changed();
      this.unweigh(kind, at, was);
      this.landed.delete(at);
      s.sum -= was;
      s.n--;
    }
  }
  /** How many levels are measured (`BuildingLayer.books`). */
  get size(): number {
    return this.landed.size;
  }
  of(kind: K, key: string): number {
    const got = this.landed.get(`${kind}|${key}`);
    if (got !== undefined) return got;
    const weight = this.weightOf(key), r = this.ratios.get(kind);
    if (weight > 0 && r && r.weight > 0) return (weight * r.measured) / r.weight;
    // The same cell's other level measured: this one in the typical proportion between the two. DO NOT reckon a cell's facade level at a dense cell's 600 k when its detail measured 3 k: stepping it down to that level looked dearer than its detail, and it went to its masses.
    for (const [other, measured] of this.othersOf(kind, key)) return (measured * this.typical[kind]) / this.typical[other];
    const s = this.sums.get(kind);
    return s?.n ? s.sum / s.n : this.typical[kind];
  }
}

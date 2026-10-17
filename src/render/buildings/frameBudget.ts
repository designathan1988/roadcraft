/** THE ERROR SCALE THAT FITS THE FRAME: the levels are chosen by their error on the screen (`massCells.ts` `measureSeen`, 2 px at scale 1); when what they add up to passes the view's budget of triangles, the scale rises until it fits, and it comes back down a step at a time while there is room (Cesium's `maximumScreenSpaceError` adjusted to memory and time) */

/** Each step of the scale: a quarter coarser or finer. */
export const ERROR_STEP = 1.25;
/** The coarsest scale: 64 px of error, every cell at its masses or its plate (DO NOT climb for ever: a count that never fits, a view of nothing, would spin). */
export const MOST_ERROR_SCALE = 32;
/** Under this share of the budget the scale may come down a step (a gap under the budget, so a step down does not step up again next frame). */
export const SLACK = 0.6;
/** The most the GPU's time may raise the scale (`layer.ts` `pressTime`): 8 px of error keeps the street view's near cells in detail (0.3 m spans 8.4 px at 28 px a metre); a frame slow past that is not slow for triangles, and coarser levels would only take the picture away. */
export const MOST_TIME_SCALE = 4;

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

/** THE SCALE OF A FRAME (`layer.ts` `levelOfDetail`): the most triangles the levels may add up to (`budget`, the view's, `core/perfBudget.ts`), the scale that fits it (`scale`) and the least the GPU's time allows (`floor`, `press`). */
export class FrameScale {
  budget = Infinity;
  scale = 1;
  floor = 1;
  /** The levels chosen at the scale that fits the budget: `count` chooses at a scale and says their triangles. */
  fit(count: (scale: number) => number): void {
    this.scale = fitErrorScale(this.scale, this.floor, this.budget, count);
  }
  /** The floor a step up (coarser than what is drawn now: a floor under the scale the budget chose would change nothing) or down; false when it cannot move. */
  press(up: boolean): boolean {
    const next = up ? Math.min(MOST_TIME_SCALE, Math.max(this.floor, this.scale) * ERROR_STEP) : Math.max(1, this.floor / ERROR_STEP);
    if (next === this.floor) return false;
    this.floor = next;
    return true;
  }
}

/** What a cell's level is reckoned to draw before any of its kind landed: a dense cell's detail and facade level with their parts, as measured by the predios session (2026-10-17: 1.3 M and 0.6 M, twice the 2026-10-16 figures). */
export const TYPICAL_LEVEL_TRIANGLES: Readonly<Record<'cell' | 'facade', number>> = { cell: 1_300_000, facade: 600_000 };

/** WHAT A LEVEL DRAWS OR HOLDS, reckoned before it lands (`layer.ts` `chosenTriangles`, `capNow`): as it measured when it last landed, else the mean of its kind's landed, else `typical`. */
export class LandedMeasure<K extends string> {
  private readonly landed = new Map<string, number>();
  private readonly sums = new Map<K, { sum: number; n: number }>();
  constructor(private readonly typical: Readonly<Record<K, number>>) {}
  set(kind: K, key: string, triangles: number): void {
    const at = `${kind}|${key}`;
    const s = this.sums.get(kind) ?? { sum: 0, n: 0 };
    const was = this.landed.get(at);
    if (was !== undefined) s.sum -= was; else s.n++;
    s.sum += triangles;
    this.sums.set(kind, s);
    this.landed.set(at, triangles);
  }
  of(kind: K, key: string): number {
    const got = this.landed.get(`${kind}|${key}`);
    if (got !== undefined) return got;
    const s = this.sums.get(kind);
    return s?.n ? s.sum / s.n : this.typical[kind];
  }
}

/** A step up paid only if the window's p95 fell by this share of what it was: under it the frame is slow for pixels (the targets, MSAA, the post chain), not for triangles, and coarser levels would only take the picture away (measured 2026-10-16: 22.9 ms at 2.96 M triangles on the RTX 3060, the same at 13 M). */
export const GAIN = 0.1;
/** Under this share of the budget the time's floor may come down a step. */
export const TIME_SLACK = 0.66;
/** The floor rises only past this many times the budget (30 ms at 12: under 33 fps, a view not playable). DO NOT trade the picture for a frame time the view cannot reach anyway: the pixel pipeline alone costs 15-20 ms at 1080p on the RTX 3060, and the governor stepped the district view down to masses chasing 12 ms (2026-10-16). */
export const OVER = 2.5;

/** THE GPU'S TIME GOVERNS THE SCALE'S FLOOR, one window of frames at a time (`renderer.ts` `governFrame`): past `OVER` times the budget, a step coarser is asked; the next window is the levels' to settle; the one after says whether the step paid (`GAIN`). A step that did not pay is undone and none is tried again until the frame is slower than it was then by `GAIN` (something changed) or the view changes (`reset`). Well under the budget, a step finer. */
export class TimeGovernor {
  /** The p95 before the step up being judged, ms. */
  private pressedAt: number | null = null;
  /** The window after a step up is the levels' to settle: judged on the one after. */
  private settling = false;
  /** The p95 at which a step up bought nothing, ms: none tried again under it. */
  private vainAt = Infinity;

  /** A window's p95 against the view's budget, ms: `press(true)` asks the floor a step coarser (false when there is none left), `press(false)` a step finer. */
  read(p95: number, budget: number, press: (up: boolean) => boolean): void {
    if (this.pressedAt !== null) {
      if (this.settling) { this.settling = false; return; }
      const before = this.pressedAt;
      this.pressedAt = null;
      if (p95 > before * (1 - GAIN)) { press(false); this.vainAt = before; return; }
    }
    if (p95 > budget * OVER) {
      if (p95 > this.vainAt * (1 + GAIN)) this.vainAt = Infinity;
      if (this.vainAt === Infinity && press(true)) { this.pressedAt = p95; this.settling = true; }
    } else if (p95 < budget * TIME_SLACK) {
      press(false);
      this.vainAt = Infinity;
    }
  }

  /** Another view: what was learnt of the last forgotten. */
  reset(): void {
    this.pressedAt = null;
    this.settling = false;
    this.vainAt = Infinity;
  }
}

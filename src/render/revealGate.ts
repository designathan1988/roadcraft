/**
 * WHEN A TOWN PUT TOGETHER UNSEEN IS SHOWN (the opening and every map opened,
 * `SceneHandle.beginLoad`): held until it is whole - Unity's
 * `allowSceneActivation = false`, the scene loaded in the background and
 * activated once ready - then one frame drawn unseen so its meshes reach the
 * GPU behind the curtain, then shown.
 *
 * The safety limit is the time spent WORKING on it, not the time on the
 * clock: a load in a pane the browser stopped drawing (hidden or covered:
 * `requestAnimationFrame` waits for the page to be visible) gets no frames,
 * and a wall-clock limit lifted the curtain on a town with no buildings yet
 * (2026-10-09). A frame's gap counts at most `MAX_GAP_MS`.
 */
export type RevealStep = 'hold' | 'warm' | 'show';

/** Working time after which the town is shown however far it got: never a curtain for ever. */
export const REVEAL_LIMIT_MS = 90_000;
/** The most one gap between two frames of the load counts towards the limit. */
const MAX_GAP_MS = 1000;

export class RevealGate {
  /** Shown: the town is drawn. */
  opened = false;
  private work = 0;
  private last = -1;
  private warmed = false;
  /** Starts holding (a map being opened). */
  begin(): void {
    this.opened = false;
    this.work = 0;
    this.last = -1;
    this.warmed = false;
  }
  /** Working time counted so far, ms. */
  get worked(): number {
    return this.work;
  }
  /** One frame of the load: `whole`, everything of the town is in. */
  step(whole: boolean, now: number): RevealStep {
    if (this.opened) return 'show';
    if (this.last >= 0) this.work += Math.min(MAX_GAP_MS, Math.max(0, now - this.last));
    this.last = now;
    if (whole && !this.warmed) {
      this.warmed = true;
      return 'warm';
    }
    if (whole || this.work > REVEAL_LIMIT_MS) {
      this.opened = true;
      return 'show';
    }
    return 'hold';
  }
}

/** WHEN A TOWN PUT TOGETHER UNSEEN IS SHOWN (the opening and every map opened, `SceneHandle.beginLoad`) */
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
  /** One frame of the load: `whole`, everything of the town is in; `making`, the map is still being generated (the opening waits for all of it, `holdOpening`: that time is not the town's to put together and does not count). */
  step(whole: boolean, now: number, making = false): RevealStep {
    if (this.opened) return 'show';
    if (this.last >= 0 && !making) this.work += Math.min(MAX_GAP_MS, Math.max(0, now - this.last));
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

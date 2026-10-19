/** Canvas sizing and device-pixel-ratio handling. */
const MAX_DPR = 2;

/** DO NOT ask the canvas for a context nor size its backing store to the screen (UI-11): nothing draws on it (the pointer's target and the screen's measure), and its opaque, desynchronized 2D store of the whole screen was memory and a compositor layer for nothing. */
export class CanvasSurface {
  dpr = 1;
  cssW = 1;
  cssH = 1;

  /** The screen in device pixels as last measured: what a change is told by. */
  private deviceW = 0;
  private deviceH = 0;
  private ro: ResizeObserver | null = null;
  private stopDprWatch: (() => void) | null = null;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly onResize?: () => void,
  ) {
    canvas.width = 1;
    canvas.height = 1;
    this.resize();
  }

  /** Starts watching for size and pixel-density changes. */
  observe(): void {
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.handleChange());
      this.ro.observe(this.canvas);
    }
    window.addEventListener('resize', this.handleChange, { passive: true });
    window.visualViewport?.addEventListener('resize', this.handleChange, { passive: true });
    this.stopDprWatch = watchDpr(() => this.handleChange());
  }

  dispose(): void {
    this.ro?.disconnect();
    this.ro = null;
    window.removeEventListener('resize', this.handleChange);
    window.visualViewport?.removeEventListener('resize', this.handleChange);
    this.stopDprWatch?.();
    this.stopDprWatch = null;
  }

  private handleChange = (): void => {
    if (this.resize()) this.onResize?.();
  };

  /** Returns true when the screen's size in device pixels changed. */
  resize(): boolean {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, rect.width || window.innerWidth);
    const cssH = Math.max(1, rect.height || window.innerHeight);
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));

    this.dpr = dpr;
    this.cssW = cssW;
    this.cssH = cssH;

    if (this.deviceW === w && this.deviceH === h) return false;
    this.deviceW = w;
    this.deviceH = h;
    return true;
  }
}

/** Calls `cb` whenever the device pixel ratio changes. */
function watchDpr(cb: (dpr: number) => void): () => void {
  let mq: MediaQueryList | null = null;
  let disposed = false;

  const fire = (): void => {
    if (disposed) return;
    cb(window.devicePixelRatio);
    arm();
  };

  const arm = (): void => {
    if (disposed) return;
    mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener('change', fire, { once: true });
  };

  arm();
  return () => {
    disposed = true;
    mq?.removeEventListener('change', fire);
  };
}

import { Vector2, type Camera } from 'three';
import { REGION_IDS, type HandShaper, type Region } from './direct';
import { el } from './widgets';

/** SHAPING BY HAND ON THE MODEL, as Create-a-Sim and Character Creator do it: the part under the pointer lights up (a raycast against each vertex's region),
 *  and dragging it moves its two sliders at once - sideways one, up and down the other - drawn on the person every frame from the sliders' samples
 *  (`reshape.ts`), exact when the hand lets go. Shift drags four times finer, Escape puts the part back as it was, a double click sets it to the middle. */

export interface HandHost {
  readonly canvas: HTMLCanvasElement;
  readonly stage: HTMLElement;
  readonly camera: Camera;
  readonly controls: { enabled: boolean };
  /** The glow over the part under the pointer (`regionGlow`): the region's place in `REGION_IDS` + 1, 0 for none. */
  readonly glow: { readonly hover: { value: number } };
  shaper(): HandShaper | null;
  /** True when the hand shapes (the body or face tab, no editor open). */
  active(): boolean;
  value(slider: string): number;
  /** The two sliders set (the shape drawn at once). */
  set(values: Readonly<Record<string, number>>, sliders: readonly string[]): void;
  /** The hand let go: the exact shape now. */
  rest(): void;
}

/** Pixels of drag for the whole of a slider's half range; Shift four times finer. */
const PIXELS = 220;
const FINE = 4;

export class HandDrag {
  private readonly tip = el('div', { cls: 'tip' });
  private drag: { region: Region; x0: number; y0: number; fx: number; fy: number; pointer: number; fine: boolean } | null = null;
  private lastPick = 0;

  constructor(private readonly host: HandHost) {
    host.stage.append(this.tip);
    const c = host.canvas;
    c.addEventListener('pointerdown', (e) => this.down(e));
    c.addEventListener('pointermove', (e) => this.move(e));
    c.addEventListener('pointerup', () => this.up());
    c.addEventListener('pointercancel', () => this.up());
    c.addEventListener('pointerleave', () => { if (!this.drag) this.hide(); });
    c.addEventListener('dblclick', (e) => this.reset(e));
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.drag) this.cancel(); });
  }

  /** True while a part is being dragged. */
  get dragging(): boolean { return !!this.drag; }

  private ndc(e: MouseEvent): Vector2 {
    const r = this.host.canvas.getBoundingClientRect();
    return new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  private pick(e: MouseEvent): Region | null {
    const shaper = this.host.shaper();
    return shaper && this.host.active() ? shaper.pick(this.ndc(e), this.host.camera) : null;
  }

  private hide(): void {
    this.tip.classList.remove('on');
    this.host.glow.hover.value = 0;
    this.host.canvas.style.cursor = '';
  }

  /** The part's name and its two sliders, each as a bar from -1 to 1, by the pointer. */
  private show(e: MouseEvent, region: Region | null): void {
    this.host.glow.hover.value = region ? REGION_IDS.indexOf(region.id) + 1 : 0;
    if (!region) { this.hide(); return; }
    const r = this.host.stage.getBoundingClientRect();
    this.tip.style.left = `${e.clientX - r.left + 16}px`;
    this.tip.style.top = `${e.clientY - r.top + 12}px`;
    const bar = (arrow: string, label: string, v: number): string =>
      `<div class="tip-axis"><span>${arrow} ${label}</span><i><b style="left:${Math.min(50, 50 + v * 50)}%;width:${Math.abs(v) * 50}%"></b></i><em>${v.toFixed(2)}</em></div>`;
    this.tip.innerHTML = `<b>${region.label}</b>${bar('↔', region.x.label, this.host.value(region.x.slider))}${bar('↕', region.y.label, this.host.value(region.y.slider))}`;
    this.tip.classList.add('on');
    this.host.canvas.style.cursor = this.drag ? 'grabbing' : 'grab';
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0 || e.altKey) return;
    const region = this.pick(e);
    if (!region) return;
    this.drag = { region, x0: e.clientX, y0: e.clientY, fx: this.host.value(region.x.slider), fy: this.host.value(region.y.slider), pointer: e.pointerId, fine: false };
    this.host.controls.enabled = false;
    this.host.canvas.setPointerCapture(e.pointerId);
    this.show(e, region);
  }

  private move(e: PointerEvent): void {
    const d = this.drag;
    if (!d) {
      if (!this.host.active()) { this.hide(); return; }
      const now = performance.now();
      if (now - this.lastPick < 50) return;
      this.lastPick = now;
      this.show(e, this.pick(e));
      return;
    }
    // Shift mid-drag starts the fine drag from where the hand is.
    const scale = e.shiftKey ? PIXELS * FINE : PIXELS;
    if (e.shiftKey !== d.fine) {
      d.fx = this.host.value(d.region.x.slider); d.fy = this.host.value(d.region.y.slider);
      d.x0 = e.clientX; d.y0 = e.clientY;
      d.fine = e.shiftKey;
    }
    const clamp = (x: number): number => Math.max(-1, Math.min(1, x));
    const vx = clamp(d.fx + (e.clientX - d.x0) / scale), vy = clamp(d.fy - (e.clientY - d.y0) / scale);
    this.host.set({ [d.region.x.slider]: vx, [d.region.y.slider]: vy }, [d.region.x.slider, d.region.y.slider]);
    this.show(e, d.region);
  }

  private up(): void {
    if (!this.drag) return;
    this.drag = null;
    this.host.controls.enabled = true;
    this.host.rest();
  }

  /** The part back as it was before the drag. */
  private cancel(): void {
    const d = this.drag!;
    this.host.set({ [d.region.x.slider]: d.fx, [d.region.y.slider]: d.fy }, [d.region.x.slider, d.region.y.slider]);
    if (this.host.canvas.hasPointerCapture(d.pointer)) this.host.canvas.releasePointerCapture(d.pointer);
    this.up();
    this.hide();
  }

  /** Both sliders of the part under the pointer to the middle. */
  private reset(e: MouseEvent): void {
    const region = this.pick(e);
    if (!region) return;
    this.host.set({ [region.x.slider]: 0, [region.y.slider]: 0 }, [region.x.slider, region.y.slider]);
    this.host.rest();
    this.show(e, region);
  }
}

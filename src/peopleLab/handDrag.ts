import { Vector2, type Camera } from 'three';
import { REGION_IDS, type HandShaper, type Region } from './direct';
import { el } from './widgets';
import { icon } from './icons';

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
  private drag: { region: Region; x0: number; y0: number; fx: number; fy: number; pointer: number; fine: boolean; moved: boolean } | null = null;
  private lastPick = 0;
  /** The part clicked (not dragged): its box stays where it was clicked, with real sliders, until closed. */
  private pinned: { region: Region; inputs: [HTMLInputElement, HTMLOutputElement][] } | null = null;

  constructor(private readonly host: HandHost) {
    host.stage.append(this.tip);
    const c = host.canvas;
    c.addEventListener('pointerdown', (e) => this.down(e));
    c.addEventListener('pointermove', (e) => this.move(e));
    c.addEventListener('pointerup', () => this.up());
    c.addEventListener('pointercancel', () => this.up());
    c.addEventListener('pointerleave', () => { if (!this.drag) this.hide(); });
    c.addEventListener('dblclick', (e) => this.reset(e));
    window.addEventListener('keydown', (e) => { if (e.key !== 'Escape') return; if (this.drag) this.cancel(); else if (this.pinned) this.unpin(); });
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
    if (this.pinned) return;
    this.tip.classList.remove('on');
    this.host.glow.hover.value = 0;
    this.host.canvas.style.cursor = '';
  }

  /** The part's name and its two sliders, each as a bar from -1 to 1, by the pointer. */
  private show(e: MouseEvent, region: Region | null): void {
    // A pinned box stays put; a drag on its own part moves its sliders.
    if (this.pinned) { if (this.drag?.region === this.pinned.region) this.sync(); return; }
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
    if (!region) { if (this.pinned) this.unpin(); return; }
    if (this.pinned && this.pinned.region !== region) this.unpin();
    this.drag = { region, x0: e.clientX, y0: e.clientY, fx: this.host.value(region.x.slider), fy: this.host.value(region.y.slider), pointer: e.pointerId, fine: false, moved: false };
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
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
    d.moved = true;
    const clamp = (x: number): number => Math.max(-1, Math.min(1, x));
    const vx = clamp(d.fx + (e.clientX - d.x0) / scale), vy = clamp(d.fy - (e.clientY - d.y0) / scale);
    this.host.set({ [d.region.x.slider]: vx, [d.region.y.slider]: vy }, [d.region.x.slider, d.region.y.slider]);
    this.show(e, d.region);
  }

  private up(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.host.controls.enabled = true;
    // A click without a drag: the part's box pinned with its sliders.
    if (!d.moved) { this.pin(d.region); return; }
    this.host.rest();
  }

  /** The part's box as a small inspector where it stands: a real slider for each of its two sliders, and a close icon. */
  private pin(region: Region): void {
    this.unpin();
    const names = [region.x.slider, region.y.slider];
    const close = el('button', { cls: 'tip-close', title: 'Fechar (Esc)' }, icon('close', 12));
    close.onclick = () => this.unpin();
    const inputs: [HTMLInputElement, HTMLOutputElement][] = [];
    const rows = ([['↔', region.x] as const, ['↕', region.y] as const]).map(([arrow, axis]) => {
      const input = el('input', { type: 'range', min: '-1', max: '1', step: '0.01', value: String(this.host.value(axis.slider)) });
      const out = el('output', { textContent: this.host.value(axis.slider).toFixed(2) });
      input.addEventListener('input', () => {
        out.textContent = (+input.value).toFixed(2);
        this.host.set({ [axis.slider]: +input.value }, names);
      });
      input.addEventListener('change', () => this.host.rest());
      // Double click: back to the middle.
      input.addEventListener('dblclick', () => { input.value = '0'; out.textContent = '0.00'; this.host.set({ [axis.slider]: 0 }, names); this.host.rest(); });
      inputs.push([input, out]);
      return el('label', { cls: 'tip-axis' }, el('span', { textContent: `${arrow} ${axis.label}` }), input, out);
    });
    this.tip.replaceChildren(el('div', { cls: 'tip-head' }, el('b', { textContent: region.label }), close), ...rows);
    this.tip.classList.add('on', 'pinned');
    this.host.glow.hover.value = REGION_IDS.indexOf(region.id) + 1;
    this.pinned = { region, inputs };
  }

  private unpin(): void {
    if (!this.pinned) return;
    this.pinned = null;
    this.tip.classList.remove('pinned');
    this.hide();
  }

  /** The pinned box's sliders as the person has them now. */
  private sync(): void {
    const p = this.pinned;
    if (!p) return;
    [p.region.x.slider, p.region.y.slider].forEach((name, i) => {
      const v = this.host.value(name);
      const [input, out] = p.inputs[i]!;
      input.value = String(v); out.textContent = v.toFixed(2);
    });
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
    this.sync();
    this.show(e, region);
  }
}

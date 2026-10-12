import { formatDecimal, t } from './i18n';

/**
 * THE COCKPIT'S HEAD-UP DISPLAY while flying (the player, 2026-10-11: "ainda
 * não parece que estou viajando numa nave espacial"): what a fighter's or a
 * spaceship's HUD shows round the sight -
 *  - the artificial horizon: the horizon line with a gap for the sight, and
 *    a pitch ladder every 10 degrees, placed on the screen through the lens
 *    (a line `p` degrees up stands at tan(p - pitch) times the focal length);
 *    it fades out far in space, where there is no horizon;
 *  - the speed on the left, the height on the right, in boxes as HUDs carry
 *    them, the throttle as a bar under the speed;
 *  - the jump to hyperspeed named while it lasts.
 * One SVG, its elements made once; a frame only writes the attributes whose
 * value changed.
 */
export interface FlightCockpitState {
  /** World units a second, and the units a metre. */
  readonly speed: number;
  readonly height: number;
  readonly unit: number;
  /** The throttle, 1/32 .. 32 (1 the keys' own speed). */
  readonly throttle: number;
  /** The look's pitch (rad, up +) and how much horizon there is (0..1). */
  readonly pitch: number;
  readonly horizon: number;
  /** The jump (0..1). */
  readonly warp: number;
  /** The lens's vertical field, degrees. */
  readonly fov: number;
}

export interface FlightCockpit {
  update(state: FlightCockpitState): void;
  show(on: boolean): void;
  readonly element: SVGSVGElement;
}

const NS = 'http://www.w3.org/2000/svg';
const INK = 'rgba(150,240,220,0.85)';
const LADDER = [-30, -20, -10, 10, 20, 30] as const;

const make = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

/** A distance in metres for the HUD: metres under 10 km, kilometres over. */
function distance(metres: number): string {
  return metres < 10000 ? `${formatDecimal(metres, 0)} m` : `${formatDecimal(metres / 1000, metres < 100000 ? 1 : 0)} km`;
}
function speedText(ms: number): string {
  return ms < 1000 ? `${formatDecimal(ms, 0)} m/s` : `${formatDecimal(ms / 1000, ms < 10000 ? 2 : 1)} km/s`;
}

export function mountFlightCockpit(parent: HTMLElement): FlightCockpit {
  const svg = make('svg', { 'aria-hidden': 'true', id: 'flightCockpit' });
  svg.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:28;pointer-events:none;overflow:visible;'
    + 'font:600 12px/1 Inter,ui-sans-serif,"Segoe UI",Roboto,sans-serif;filter:drop-shadow(0 0 2px rgba(0,0,0,.8))';
  svg.style.display = 'none';
  const horizon = make('g', {});
  const level = make('path', { fill: 'none', stroke: INK, 'stroke-width': '1.5' });
  horizon.appendChild(level);
  const rungs = LADDER.map((deg) => {
    const g = make('g', {});
    const line = make('path', { fill: 'none', stroke: INK, 'stroke-width': '1', 'stroke-dasharray': deg < 0 ? '6 4' : '' });
    const label = make('text', { fill: INK, 'text-anchor': 'start', 'dominant-baseline': 'middle' });
    // Signed, as aviation HUDs mark them: below the horizon minus, its rungs dashed.
    label.textContent = deg < 0 ? `−${-deg}` : String(deg);
    g.append(line, label);
    horizon.appendChild(g);
    return { deg, g, line, label };
  });
  const box = (anchor: 'start' | 'end'): { g: SVGGElement; frame: SVGRectElement; name: SVGTextElement; value: SVGTextElement } => {
    const g = make('g', {});
    const frame = make('rect', { fill: 'rgba(8,20,24,0.35)', stroke: INK, 'stroke-width': '1', rx: '3', width: '108', height: '36' });
    const name = make('text', { fill: INK, 'text-anchor': anchor, 'font-size': '10', opacity: '0.8' });
    const value = make('text', { fill: '#eafffb', 'text-anchor': anchor, 'font-size': '15' });
    g.append(frame, name, value);
    return { g, frame, name, value };
  };
  const left = box('start'), right = box('end');
  const bar = make('rect', { fill: INK, height: '3', rx: '1.5' });
  const barTrack = make('rect', { fill: 'rgba(150,240,220,0.18)', height: '3', rx: '1.5', width: '108' });
  const jump = make('text', { fill: '#a9c8ff', 'text-anchor': 'middle', 'font-size': '13', 'letter-spacing': '3' });
  svg.append(horizon, left.g, right.g, barTrack, bar, jump);
  parent.appendChild(svg);

  const last: Record<string, string> = {};
  const set = (e: Element, key: string, name: string, value: string): void => {
    if (last[key] === value) return;
    last[key] = value;
    if (name === '#text') e.textContent = value; else e.setAttribute(name, value);
  };

  return {
    element: svg,
    show(on) {
      svg.style.display = on ? '' : 'none';
    },
    update(st) {
      const w = window.innerWidth, h = window.innerHeight;
      const cx = w / 2, cy = h / 2;
      const focal = (h / 2) / Math.tan((st.fov * Math.PI) / 360);
      const pitchDeg = (st.pitch * 180) / Math.PI;
      const yOf = (deg: number): number => cy - Math.tan(((deg - pitchDeg) * Math.PI) / 180) * focal;
      // The horizon: a long line with the sight's gap, faded out in open space.
      const show = Math.max(0, Math.min(1, st.horizon));
      set(horizon, 'h.o', 'opacity', show.toFixed(2));
      const y0 = yOf(0);
      // Kept in the view's middle, clear of the bars at the top and the foot.
      set(level, 'h.v', 'visibility', Math.abs(y0 - cy) < h * 0.38 ? 'visible' : 'hidden');
      set(level, 'h.d', 'd', `M${(cx - 260).toFixed(1)} ${y0.toFixed(1)}H${(cx - 40).toFixed(1)}M${(cx + 40).toFixed(1)} ${y0.toFixed(1)}H${(cx + 260).toFixed(1)}`);
      for (const r of rungs) {
        const y = yOf(r.deg);
        // Only the rungs near the sight, within the view's middle third.
        const near = Math.abs(r.deg - pitchDeg) < 35 && Math.abs(y - cy) < h * 0.38;
        set(r.g, `r${r.deg}.v`, 'visibility', near ? 'visible' : 'hidden');
        if (!near) continue;
        const tick = r.deg > 0 ? 8 : -8;
        set(r.line, `r${r.deg}.d`, 'd', `M${(cx - 110).toFixed(1)} ${(y + tick).toFixed(1)}V${y.toFixed(1)}H${(cx - 50).toFixed(1)}M${(cx + 50).toFixed(1)} ${y.toFixed(1)}H${(cx + 110).toFixed(1)}V${(y + tick).toFixed(1)}`);
        set(r.label, `r${r.deg}.x`, 'x', (cx + 116).toFixed(1));
        set(r.label, `r${r.deg}.y`, 'y', y.toFixed(1));
      }
      // The boxes either side of the sight.
      const bx = Math.min(300, w * 0.24);
      set(left.g, 'l.t', 'transform', `translate(${(cx - bx - 108).toFixed(1)} ${(cy - 18).toFixed(1)})`);
      set(right.g, 'r.t', 'transform', `translate(${(cx + bx).toFixed(1)} ${(cy - 18).toFixed(1)})`);
      for (const [b, x] of [[left, '8'], [right, '100']] as const) {
        set(b.name, `${x}.nx`, 'x', x); set(b.name, `${x}.ny`, 'y', '13');
        set(b.value, `${x}.vx`, 'x', x); set(b.value, `${x}.vy`, 'y', '30');
      }
      set(left.name, 'l.n', '#text', t('flight.cockpit.speed'));
      set(right.name, 'r.n', '#text', t('flight.cockpit.height'));
      set(left.value, 'l.v', '#text', speedText(st.speed / st.unit));
      set(right.value, 'r.v', '#text', distance(st.height / st.unit));
      // The throttle under the speed: 1/32 .. 32 on a log scale, 1 in the middle.
      const share = (Math.log2(st.throttle) + 5) / 10;
      const tx = cx - bx - 108, ty = cy + 24;
      set(barTrack, 'b.x', 'x', tx.toFixed(1)); set(barTrack, 'b.y', 'y', ty.toFixed(1));
      set(bar, 'b2.x', 'x', tx.toFixed(1)); set(bar, 'b2.y', 'y', ty.toFixed(1));
      set(bar, 'b2.w', 'width', (108 * Math.max(0.02, Math.min(1, share))).toFixed(1));
      // The jump, named.
      set(jump, 'j.x', 'x', cx.toFixed(1)); set(jump, 'j.y', 'y', (cy - h * 0.22).toFixed(1));
      set(jump, 'j.o', 'opacity', Math.min(1, st.warp * 1.6).toFixed(2));
      set(jump, 'j.t', '#text', t('flight.cockpit.warp'));
    },
  };
}

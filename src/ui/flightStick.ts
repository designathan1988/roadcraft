/**
 * THE FLIGHT STICK ON SCREEN (`render/planet/flight.ts` FlightStick): the
 * ring round the sight where the mouse does nothing (the dead zone), and a
 * line from the sight to the cursor that brightens as the turn grows - the
 * stick's deflection seen, as space games draw their mouse's virtual stick.
 * One small SVG, written only when the cursor moves; nothing allocated after
 * it is made.
 */
export interface FlightStickView {
  /** The cursor at (x, y) CSS px; `deadZone` the dead zone over half the view's height. */
  show(x: number, y: number, deadZone: number): void;
  hide(): void;
  readonly element: SVGSVGElement;
}

const NS = 'http://www.w3.org/2000/svg';

export function mountFlightStick(parent: HTMLElement): FlightStickView {
  const svg = document.createElementNS(NS, 'svg');
  svg.id = 'flightStick';
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:29;pointer-events:none;overflow:visible';
  svg.style.display = 'none';
  const ring = document.createElementNS(NS, 'circle');
  ring.setAttribute('fill', 'none');
  ring.setAttribute('stroke', 'rgba(255,255,255,0.28)');
  ring.setAttribute('stroke-width', '1');
  ring.setAttribute('stroke-dasharray', '3 4');
  const line = document.createElementNS(NS, 'line');
  line.setAttribute('stroke-width', '1.5');
  line.setAttribute('stroke-linecap', 'round');
  const tip = document.createElementNS(NS, 'circle');
  tip.setAttribute('r', '5');
  tip.setAttribute('fill', 'none');
  tip.setAttribute('stroke-width', '1.5');
  svg.append(ring, line, tip);
  parent.appendChild(svg);
  return {
    element: svg,
    show(x, y, deadZone) {
      const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
      const half = window.innerHeight / 2;
      const d = Math.min(1, Math.hypot(x - cx, y - cy) / half);
      const live = d > deadZone;
      ring.setAttribute('cx', String(cx));
      ring.setAttribute('cy', String(cy));
      ring.setAttribute('r', String(Math.max(4, deadZone * half)));
      // The line only out of the dead zone, brighter the harder it turns.
      const a = live ? 0.35 + 0.55 * Math.min(1, (d - deadZone) / (1 - deadZone)) : 0;
      const colour = `rgba(120,230,210,${a.toFixed(2)})`;
      line.setAttribute('x1', String(cx));
      line.setAttribute('y1', String(cy));
      line.setAttribute('x2', String(x));
      line.setAttribute('y2', String(y));
      line.setAttribute('stroke', colour);
      tip.setAttribute('cx', String(x));
      tip.setAttribute('cy', String(y));
      tip.setAttribute('stroke', live ? colour : 'rgba(255,255,255,0.45)');
      svg.style.display = '';
    },
    hide() {
      svg.style.display = 'none';
    },
  };
}

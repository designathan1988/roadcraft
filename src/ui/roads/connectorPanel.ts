import type { NodeId, SegmentId } from '@world/ids';
import { type LaneEnds, type LaneLink, linkKey, toggleLaneLink } from '@world/roads/connectors';
import { t } from '../i18n';
import './roads.css';

/** THE LANE CONNECTOR EDITOR of a junction, in the inspector */
export interface ConnectorPanelHost {
  /** The junction's lanes and their ends, as the simulation's worker last told them (null before the first). */
  readonly lanes: () => LaneEnds | null;
  readonly links: () => readonly LaneLink[] | undefined;
  readonly set: (links: LaneLink[] | undefined) => void;
  /** World to screen, so the plan is turned as the player sees the junction (screen y down). */
  readonly project?: (x: number, y: number) => { readonly x: number; readonly y: number };
}

interface Picked { readonly segment: SegmentId; readonly lane: number }

let open: { node: NodeId; host: ConnectorPanelHost; root: HTMLElement; drawn: string } | null = null;
let picked: { node: NodeId; lane: Picked } | null = null;
/** The lane end the keyboard is on: kept past a rebuild of the inspector (its panel made again, the old one's focus gone with it), let go when the player goes elsewhere. */
let keyboard: { node: NodeId; end: string } | null = null;

export function mountConnectorPanel(container: HTMLElement, node: NodeId, host: ConnectorPanelHost): void {
  const root = document.createElement('section');
  root.className = 'rp-summary rp-connectors';
  container.append(root);
  open = { node, host, root, drawn: '' };
  if (picked?.node !== node) picked = null;
  draw();
}

/** Redraws the open panel when the lane graph or the node's links changed. */
export function refreshConnectorPanel(): void {
  if (open && !open.root.isConnected) { open = null; return; }
  draw();
}

function draw(): void {
  if (!open) return;
  const { node, host, root } = open;
  const lanes = host.lanes();
  const links = host.links();
  // A lane picked before an undo or a rebuild that took it away is no longer picked.
  if (picked && (picked.node !== node || !lanes?.ends.some((e) => e.arriving && e.segment === picked!.lane.segment && e.lane === picked!.lane.lane))) picked = null;
  // In screen terms (y down): through the camera when the host gives it, else north up.
  const view = (p: { x: number; y: number }): { x: number; y: number } => host.project ? host.project(p.x, p.y) : { x: p.x, y: -p.y };
  const stamp = `${lanes?.revision ?? -1}|${lanes ? lanes.built.map(linkKey).join(',') : '-'}|${links?.map(linkKey).join(',') ?? ''}|${picked ? `${picked.lane.segment}:${picked.lane.lane}` : ''}|${lanes ? turnOf(view, lanes) : ''}`;
  if (stamp === open.drawn) return;
  open.drawn = stamp;
  // The end the keyboard was on keeps the focus through the redraw, and through the inspector made again (the focus then on nothing).
  const active = document.activeElement;
  const lost = !active || active === document.body;
  const focused = root.contains(active) ? active?.getAttribute('data-end') ?? null
    : lost && keyboard?.node === node ? keyboard.end : null;
  root.replaceChildren();
  const head = document.createElement('div');
  head.className = 'rp-summary-head';
  const title = document.createElement('span');
  title.textContent = t('connectors.title');
  const state = document.createElement('span');
  state.className = 'rp-sub';
  state.textContent = links?.length ? t('connectors.custom') : t('connectors.auto');
  head.append(title, state);
  root.append(head);
  if (!lanes || !lanes.arriving.length || !lanes.leaving.length) {
    const none = document.createElement('div');
    none.className = 'rp-sub';
    none.textContent = t('connectors.none');
    root.append(none);
    return;
  }

  // The plan: every lane end in world coordinates, fitted to the picture.
  const ends = new Map<string, { x: number; y: number; dx: number; dy: number }>();
  const keyOf = (segment: SegmentId, lane: number, arriving: boolean): string => `${arriving ? 'a' : 'l'}${segment}:${lane}`;
  for (const end of lanes.ends) {
    const p = view(end.at), q = view(end.next);
    ends.set(keyOf(end.segment, end.lane, end.arriving), end.arriving
      ? { x: p.x, y: p.y, dx: p.x - q.x, dy: p.y - q.y } : { x: p.x, y: p.y, dx: q.x - p.x, dy: q.y - p.y });
  }
  const all = [...ends.values()];
  const minX = Math.min(...all.map((e) => e.x)), maxX = Math.max(...all.map((e) => e.x));
  const minY = Math.min(...all.map((e) => e.y)), maxY = Math.max(...all.map((e) => e.y));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const W = 300, H = 220, pad = 34;
  const scale = Math.min((W - pad * 2) / Math.max(1, maxX - minX), (H - pad * 2) / Math.max(1, maxY - minY));
  const at = (x: number, y: number): [number, number] => [W / 2 + (x - cx) * scale, H / 2 + (y - cy) * scale];
  const parts: string[] = [];
  const stub = 22;
  for (const [key, e] of ends) {
    const len = Math.hypot(e.dx, e.dy) || 1;
    const [x, y] = at(e.x, e.y);
    const arriving = key.startsWith('a');
    const sx = x - (e.dx / len) * stub * (arriving ? 1 : -1), sy = y - (e.dy / len) * stub * (arriving ? 1 : -1);
    parts.push(`<line x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="cn-stub"/>`);
  }
  const lit = picked && picked.node === node ? picked.lane : null;
  for (const link of lanes.built) {
    const a = ends.get(keyOf(link.from, link.fromLane, true)), b = ends.get(keyOf(link.to, link.toLane, false));
    if (!a || !b) continue;
    const [x0, y0] = at(a.x, a.y), [x1, y1] = at(b.x, b.y);
    const [mx, my] = at(cx, cy);
    const on = lit && lit.segment === link.from && lit.lane === link.fromLane;
    parts.push(`<path d="M${x0.toFixed(1)} ${y0.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}" class="cn-link${on ? ' on' : lit ? ' dim' : ''}"/>`);
  }
  for (const [key, e] of ends) {
    const [x, y] = at(e.x, e.y);
    const arriving = key.startsWith('a');
    const [segment, lane] = key.slice(1).split(':').map(Number) as [number, number];
    const on = arriving && lit?.segment === segment && lit.lane === lane;
    const linked = !arriving && lit && lanes.built.some((l) => l.from === lit.segment && l.fromLane === lit.lane && l.to === segment && l.toLane === lane);
    parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" class="cn-end ${arriving ? 'in' : 'out'}${on || linked ? ' on' : ''}" data-end="${key}" role="button" tabindex="0"/>`);
  }
  const art = document.createElement('div');
  art.className = 'rp-summary-art cn-art';
  art.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${t('connectors.title')}">${parts.join('')}</svg>`;
  const press = (end: string): void => {
    if (!open) return;
    const [segment, lane] = end.slice(1).split(':').map(Number) as [number, number];
    if (end.startsWith('a')) {
      picked = lit && lit.segment === segment && lit.lane === lane ? null : { node, lane: { segment: segment as SegmentId, lane } };
      draw();
      return;
    }
    if (!lit) return;
    const next = toggleLaneLink(host.links(), lanes, { from: lit.segment, fromLane: lit.lane, to: segment as SegmentId, toLane: lane });
    if (next === null) { hint.textContent = t('connectors.lastExit'); return; }
    host.set(next);
  };
  art.addEventListener('click', (event) => {
    const end = (event.target as Element).closest('[data-end]')?.getAttribute('data-end');
    if (end) press(end);
  });
  // The ends are buttons: Enter and Space press them as a click does.
  art.addEventListener('focusin', (event) => {
    const end = (event.target as Element).closest('[data-end]')?.getAttribute('data-end');
    if (end) keyboard = { node, end };
  });
  // Focus taken to another control, or a press outside the plan: the keyboard is no longer on it.
  art.addEventListener('focusout', (event) => { if (event.relatedTarget instanceof Element && !art.contains(event.relatedTarget)) keyboard = null; });
  art.addEventListener('pointerdown', () => { keyboard = null; });
  art.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const end = (event.target as Element).closest('[data-end]')?.getAttribute('data-end');
    if (!end) return;
    event.preventDefault();
    press(end);
  });
  root.append(art);
  if (focused) art.querySelector<SVGElement>(`[data-end="${focused}"]`)?.focus();
  const hint = document.createElement('div');
  hint.className = 'rp-sub';
  hint.setAttribute('role', 'status');
  hint.textContent = lit ? t('connectors.pickOut') : t('connectors.pickIn');
  root.append(hint);
  if (links?.length) {
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'rp-btn';
    reset.dataset['action'] = 'resetConnectors';
    reset.textContent = t('connectors.reset');
    reset.onclick = () => { picked = null; host.set(undefined); };
    root.append(reset);
  }
}

/** How the camera turns the junction: the screen direction of the world's x and y axes at its first lane end. */
function turnOf(view: (p: { x: number; y: number }) => { x: number; y: number }, lanes: LaneEnds): string {
  const at = lanes.ends[0]?.at;
  if (!at) return '';
  const o = view(at), ex = view({ x: at.x + 1, y: at.y }), ey = view({ x: at.x, y: at.y + 1 });
  const dir = (p: { x: number; y: number }): string => (Math.round(Math.atan2(p.y - o.y, p.x - o.x) * 100) / 100).toString();
  return `${dir(ex)},${dir(ey)}`;
}

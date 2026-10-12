import type { NodeId, SegmentId } from '@world/ids';
import { movementKey, type JunctionControl, type RoadDoc } from '@world/doc';
import { type ApproachRule, type ApproachRuleEntry, GREEN_LIMITS, OFFSET_LIMIT, type SignalSettings, legRule, mainRoadLegs } from '@world/roads/rules';
import { UNITS_PER_METER } from '@world/units';
import type { SimWorld } from '@sim/world';
import { greenWave } from '@sim/roads/greenWave';
import { formatDecimal, t } from '../i18n';
import './roads.css';

/**
 * THE JUNCTION PANEL (docs/VIAS.md V5), in the inspector: the junction's
 * height, its control as buttons (automatic, signal, signs on each leg, a
 * stop on every leg, mini-roundabout, nothing signed - the CTB's own rule),
 * what "automatic" chose from the measured flows and the flows themselves, the
 * lock a choice of the player's puts on it and the way back to automatic,
 * each leg's rule, the signal's timing (adaptive or fixed, each stage's green,
 * the offset, the green wave along the main road, bus priority) and the
 * movements allowed. The interface's own controls throughout: no select, no
 * number box, no checkbox (the player's order on the profile editor, V2).
 */
export interface JunctionPanelHost {
  readonly doc: RoadDoc;
  readonly sim: SimWorld;
  readonly node: NodeId;
  setHeight(metres: number): void;
  setControl(control: JunctionControl): void;
  setRules(rules: ApproachRuleEntry[] | undefined): void;
  setSignal(settings: SignalSettings | undefined): void;
  setSignals(settings: ReadonlyMap<NodeId, SignalSettings>): void;
  setMovementBlocked(from: SegmentId, to: SegmentId, blocked: boolean): void;
  /** World to screen, so legs are named as the player sees them. */
  readonly project?: (x: number, y: number) => { readonly x: number; readonly y: number };
}

const CONTROLS: readonly JunctionControl[] = ['auto', 'signal', 'priority', 'stop', 'mini', 'none'];
const RULES: readonly ApproachRule[] = ['priority', 'yield', 'stop'];

/**
 * The way a leg points from its junction AS THE PLAYER SEES IT (up, down,
 * left, right on the screen), through the camera when the host gives it;
 * by the map's north otherwise. By the map's north, a road running across
 * the screen read "south-west" whenever the camera was turned (seen on V5's
 * photos).
 */
let screenOf: ((x: number, y: number) => { readonly x: number; readonly y: number }) | undefined;
export function compassOf(doc: RoadDoc, nodeId: NodeId, seg: { a: NodeId; b: NodeId }): string {
  const here = doc.node(nodeId);
  const there = doc.node(seg.a === nodeId ? seg.b : seg.a);
  if (!here || !there) return '?';
  if (screenOf) {
    const a = screenOf(here.x, here.y), b = screenOf(there.x, there.y);
    // Screen y grows down: 0 is up, clockwise.
    const angle = Math.atan2(b.x - a.x, -(b.y - a.y));
    const names = ['up', 'upRight', 'right', 'downRight', 'down', 'downLeft', 'left', 'upLeft'] as const;
    const i = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
    return t(`screenDir.${names[i]}`);
  }
  const angle = Math.atan2(there.x - here.x, there.y - here.y);
  const points = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
  const i = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
  return t(`compass.${points[i]}`);
}

let flowsShown: HTMLElement | null = null;

export function mountJunctionPanel(container: HTMLElement, host: JunctionPanelHost): void {
  const { doc, sim, node } = host;
  screenOf = host.project;
  const n = doc.node(node);
  if (!n) return;
  const root = document.createElement('section');
  root.className = 'rp-junction';
  const junction = n.incident.length >= 3;

  // The height of the road at the node.
  const metres = n.heightOffset / UNITS_PER_METER;
  root.append(row(t('inspector.heightNode'), stepper(`${fmt(metres)} m`,
    () => host.setHeight(Math.round((metres - 0.5) * 2) / 2), () => host.setHeight(Math.round((metres + 0.5) * 2) / 2),
    t('junction.lower'), t('junction.raise'))));
  if (!junction) { container.append(root); return; }

  // The control.
  const controls = n.control === 'yield' ? [...CONTROLS, 'yield' as const] : CONTROLS;
  const block = div('rp-block');
  block.append(head(t('junction.control')));
  const seg = segmented(controls, n.control, (c) => t(`junction.control.${c}`), (c) => host.setControl(c), 'dense');
  seg.dataset['role'] = 'junctionControl';
  block.append(seg);
  const signalised = sim.graph.junctions.get(node)?.signalised === true;
  if (n.control === 'auto') {
    const choice = sim.advisor.choice(node) ?? (signalised ? 'signal' : 'priority');
    const note = div('rp-note');
    note.dataset['role'] = 'autoChoice';
    note.textContent = t('junction.autoChoice', { choice: t(`junction.auto.${choice}`) });
    block.append(note);
  } else {
    const lock = div('rp-lock');
    const text = document.createElement('span');
    text.textContent = t('junction.locked');
    const unlock = button(t('junction.unlock'), () => host.setControl('auto'));
    unlock.dataset['action'] = 'unlock';
    lock.append(text, unlock);
    block.append(lock);
  }
  // The flows, as the trend the choice is made from.
  const flows = div('rp-flows');
  flows.dataset['role'] = 'flows';
  const main = mainRoadLegs(doc, node);
  for (const id of n.incident) {
    const segment = doc.segment(id);
    if (!segment) continue;
    const r = div('rp-flow');
    const name = document.createElement('span');
    name.textContent = `${compassOf(doc, node, segment)}${main?.includes(id) ? ` · ${t('junction.mainRoad')}` : ''}`;
    const value = document.createElement('strong');
    value.textContent = t('junction.perHour', { n: Math.round(sim.flow.rate(node, id)) });
    r.append(name, value);
    flows.append(r);
  }
  block.append(flows);
  flowsShown = flows;
  root.append(block);

  // Each leg's rule, under signs.
  if (n.control === 'priority') {
    const legs = div('rp-block');
    legs.append(head(t('junction.legs')));
    for (const id of n.incident) {
      const segment = doc.segment(id);
      if (!segment) continue;
      const rule = legRule(doc, n, id);
      legs.append(row(compassOf(doc, node, segment), segmented(RULES, rule, (r) => t(`junction.rule.${r}`), (r) => {
        const others = (n.approachRules ?? []).filter((e) => e.segment !== id);
        host.setRules([...others, { segment: id, rule: r }]);
      }, 'dense')));
    }
    if (n.approachRules?.length) {
      const reset = button(t('junction.rulesReset'), () => host.setRules(undefined));
      legs.append(reset);
    }
    root.append(legs);
  }

  // The signal's timing.
  const ctl = sim.controllers.get(node);
  if (signalised && ctl) {
    const s = n.signal;
    const block2 = div('rp-block');
    block2.append(head(t('junction.signal')));
    block2.append(row(t('junction.signalMode'), segmented(['adaptive', 'fixed'] as const, s?.mode === 'fixed' ? 'fixed' : 'adaptive',
      (m) => t(`junction.mode.${m}`), (m) => host.setSignal(m === 'fixed'
        ? { ...s, mode: 'fixed', greens: ctl.plan.stages.map((st) => Math.round(st.targetGreen)) }
        : withoutFixed(s)))));
    if (s?.mode === 'fixed') {
      ctl.plan.stages.forEach((st, i) => {
        const green = s.greens?.[i] ?? Math.round(st.targetGreen);
        const set = (g: number): void => {
          const greens = ctl.plan.stages.map((x, k) => s.greens?.[k] ?? Math.round(x.targetGreen));
          greens[i] = Math.max(GREEN_LIMITS[0], Math.min(GREEN_LIMITS[1], g));
          host.setSignal({ ...s, greens });
        };
        block2.append(row(t('junction.stage', { n: i + 1 }), stepper(`${green} s`, () => set(green - 2), () => set(green + 2),
          t('junction.shorter'), t('junction.longer'))));
      });
      const offset = s.offset ?? 0;
      block2.append(row(t('junction.offset'), stepper(`${offset} s`,
        () => host.setSignal({ ...s, offset: Math.max(0, offset - 2) }), () => host.setSignal({ ...s, offset: Math.min(OFFSET_LIMIT, offset + 2) }),
        t('junction.earlier'), t('junction.later'))));
    }
    const wave = button(t('junction.greenWave'), () => {
      const plan = greenWave(sim, node);
      if (plan.size) host.setSignals(plan);
      else waveNote.textContent = t('junction.greenWaveNone');
    });
    wave.dataset['action'] = 'greenWave';
    const waveNote = div('rp-note');
    block2.append(wave, waveNote);
    block2.append(toggle(t('junction.busPriority'), s?.busPriority === true, (on) => {
      const { busPriority: _b, ...rest } = s ?? {}; void _b;
      host.setSignal(on ? { ...rest, busPriority: true } : rest);
    }));
    root.append(block2);
  }

  // The movements allowed through it, a row per road they come from, each turn a chip.
  const moves = div('rp-block');
  moves.append(head(t('junction.movements')));
  const list = div('rp-moves');
  const byLeg = new Map<SegmentId, { to: SegmentId; turn: string | null; blocked: boolean }[]>();
  const seen = new Set<string>();
  const junctionTopo = sim.graph.junctions.get(node);
  for (const id of junctionTopo?.connectors ?? []) {
    const c = sim.connector(id);
    if (!c) continue;
    const key = movementKey(c.inSegment, c.outSegment);
    if (seen.has(key)) continue;
    seen.add(key);
    const row = byLeg.get(c.inSegment) ?? [];
    row.push({ to: c.outSegment, turn: c.turn, blocked: false });
    byLeg.set(c.inSegment, row);
  }
  for (const key of n.blockedMovements) {
    if (seen.has(key)) continue;
    const [from, to] = key.split('>').map(Number) as [number, number];
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    const row = byLeg.get(from as SegmentId) ?? [];
    row.push({ to: to as SegmentId, turn: null, blocked: true });
    byLeg.set(from as SegmentId, row);
  }
  for (const [from, row] of byLeg) {
    const segment = doc.segment(from);
    const chips = div('rp-ctrls');
    for (const m of row) chips.append(moveChip(host, from, m.to, m.blocked, m.turn));
    list.append(rowOf(segment ? t('junction.from', { leg: compassOf(doc, node, segment) }) : String(from), chips));
  }
  moves.append(list);
  root.append(moves);
  container.append(root);
}

/** Rewrites the flows in place (the inspector's refresh), without rebuilding the panel. */
export function refreshJunctionFlows(sim: SimWorld, doc: RoadDoc, node: NodeId): void {
  if (!flowsShown?.isConnected) return;
  const n = doc.node(node);
  if (!n) return;
  const values = flowsShown.querySelectorAll('strong');
  n.incident.forEach((id, i) => {
    const el = values[i];
    if (el) el.textContent = t('junction.perHour', { n: Math.round(sim.flow.rate(node, id)) });
  });
}

function moveChip(host: JunctionPanelHost, from: SegmentId, to: SegmentId, blocked: boolean, turn: string | null): HTMLButtonElement {
  const b = host.doc.segment(to);
  // By the turn when the movement exists; a banned one has no turn left to name, so by where it goes.
  const label = turn ? t(`turn.${turn}`) : b ? `→ ${compassOf(host.doc, host.node, b)}` : `→ ${to}`;
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = `rp-move${blocked ? '' : ' on'}`;
  chip.setAttribute('aria-pressed', String(!blocked));
  chip.dataset['move'] = movementKey(from, to);
  chip.textContent = label;
  chip.title = t(blocked ? 'junction.moveBlocked' : 'junction.moveAllowed');
  chip.onclick = () => host.setMovementBlocked(from, to, !blocked);
  return chip;
}

function withoutFixed(s: SignalSettings | undefined): SignalSettings | undefined {
  if (!s) return undefined;
  const { mode: _m, greens: _g, offset: _o, ...rest } = s; void _m; void _g; void _o;
  return Object.keys(rest).length ? rest : undefined;
}

const fmt = (v: number): string => (Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : formatDecimal(v, 1));

function div(className: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  return d;
}

function head(text: string): HTMLDivElement {
  const h = div('rp-block-head');
  h.textContent = text;
  return h;
}

const rowOf = (label: string, controls: HTMLElement): HTMLDivElement => row(label, controls);

function row(label: string, ...controls: HTMLElement[]): HTMLDivElement {
  const r = div('rp-row');
  const l = div('rp-label');
  l.textContent = label;
  const c = div('rp-ctrls');
  c.append(...controls);
  r.append(l, c);
  return r;
}

function button(label: string, run: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'rp-btn';
  b.textContent = label;
  b.onclick = run;
  return b;
}

function segmented<T extends string>(values: readonly T[], value: T, label: (v: T) => string, change: (v: T) => void, kind = ''): HTMLDivElement {
  const box = div(`rp-seg${kind ? ` ${kind}` : ''}`);
  box.setAttribute('role', 'radiogroup');
  for (const v of values) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(v === value));
    b.dataset['value'] = v;
    if (v === value) b.classList.add('on');
    b.textContent = label(v);
    b.onclick = () => { if (v !== value) change(v); };
    box.append(b);
  }
  return box;
}

function stepper(value: string, less: () => void, more: () => void, lessLabel: string, moreLabel: string): HTMLDivElement {
  const box = div('rp-step');
  const minus = document.createElement('button');
  minus.type = 'button';
  minus.textContent = '−';
  minus.setAttribute('aria-label', lessLabel);
  minus.onclick = less;
  const out = document.createElement('output');
  out.textContent = value;
  const plus = document.createElement('button');
  plus.type = 'button';
  plus.textContent = '+';
  plus.setAttribute('aria-label', moreLabel);
  plus.onclick = more;
  box.append(minus, out, plus);
  return box;
}

function toggle(label: string, on: boolean, change: (on: boolean) => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'rp-switch';
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-checked', String(on));
  b.innerHTML = '<span class="track"><span class="knob"></span></span><span class="txt"></span>';
  b.querySelector('.txt')!.textContent = label;
  b.onclick = () => change(!on);
  return b;
}

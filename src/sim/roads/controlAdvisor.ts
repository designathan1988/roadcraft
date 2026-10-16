import type { NodeId } from '@world/ids';
import { ROAD_TUNING } from '@world/roads/tuning';

/** THE CONTROL A JUNCTION LEFT ON "AUTOMATIC" GETS: chosen from the measured trend of its flows */
export type AutoControl = 'signal' | 'stop' | 'priority';

const F = ROAD_TUNING.flow;

/** The control a junction's flows warrant, given what it has now (hysteresis). */
export function warrantedControl(major: number, minorMax: number, minorTotal: number, current: AutoControl): AutoControl {
  const k = (step: AutoControl): number => (rank(current) >= rank(step) ? F.stepDown : 1);
  const signal = (major >= F.signalMajor * k('signal') && minorMax >= F.signalMinor * k('signal')) ||
    (major >= F.signalMajorB * k('signal') && minorMax >= F.signalMinorB * k('signal'));
  if (signal) return 'signal';
  const stop = major >= F.stopMajor * k('stop') && minorTotal >= F.stopMinor * k('stop');
  return stop ? 'stop' : 'priority';
}

const rank = (c: AutoControl): number => (c === 'signal' ? 2 : c === 'stop' ? 1 : 0);

/** Vehicles an hour into a junction below which `warrantedControl` is 'priority' whatever it has now (the least major flow of a step up, with the hysteresis). */
export const QUIET_FLOW = Math.min(F.stopMajor, F.signalMajor, F.signalMajorB) * Math.min(1, F.stepDown);

export class ControlAdvisor {
  readonly choices = new Map<NodeId, AutoControl>();
  private readonly changedAt = new Map<NodeId, number>();
  /** Seconds between evaluations. */
  static readonly EVERY = 10;
  private since = 0;

  /** The control chosen for `node`, or undefined before the advisor has spoken (the game's geometric default holds). */
  choice(node: NodeId): AutoControl | undefined {
    return this.choices.get(node);
  }

  /** Whether it is time to evaluate again. */
  tick(dt: number): boolean {
    this.since += dt;
    if (this.since < ControlAdvisor.EVERY) return false;
    this.since = 0;
    return true;
  }

  /** One junction's evaluation; returns true when its choice changed. */
  evaluate(node: NodeId, major: number, minorMax: number, minorTotal: number, initial: AutoControl, now: number): boolean {
    const current = this.choices.get(node) ?? initial;
    if (!this.choices.has(node)) this.choices.set(node, initial);
    if (now < F.trendWindow) return false;
    if (now - (this.changedAt.get(node) ?? -Infinity) < F.trendWindow) return false;
    const next = warrantedControl(major, minorMax, minorTotal, current);
    if (next === current) return false;
    this.choices.set(node, next);
    this.changedAt.set(node, now);
    return true;
  }

  forget(nodes: ReadonlySet<NodeId>): void {
    for (const node of [...this.choices.keys()]) if (!nodes.has(node)) { this.choices.delete(node); this.changedAt.delete(node); }
  }

  /** These junctions' choices forgotten (gone with an edit). */
  drop(nodes: ReadonlySet<NodeId>): void {
    for (const node of nodes) { this.choices.delete(node); this.changedAt.delete(node); }
  }
}

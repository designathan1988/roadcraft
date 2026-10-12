import type { NodeId } from '@world/ids';
import { ROAD_TUNING } from '@world/roads/tuning';

/**
 * THE CONTROL A JUNCTION LEFT ON "AUTOMATIC" GETS (docs/VIAS.md V5): chosen
 * from the measured trend of its flows (`flowStats.ts`), stepping up from
 * "give way on the minor road" to a stop on every leg to a signal, and back
 * down, the way the volume warrants of the MUTCD set them (2009, sec. 2B.07,
 * multi-way stop: 300 vehicles an hour on the major road and 200 units on the
 * minor one; sec. 4C.02, Warrant 1 (eight-hour volume), one lane each way:
 * 500 and 150, or 750 and 75). Every threshold is held for the measuring
 * window before it counts, steps down only under 80 % of it, and a junction
 * changes at most once a window: by trend, never by a peak (the player's
 * decision of 2026-10-09). A player's own choice locks the junction; this is
 * asked only while its control is "auto".
 */
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

  /**
   * One junction's evaluation; returns true when its choice changed. `now`
   * is the seconds of traffic measured; nothing changes before a whole
   * window of it.
   */
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
}

/** A STATECHART WITH THE SEMANTICS OF W3C SCXML, for the game's tools and modes */

export interface MachineEvent { readonly type: string }

export interface Transition<C, E extends MachineEvent> {
  /** The state to go to; a function of the event when it carries the target. Omitted: a transition that stays (actions only). */
  readonly target?: string | ((event: E, ctx: C) => string);
  readonly guard?: (event: E, ctx: C) => boolean;
  readonly actions?: (event: E, ctx: C) => void;
}

export interface StateSpec<C, E extends MachineEvent> {
  /** The state this one is inside; omitted: at the top. */
  readonly parent?: string;
  /** Entering this state goes on into this child. */
  readonly initial?: string;
  readonly on?: { readonly [type: string]: readonly Transition<C, E>[] };
  readonly entry?: (event: E | null, ctx: C) => void;
  readonly exit?: (event: E, ctx: C) => void;
}

export interface TransitionRecord {
  readonly serial: number;
  readonly from: string;
  readonly event: string;
  readonly to: string;
  readonly at: number;
}

const KEPT = 256;

export class Machine<C, E extends MachineEvent> {
  private current: string;
  private readonly queue: E[] = [];
  private processing = false;
  private serial = 0;
  private readonly ring: TransitionRecord[] = [];

  constructor(
    readonly name: string,
    private readonly states: { readonly [id: string]: StateSpec<C, E> },
    initial: string,
    private readonly ctx: C,
    private readonly now: () => number = () => performance.now(),
  ) {
    for (const [id, s] of Object.entries(states)) {
      if (s.parent !== undefined && !(s.parent in states)) throw new Error(`${name}: state ${id} has an unknown parent ${s.parent}`);
    }
    this.current = this.descend(initial);
    for (const id of this.path(this.current).reverse()) this.states[id]!.entry?.(null, ctx);
  }

  /** The active (innermost) state. */
  get state(): string {
    return this.current;
  }

  /** Whether `id` is the active state or one of its parents. */
  in(id: string): boolean {
    return this.path(this.current).includes(id);
  }

  /** Sends an event; returns when it, and every event it caused, has been processed. */
  send(event: E): void {
    this.queue.push(event);
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length) this.step(this.queue.shift()!);
    } finally {
      this.processing = false;
    }
  }

  /** The last `n` transitions, newest first. */
  latest(n: number): TransitionRecord[] {
    return this.ring.slice(-n).reverse();
  }

  private step(event: E): void {
    for (const id of this.path(this.current)) {
      const list = this.states[id]!.on?.[event.type];
      if (!list) continue;
      for (const t of list) {
        if (t.guard && !t.guard(event, this.ctx)) continue;
        this.take(event, t, id);
        return;
      }
    }
  }

  /** DO NOT take the shared part of the active leaf's and the target's paths as the domain */
  private take(event: E, t: Transition<C, E>, source: string): void {
    const from = this.current;
    if (t.target === undefined) {
      t.actions?.(event, this.ctx);
      this.record(from, event.type, from);
      return;
    }
    const raw = typeof t.target === 'function' ? t.target(event, this.ctx) : t.target;
    if (!(raw in this.states)) throw new Error(`${this.name}: no state ${raw} (event ${event.type})`);
    const target = this.descend(raw);
    const aboveTarget = this.path(raw).slice(1);
    const domain = this.path(source).slice(1).find((s) => aboveTarget.includes(s));
    for (const id of this.path(from)) {
      if (id === domain) break;
      this.states[id]!.exit?.(event, this.ctx);
    }
    t.actions?.(event, this.ctx);
    this.current = target;
    const entered = this.path(target);
    const enter = entered.slice(0, domain === undefined ? entered.length : entered.indexOf(domain)).reverse();
    for (const id of enter) this.states[id]!.entry?.(event, this.ctx);
    this.record(from, event.type, target);
  }

  private record(from: string, event: string, to: string): void {
    this.ring.push({ serial: ++this.serial, from, event, to, at: this.now() });
    if (this.ring.length > KEPT) this.ring.shift();
  }

  /** `id`, then its parents up to the top. */
  private path(id: string): string[] {
    const out: string[] = [];
    for (let s: string | undefined = id; s !== undefined; s = this.states[s]!.parent) out.push(s);
    return out;
  }

  /** `id`, or its initial child, all the way down. */
  private descend(id: string): string {
    let s = id;
    for (let guard = 0; this.states[s]!.initial !== undefined; guard++) {
      if (guard > 64) throw new Error(`${this.name}: initial states loop at ${id}`);
      s = this.states[s]!.initial!;
    }
    return s;
  }
}

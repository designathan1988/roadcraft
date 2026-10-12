/**
 * THE GAME'S STATE: what the player has in hand and how the game runs - the
 * tool, the pause and speed, the quality, the selection - owned in one place,
 * and every change of it written down: what changed, from what to what, and
 * why (the player, 2026-10-08: "o jogo precisa ter um controlador global de
 * estados, eventos"). Before it these were loose variables of `main.ts`,
 * written from some thirty places with no record.
 *
 * The world's own changes are in the document's diary (`world/changes.ts`).
 * This one is apart on purpose: an entry here has no place on the map, and a
 * reader of the diary takes an entry with no place as the whole map changed;
 * and the interface changes far more often than the world, which would push
 * the world's entries out of the diary's ring.
 *
 * An entry is an event - what already happened, its values captured when it
 * is written - in a ring of fixed size (Nystrom, "Event Queue"). `set` is
 * the one way in, and a value set to what it already is writes nothing;
 * `values` is a read-only view, so there is no second copy to drift.
 *
 * Whoever reacts to a change `watch`es its keys. Nobody is called inside
 * `set`: `flush` runs once in a microtask after the code that changed the
 * state (MDN `queueMicrotask`: after the current task, before the browser
 * renders), so a click's changes are told together, and the frame calls it
 * too. Each watcher gets the changes of its keys since the serial it last
 * saw (Nystrom, "Event Queue": decouple when an event is sent from when it
 * is processed; "Observer": a watcher that changes state while being told of
 * a change starts a loop, so what it sets is told in the next flush). It is
 * not tied to frames: a hidden page draws none and its panels still follow.
 * A watcher that throws does not stop the others: its error is thrown again
 * on its own, where the page's error handler sees it. `watch` returns the way
 * out, so a panel that goes away stops being told (the lapsed listener).
 *
 * Pure: no three, no DOM.
 */

export interface StateChange<V> {
  /** Order of writing; every entry has its own. */
  readonly serial: number;
  readonly key: keyof V & string;
  readonly from: unknown;
  readonly to: unknown;
  /** Why: the gesture or control that changed it. */
  readonly cause: string;
  /** When (`performance.now()`). */
  readonly at: number;
}

/** How many changes are kept; a reader older than that takes everything as changed. */
const KEPT = 512;

/** A watcher: its keys, the serial it has seen, and what it does. */
interface Watcher<V> {
  readonly keys: ReadonlySet<keyof V & string>;
  seen: number;
  /** The changes of its keys since it was last told, oldest first; `null` when some were forgotten. */
  readonly fn: (changes: StateChange<V>[] | null) => void;
}

export class GameState<V extends object> {
  private readonly current: V;
  private serial = 0;
  private readonly ring: (StateChange<V> | undefined)[] = new Array<StateChange<V> | undefined>(KEPT);
  private count = 0;
  private readonly watchers: Watcher<V>[] = [];
  private flushing = false;
  /** A flush is queued as a microtask. */
  private scheduled = false;

  /** `wake` is asked for a frame whenever something changes, so the next `flush` comes. */
  constructor(initial: V, private readonly wake: () => void = () => {}) {
    this.current = { ...initial };
  }

  /** Every value as it is now, read-only: the one copy there is. Writes go through `set`. */
  get values(): Readonly<V> {
    return this.current;
  }

  get<K extends keyof V>(key: K): V[K] {
    return this.current[key];
  }

  /** Sets a value and writes the change down; false (nothing written) when it already was that. */
  set<K extends keyof V & string>(key: K, value: V[K], cause: string): boolean {
    const from = this.current[key];
    if (Object.is(from, value)) return false;
    this.current[key] = value;
    const serial = ++this.serial;
    this.ring[serial % KEPT] = { serial, key, from, to: value, cause, at: performance.now() };
    if (this.count < KEPT) this.count++;
    this.schedule();
    return true;
  }

  /** Queues one flush after the code running now, and asks for a frame. */
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.flush();
    });
    this.wake();
  }

  /**
   * Tells `fn`, at every `flush`, the changes of `keys` it has not seen.
   * Starts having seen everything; returns the function that stops it.
   */
  watch(keys: readonly (keyof V & string)[], fn: (changes: StateChange<V>[] | null) => void): () => void {
    const watcher: Watcher<V> = { keys: new Set(keys), seen: this.serial, fn };
    this.watchers.push(watcher);
    return () => {
      const at = this.watchers.indexOf(watcher);
      if (at >= 0) this.watchers.splice(at, 1);
    };
  }

  /**
   * Tells every watcher what changed of its keys since it was last told, once,
   * up to the serial the flush started at: what a watcher sets meanwhile is
   * told in the next flush, never inside this one. Called once a frame.
   */
  flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    const upTo = this.serial;
    try {
      for (const watcher of [...this.watchers]) {
        if (watcher.seen >= upTo) continue;
        const changes = this.between(watcher.seen, upTo, watcher.keys);
        watcher.seen = upTo;
        if (changes === null || changes.length > 0) {
          try {
            watcher.fn(changes);
          } catch (error) {
            queueMicrotask(() => { throw error; });
          }
        }
      }
    } finally {
      this.flushing = false;
    }
    if (this.serial > upTo) this.schedule();
  }

  /** The changes after `since` up to `upTo`, of `keys` only when given; `null` if some were forgotten. */
  private between(since: number, upTo: number, keys?: ReadonlySet<keyof V & string>): StateChange<V>[] | null {
    if (since < this.serial - this.count) return null;
    const out: StateChange<V>[] = [];
    for (let s = since + 1; s <= upTo; s++) {
      const entry = this.ring[s % KEPT];
      if (entry && entry.serial === s && (!keys || keys.has(entry.key))) out.push(entry);
    }
    return out;
  }

  /** The serial of the latest change: what a reader that has seen everything holds. */
  get version(): number {
    return this.serial;
  }

  /** The changes after `since`, of these keys only when given; `null` if some were forgotten. */
  since(since: number, keys?: readonly (keyof V & string)[]): StateChange<V>[] | null {
    return this.between(since, this.serial, keys ? new Set(keys) : undefined);
  }

  /** The last `n` changes, newest first. */
  latest(n: number): StateChange<V>[] {
    const out: StateChange<V>[] = [];
    for (let s = this.serial; s > this.serial - this.count && out.length < n; s--) {
      const entry = this.ring[s % KEPT];
      if (entry && entry.serial === s) out.push(entry);
    }
    return out;
  }

  /** Every value as it is now (a copy). */
  snapshot(): Readonly<V> {
    return { ...this.current };
  }
}

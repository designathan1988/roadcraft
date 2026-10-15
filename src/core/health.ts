/**
 * THE GAME'S HEALTH: what broke and what was slow, written down as it
 * happens, with what the player was doing - so a defect is known when it
 * happens, not when the player reports it (the player, 2026-10-08: "saiba
 * quando algo quebrou, está lento"; "tem coisas que não funciona e você nem
 * sabe").
 *
 * An entry is an event already past, its data captured when it is written
 * (Nystrom, "Event Queue"), in a ring of fixed size. The same failure
 * repeating is one entry with a count (the queue's "aggregating requests"):
 * an error thrown every frame must not push everything else out.
 *
 * Slowness is measured per system (`FrameTimer`): each frame notes how long
 * each system of the frame loop took, against a budget declared once here,
 * so a long frame (over 50 ms: MDN, Long Animation Frames) is told with the
 * systems that took it.
 *
 * Pure: no three, no DOM. The page's own signals (errors, the console,
 * workers, WebGL, long frames) are wired in `ui/healthWatch.ts`.
 */

/** What kind of trouble. */
export type HealthKind =
  | 'error' | 'rejection' | 'console' | 'worker' | 'webgl' | 'shader' | 'storage' | 'invariant' | 'slow-frame' | 'budget';

/** `broken`: something failed; `slow`: a frame over the long-frame line; `warning`: a check that did not hold. */
export type HealthSeverity = 'broken' | 'slow' | 'warning';

export interface HealthEntry {
  readonly serial: number;
  readonly kind: HealthKind;
  readonly severity: HealthSeverity;
  readonly message: string;
  /** A stack, a log, the scripts of a long frame. */
  readonly detail?: string;
  /** What the player was doing: the tool, the gesture, the latest change of the world. */
  readonly context?: string;
  /** For a slow frame: milliseconds per system, the largest first. */
  readonly systems?: readonly (readonly [string, number])[];
  /** How long, ms (a slow frame). */
  readonly ms?: number;
  /** `performance.now()` of the first time, and of the last repeat. */
  readonly at: number;
  readonly lastAt: number;
  /** Wall-clock time of the first time (`Date.now()`), to read across sessions. */
  readonly wall: number;
  /** How many times it happened (repeats of the same kind and message within `REPEAT_WINDOW_MS`). */
  readonly count: number;
  /** Written in an earlier session of the game (`restore`). */
  readonly earlier?: boolean;
}

/** How many entries are kept. */
const KEPT = 256;
/** A repeat of the same kind and message within this is counted on the entry already written. */
const REPEAT_WINDOW_MS = 10_000;

export class HealthLog {
  private serial = 0;
  private readonly ring: (HealthEntry | undefined)[] = new Array<HealthEntry | undefined>(KEPT);
  private count = 0;

  /** The serial of the latest entry (a repeat counted on an entry does not move it). */
  get version(): number {
    return this.serial;
  }

  /** Bumped on every write, repeats too: what a panel watches to redraw. */
  private touched = 0;
  get changes(): number {
    return this.touched;
  }

  /** Writes an entry, or counts a repeat on the last one of the same kind and message. */
  record(kind: HealthKind, severity: HealthSeverity, message: string, extra: {
    readonly detail?: string; readonly context?: string; readonly systems?: readonly (readonly [string, number])[]; readonly ms?: number;
  } = {}): HealthEntry {
    const now = performance.now();
    this.touched++;
    for (let s = this.serial; s > this.serial - this.count && s > this.serial - 16; s--) {
      const entry = this.ring[s % KEPT];
      if (!entry || entry.serial !== s || entry.earlier) continue;
      if (entry.kind === kind && entry.message === message && now - entry.lastAt < REPEAT_WINDOW_MS) {
        const again: HealthEntry = { ...entry, lastAt: now, count: entry.count + 1, ...(extra.ms !== undefined ? { ms: Math.max(entry.ms ?? 0, extra.ms) } : {}) };
        this.ring[s % KEPT] = again;
        return again;
      }
    }
    const serial = ++this.serial;
    const entry: HealthEntry = {
      serial, kind, severity, message, at: now, lastAt: now, wall: Date.now(), count: 1,
      ...(extra.detail ? { detail: extra.detail } : {}),
      ...(extra.context ? { context: extra.context } : {}),
      ...(extra.systems?.length ? { systems: extra.systems } : {}),
      ...(extra.ms !== undefined ? { ms: extra.ms } : {}),
    };
    this.ring[serial % KEPT] = entry;
    if (this.count < KEPT) this.count++;
    return entry;
  }

  /** The last `n` entries, newest first. */
  latest(n: number): HealthEntry[] {
    const out: HealthEntry[] = [];
    for (let s = this.serial; s > this.serial - this.count && out.length < n; s--) {
      const entry = this.ring[s % KEPT];
      if (entry && entry.serial === s) out.push(entry);
    }
    return out;
  }

  /**
   * How the game is now: `broken` if something failed within `windowMs`,
   * `slow` if a frame was long within it, else `ok`. Entries from an earlier
   * session do not count.
   */
  status(windowMs = 30_000): 'ok' | 'slow' | 'broken' {
    const since = performance.now() - windowMs;
    let slow = false;
    for (const entry of this.latest(KEPT)) {
      if (entry.earlier || entry.lastAt < since) continue;
      if (entry.severity === 'broken') return 'broken';
      if (entry.severity !== 'warning') slow = true;
    }
    return slow ? 'slow' : 'ok';
  }

  /** The entries to keep across sessions, oldest first. */
  toJSON(): HealthEntry[] {
    return this.latest(50).reverse();
  }

  /** Brings back the entries of an earlier session, marked as such (they never count in `status`). */
  restore(entries: readonly HealthEntry[]): void {
    for (const entry of entries) {
      if (!entry || typeof entry.message !== 'string' || typeof entry.kind !== 'string') continue;
      const serial = ++this.serial;
      this.ring[serial % KEPT] = { ...entry, serial, earlier: true, at: -Infinity, lastAt: -Infinity };
      if (this.count < KEPT) this.count++;
    }
    this.touched++;
  }
}

/** A frame at 60 frames a second, ms. */
const FRAME_BUDGET_MS = 1000 / 60;
/** A long frame: past this the player sees a hitch (MDN, Long Animation Frames: 50 ms). */
export const LONG_FRAME_MS = 50;

/**
 * The systems of the frame loop (`main.ts` `frame`), by id: what a frame's
 * time is told by. The F9 monitor shows each through the dictionary
 * (`health.system.<id>`). DO NOT name a system by its words in one
 * language: they were the monitor's text in Portuguese whatever the game's
 * language was.
 */
export type FrameSystem = 'panels' | 'camera' | 'topology' | 'simulation' | 'roadNetwork' | 'buildings' | 'poles' | 'drawing' | 'overlay';

/** The dictionary key of a system's name, as the monitor shows it. */
export const systemKey = (system: string): string => `health.system.${system}`;

/**
 * Each system's share of a frame, ms: declared once, here. A system over
 * its share is named in a long frame's entry; the shares add to more than a
 * frame because they are rarely all spent in the same one. Absent (the
 * camera): a whole frame.
 */
const SYSTEM_BUDGET_MS: Readonly<Partial<Record<FrameSystem, number>>> = {
  simulation: 4,
  topology: 6,
  roadNetwork: 4,
  buildings: 3,
  poles: 1,
  drawing: 8,
  overlay: 2,
  panels: 2,
};

/** One frame's systems, ms each. */
export interface FrameRecord {
  readonly start: number;
  readonly end: number;
  readonly systems: ReadonlyMap<string, number>;
}

/** How many frames are kept to be matched against a long frame. */
const FRAMES_KEPT = 240;

/**
 * Times the systems of each frame: `begin` at the top of the frame, `mark`
 * after each system with its name (the time since the last mark is that
 * system's), `end` at the bottom. Only `performance.now()` is read: no
 * `performance.measure` per frame.
 */
export class FrameTimer {
  private start = 0;
  private lap = 0;
  private current = new Map<string, number>();
  private readonly frames: FrameRecord[] = [];

  begin(now = performance.now()): void {
    this.start = now;
    this.lap = now;
    this.current = new Map();
  }

  /** The time since the last mark (or the beginning) was `system`'s. */
  mark(system: FrameSystem, now = performance.now()): void {
    this.current.set(system, (this.current.get(system) ?? 0) + (now - this.lap));
    this.lap = now;
  }

  /** Ends the frame; returns it. */
  end(now = performance.now()): FrameRecord {
    const frame: FrameRecord = { start: this.start, end: now, systems: this.current };
    this.frames.push(frame);
    if (this.frames.length > FRAMES_KEPT) this.frames.shift();
    return frame;
  }

  /** The frames that ran between `from` and `to` (a long frame's span). */
  between(from: number, to: number): FrameRecord[] {
    return this.frames.filter((f) => f.end >= from && f.start <= to);
  }

  /** The frames kept (the last `FRAMES_KEPT`), oldest first. */
  recent(): readonly FrameRecord[] {
    return this.frames;
  }
}

/** The P-th percentile (0 < P <= 100) of `values` by nearest rank: always one of them, the 100th the largest. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1]!;
}

/** How a set of frames went, the whole frame and each system: median, 95th percentile and largest, ms. */
export interface FrameStats {
  readonly frames: number;
  /** Frames over `LONG_FRAME_MS`. */
  readonly long: number;
  readonly total: { readonly p50: number; readonly p95: number; readonly max: number };
  readonly systems: Readonly<Record<string, { readonly p50: number; readonly p95: number; readonly max: number }>>;
}

/** The frames summed up per system - the same numbers the monitor's long-frame entries are made of. */
export function frameStats(frames: readonly FrameRecord[]): FrameStats {
  const round = (ms: number): number => Math.round(ms * 10) / 10;
  const spread = (values: number[]): { p50: number; p95: number; max: number } => ({
    p50: round(percentile(values, 50)), p95: round(percentile(values, 95)), max: round(percentile(values, 100)),
  });
  const totals = frames.map((f) => f.end - f.start);
  const names = new Set<string>();
  for (const f of frames) for (const name of f.systems.keys()) names.add(name);
  const systems: Record<string, { p50: number; p95: number; max: number }> = {};
  for (const name of names) systems[name] = spread(frames.map((f) => f.systems.get(name) ?? 0));
  return { frames: frames.length, long: totals.filter((t) => t > LONG_FRAME_MS).length, total: spread(totals), systems };
}

/** The systems of these frames summed, the largest first, those under 0.5 ms left out. */
export function systemsOf(frames: readonly FrameRecord[]): [string, number][] {
  const sum = new Map<string, number>();
  for (const f of frames) for (const [name, ms] of f.systems) sum.set(name, (sum.get(name) ?? 0) + ms);
  return [...sum].filter(([, ms]) => ms >= 0.5).sort((a, b) => b[1] - a[1]).map(([name, ms]) => [name, Math.round(ms * 10) / 10]);
}

/** The systems of a frame that went over their share (`SYSTEM_BUDGET_MS`). */
export function overBudget(frame: FrameRecord): [string, number][] {
  return [...frame.systems].filter(([name, ms]) => ms > (SYSTEM_BUDGET_MS[name as FrameSystem] ?? FRAME_BUDGET_MS));
}

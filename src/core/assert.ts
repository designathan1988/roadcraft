/** RUNTIME CHECKS IN TIERS (Unreal's check/checkSlow/ensure; SQLite's asserts, ~3x slower when on, off in release; TigerBeetle's paired
 *  assertions): what no test builds - a derived index out of step with its source, a value that should never be - caught where it is born.
 *  - `assert`: a programmer's error. Throws in development; in the product it is never evaluated, so call it as
 *    `if (import.meta.env.DEV) assert(...)` when its condition costs anything (Vite replaces `import.meta.env.DEV` at build time and drops the branch).
 *  - `slowChecks`: whether the O(n) sweeps run (a derived structure rebuilt and compared with the live one): off unless asked for
 *    (`?checks` in the address, or `ROADCRAFT_SLOW_CHECKS=1` at build time), never in the product.
 *  - `ensure`: a condition the game survives but must hear of: reported once per message a session (the console, and the crash log
 *    `problems.setReporter` hands it to), the game going on. Kept in the product. */

declare const __SLOW_CHECKS__: boolean | undefined;

export class AssertionError extends Error {
  override name = 'AssertionError';
}

/** Throws when `condition` is false (development only: guard the call with `import.meta.env.DEV` when the condition costs anything). */
export function assert(condition: unknown, message: string | (() => string)): asserts condition {
  if (condition) return;
  throw new AssertionError(typeof message === 'function' ? message() : message);
}

/** The O(n) sweeps are run: development builds asked for them at build time or in the address. */
export const slowChecks: boolean = import.meta.env.DEV && ((typeof __SLOW_CHECKS__ !== 'undefined' && __SLOW_CHECKS__)
  || (typeof location !== 'undefined' && new URLSearchParams(location.search).has('checks')));

/** THE SESSION'S PROBLEMS: each failed `ensure` told once, to the console and to the reporter set at start-up (the crash log, a reporter). */
export class ProblemLog {
  private readonly told = new Set<string>();
  private report: (message: string) => void = () => {};

  /** Where a failed `ensure` is told besides the console. */
  setReporter(report: (message: string) => void): void {
    this.report = report;
  }

  /** True when `condition` holds; otherwise reported once per message in the session and false, the caller carrying on. */
  ensure(condition: unknown, message: string): boolean {
    if (condition) return true;
    if (this.told.has(message)) return false;
    this.told.add(message);
    console.error(`[ensure] ${message}`);
    try {
      this.report(message);
    } catch (error) {
      // A reporter that fails must not take the game with it: said, and the game goes on.
      console.error('[ensure] the problem reporter failed', error);
    }
    return false;
  }
}

/** The game's one log of problems (`ensure` below). */
export const problems = new ProblemLog();

/** `problems.ensure`: a condition the game survives but must hear of. */
export const ensure = (condition: unknown, message: string): boolean => problems.ensure(condition, message);

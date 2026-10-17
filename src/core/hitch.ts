/** A STEP OF THE GAME TIMED for the frame monitor (`ui/healthWatch.ts`) and the profiler (`core/profiler.ts`): a `hitch:` entry of the platform's timeline, in a development build only (decision 5.4, the player's: the game shipped measures nothing) */
export function measureHitch(name: string, start: number, end?: number): void {
  if (!import.meta.env.DEV) return;
  if (typeof performance === 'undefined' || typeof performance.measure !== 'function') return;
  performance.measure(name, { start, end: end ?? performance.now() });
}

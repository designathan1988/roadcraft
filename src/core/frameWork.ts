/**
 * One allowance per frame for all the work spread over frames: the
 * simulation's topology, the world of an edit, the buildings. Each took its
 * own slice (6, 10 and 6 ms); falling in the same frame they added up to
 * frames of 60-90 ms after every road drawn (docs/performance.md #28).
 *
 * The first job of a frame opens the allowance; the others work only until
 * it closes, and wait for the next frame when nothing is left.
 */
export const FRAME_WORK_MS = 10;
let deadline = -1;

/** A new frame: the allowance opens with the first job that asks (`main.ts` frame). */
export function beginFrameWork(): void {
  deadline = -1;
}

/**
 * Until when a job may work now, at most `slice` ms; 0 when the frame's
 * allowance is spent. The first job of a frame opens the allowance at
 * `allowance` ms (the world of an edit opens a larger one: `renderer.ts`).
 */
export function workUntil(slice: number, allowance = FRAME_WORK_MS): number {
  const now = performance.now();
  if (deadline < 0) deadline = now + allowance;
  const until = Math.min(now + slice, deadline);
  return until > now ? until : 0;
}

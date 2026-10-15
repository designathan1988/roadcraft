/** One allowance per frame for all the work spread over frames */
const FRAME_WORK_MS = 10;
let deadline = -1;

/** A new frame: the allowance opens with the first job that asks (`main.ts` frame). */
export function beginFrameWork(): void {
  deadline = -1;
}

/** Until when a job may work now, at most `slice` ms; 0 when the frame's allowance is spent. */
export function workUntil(slice: number, allowance = FRAME_WORK_MS): number {
  const now = performance.now();
  if (deadline < 0) deadline = now + allowance;
  const until = Math.min(now + slice, deadline);
  return until > now ? until : 0;
}

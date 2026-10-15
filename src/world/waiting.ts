/** Yielded by a preparation while the workers do its pure work (`ConflictIndex.prepare`, `Walkways.updateSteps`) */
export const WAITING = 'waiting' as const;

/** The workers' answer, `WAITING` yielded until it comes; null when they failed, and the page then does `what` as before. */
export function* answered<T>(asked: Promise<T>, what: string): Generator<typeof WAITING, T | null> {
  const answer: { value?: T; failed?: boolean } = {};
  asked.then((value) => { answer.value = value; }, (error: unknown) => {
    console.warn(`[traffic] the conflict workers failed; ${what} on the page`, error);
    answer.failed = true;
  });
  while (!('value' in answer) && !answer.failed) yield WAITING;
  return answer.failed ? null : answer.value as T;
}

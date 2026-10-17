/** DO NOT let two tabs write one world (each stamps the versions it knows, the last writer wins): the first holds it (a Web Lock by its name, MDN "LockManager"), until it closes it; another tab opens it read only */

/** What of the Web Locks API the hold uses. */
export type WorldLocks = Pick<LockManager, 'request'>;

/** Holds world `name`: resolves the release, or null when another tab holds it (or no lock could be asked for: then the world opens read only, never hung). */
export type HoldWorld = (name: string) => Promise<(() => void) | null>;

/** This tab's holds of its worlds: a world reopened waits for this tab's own last hold of it to be let go (its tiles still being written), never taken for another tab's. */
export function worldHolds(locks: WorldLocks | undefined): HoldWorld {
  /** Each world's last request of this tab: settled once the lock manager let its lock go. */
  const last = new Map<string, Promise<unknown>>();
  return async (name) => {
    if (!locks) return () => {};
    const key = `roadcraft.world.${name}`;
    await last.get(key)?.catch(() => undefined);
    return new Promise((answer) => {
      const request = locks.request(key, { ifAvailable: true }, (lock) => {
        if (!lock) { answer(null); return undefined; }
        // Held while this promise stands: settled when the world is closed (`main.ts` afterStreamedWorld).
        return new Promise<void>((release) => answer(release));
      });
      last.set(key, request);
      request.catch((error: unknown) => {
        console.error('[world] its lock could not be asked for: opened read only', error);
        answer(null);
      });
    });
  };
}

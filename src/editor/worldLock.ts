/** DO NOT let two tabs write one world (each stamps the versions it knows, the last writer wins): the first holds it (a Web Lock by its name, MDN "LockManager"), until it closes it; another tab opens it read only */

/** What of the Web Locks API the hold uses. */
export type WorldLocks = Pick<LockManager, 'request'>;

/** Holds world `name`: resolves the release, or null when another tab holds it (or no lock could be asked for: then the world opens read only, never hung). */
export function holdWorld(locks: WorldLocks | undefined, name: string): Promise<(() => void) | null> {
  if (!locks) return Promise.resolve(() => {});
  return new Promise((answer) => {
    locks.request(`roadcraft.world.${name}`, { ifAvailable: true }, (lock) => {
      if (!lock) { answer(null); return undefined; }
      // Held while this promise stands: settled when the world is closed (`main.ts` afterStreamedWorld).
      return new Promise<void>((release) => answer(release));
    }).catch((error: unknown) => {
      console.error('[world] its lock could not be asked for: opened read only', error);
      answer(null);
    });
  });
}

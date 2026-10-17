import { describe, expect, it } from 'vitest';
import { type WorldLocks, worldHolds } from '@editor/worldLock';

/** THE WORLD'S LOCK (`worldLock.ts`): one tab writes a world, another reads it; a lock that cannot be asked for never hangs the opening */

/** A lock manager of one origin: a name held until its callback's promise settles, `ifAvailable` answered null meanwhile; its request settles after the lock is let go. */
function lockManager(): WorldLocks {
  const held = new Set<string>();
  return {
    request: (async (name: string, _options: unknown, callback: (lock: object | null) => unknown) => {
      if (held.has(name)) return callback(null);
      held.add(name);
      try { return await callback({ name }); } finally { await Promise.resolve(); held.delete(name); }
    }) as unknown as WorldLocks['request'],
  };
}

describe("a world's lock", () => {
  it('opens the world read only when the lock cannot be asked for, instead of never answering', async () => {
    const broken: WorldLocks = { request: (() => Promise.reject(new Error('SecurityError'))) as unknown as WorldLocks['request'] };
    await expect(worldHolds(broken)('w')).resolves.toBeNull();
  });

  it("reopened in this tab waits for its own last hold to be let go: not read only behind its own lock", async () => {
    const hold = worldHolds(lockManager());
    const first = await hold('w');
    expect(first).not.toBeNull();
    // Closed (its tiles' writes still settling) and opened again at once.
    const again = hold('w');
    first!();
    await expect(again).resolves.not.toBeNull();
  });

  it('is read only in a second tab while the first holds it', async () => {
    const shared = lockManager();
    const first = await worldHolds(shared)('w');
    await expect(worldHolds(shared)('w')).resolves.toBeNull();
    first!();
  });
});

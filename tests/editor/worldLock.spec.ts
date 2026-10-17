import { describe, expect, it } from 'vitest';
import { type WorldLocks, holdWorld } from '@editor/worldLock';

/** THE WORLD'S LOCK (`worldLock.ts`): one tab writes a world, another reads it; a lock that cannot be asked for never hangs the opening */

describe("a world's lock", () => {
  it('opens the world read only when the lock cannot be asked for, instead of never answering', async () => {
    const broken: WorldLocks = { request: (() => Promise.reject(new Error('SecurityError'))) as unknown as WorldLocks['request'] };
    await expect(holdWorld(broken, 'w')).resolves.toBeNull();
  });
});

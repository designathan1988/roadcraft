import { describe, expect, it } from 'vitest';
import { type WorldLocks, worldHolds } from '@editor/worldLock';

/** THE WORLD'S LOCK (`worldLock.ts`): one tab writes a world, another reads it; a lock that cannot be asked for never hangs the opening */

/** A lock manager of one origin: a name held until its callback's promise settles, `ifAvailable` answered null meanwhile; its request settles after the lock is let go. */
function lockManager(): WorldLocks {
  const held = new Set<string>();
  const queued = new Map<string, (() => void)[]>();
  return {
    request: (async (name: string, options: { ifAvailable?: boolean }, callback: (lock: object | null) => unknown) => {
      if (held.has(name)) {
        if (options.ifAvailable) return callback(null);
        // Without ifAvailable: queued until the holder lets go (MDN "LockManager.request").
        await new Promise<void>((done) => { const q = queued.get(name) ?? []; q.push(done); queued.set(name, q); });
      }
      held.add(name);
      try { return await callback({ name }); } finally { await Promise.resolve(); held.delete(name); queued.get(name)?.shift()?.(); }
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

  it('in a second tab, asked to wait, is given once the first tab lets it go: the world then opens here, written', async () => {
    const shared = lockManager();
    const first = await worldHolds(shared)('w');
    let given: (() => void) | null | 'pending' = 'pending';
    void worldHolds(shared)('w', { wait: true }).then((release) => { given = release; });
    await new Promise((done) => setTimeout(done, 0));
    expect(given).toBe('pending');
    first!();
    await new Promise((done) => setTimeout(done, 0));
    expect(typeof given).toBe('function');
  });

  it('is waited for on the curtain in the page, never opened read only and silent (`main.ts`)', async () => {
    const { readFileSync } = await import('node:fs');
    const main = readFileSync('src/main.ts', 'utf8');
    const open = main.slice(main.indexOf('async function openStreamedWorld('), main.indexOf('const store = new TileStore(mapName'));
    expect(open).toMatch(/if \(!release && !imported\) \{[\s\S]*t\('map\.otherTab'\)[\s\S]*holdWorld\(mapName, \{ wait: true \}\)/);
  });
});


import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** THE DESKTOP'S SAVES FOLDER: keys as file names, batches as transactions, a crash finished or dropped (`desktop/saves.cjs`). */
interface Saves { run(request: object): Promise<unknown>; drained(): Promise<boolean> }
const { createSaves, fileOf, keyOf } = createRequire(import.meta.url)('../../desktop/saves.cjs') as {
  createSaves(dir: string): Saves;
  fileOf(key: string): string;
  keyOf(file: string): string;
};

const made: string[] = [];
const folder = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'roadcraft-saves-'));
  made.push(dir);
  return join(dir, 'saves');
};
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (value: unknown): string | null => (value instanceof Uint8Array ? new TextDecoder().decode(value) : null);
const get = async (saves: Saves, keys: string[]): Promise<(string | null)[]> => ((await saves.run({ op: 'get', keys })) as unknown[]).map(text);

describe('the desktop saves folder', () => {
  it('names each key with a file of its own, apart on a disk blind to case', () => {
    const keys = ['roadcraft.world.v7:tiles', 'roadcraft.world.v7:L:buildings:-3_12', 'roadcraft.world.v7:l:buildings:-3_12', 'a/b\\c*?'];
    for (const key of keys) expect(keyOf(fileOf(key))).toBe(key);
    const names = keys.map((key) => fileOf(key).toLowerCase());
    expect(new Set(names).size).toBe(keys.length);
    for (const name of names) expect(name).toMatch(/^[a-z0-9._%-]+$/);
  });

  it('writes, reads, lists and removes', async () => {
    const saves = createSaves(folder());
    await saves.run({ op: 'write', put: [['a:1', bytes('one')], ['a:2', bytes('two')]], remove: [] });
    expect(await get(saves, ['a:1', 'a:2', 'none'])).toEqual(['one', 'two', null]);
    await saves.run({ op: 'write', put: [['a:1', bytes('ONE')]], remove: ['a:2'] });
    expect(await get(saves, ['a:1', 'a:2'])).toEqual(['ONE', null]);
    expect(await saves.run({ op: 'keys' })).toEqual(['a:1']);
  });

  it('writes a save batch as the browser writer does: the frames\' bytes, gzip when packed', async () => {
    const saves = createSaves(folder());
    const frame = new Uint8Array([0x52, 0x43, 0x53, 0x51, 1, 2, 3, 4]);
    await saves.run({ op: 'batch', batch: { put: [{ key: 'p', bytes: frame.slice().buffer, packed: true }, { key: 'm', bytes: bytes('[3]').buffer, packed: false }], remove: [] } });
    const [packed, plain] = (await saves.run({ op: 'get', keys: ['p', 'm'] })) as Uint8Array[];
    expect([...gunzipSync(packed!)]).toEqual([...frame]);
    expect(text(plain)).toBe('[3]');
  });

  it('finishes a batch whose commit was written and drops one whose commit was not', async () => {
    const dir = folder();
    await createSaves(dir).run({ op: 'write', put: [['k', bytes('old')], ['gone', bytes('x')]], remove: [] });
    // A crash after the commit, before the renames.
    mkdirSync(`${dir}.staging`);
    writeFileSync(join(`${dir}.staging`, '0'), 'new');
    writeFileSync(join(`${dir}.staging`, 'commit.json'), JSON.stringify({ put: [['0', 'k']], remove: ['gone'] }));
    const after = createSaves(dir);
    expect(await get(after, ['k', 'gone'])).toEqual(['new', null]);
    // A crash before the commit: the staged file is not the save.
    mkdirSync(`${dir}.staging`);
    writeFileSync(join(`${dir}.staging`, '0'), 'half');
    expect(await get(createSaves(dir), ['k'])).toEqual(['new']);
    expect(readdirSync(join(dir, '..'))).toEqual(['saves']);
  });

  it('says it is drained only once every write asked before is on the disk (the exit waits for it)', async () => {
    const dir = folder();
    const saves = createSaves(dir);
    const writes = Array.from({ length: 5 }, (_, k) => saves.run({ op: 'write', put: [[`w:${k}`, bytes(String(k))]], remove: [] }));
    let settled = 0;
    for (const w of writes) void w.then(() => { settled++; });
    expect(await saves.drained()).toBe(true);
    expect(settled).toBe(5);
    expect(await get(saves, ['w:0', 'w:4'])).toEqual(['0', '4']);
  });

  it('answers an unknown request with a refusal, and keeps answering', async () => {
    const saves = createSaves(folder());
    await expect(saves.run({ op: 'constructor' })).rejects.toThrow();
    expect(await saves.run({ op: 'keys' })).toEqual([]);
  });
});

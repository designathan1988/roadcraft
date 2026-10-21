import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** THE DESKTOP'S FIELD PROBLEM LOG: kept on the machine, rotated by size, capped a session, a page's report checked (`desktop/problems.cjs`). */
interface Entry { kind: string; message: string; detail?: string; data?: Record<string, unknown> }
interface Log { file: string; write(entry: Entry): boolean; addSink(sink: (record: Entry & { at: string }) => void): () => void; readonly dropped: number }
const { createProblemLog, fromPage } = createRequire(import.meta.url)('../../desktop/problems.cjs') as {
  createProblemLog(options: { folder: string; maxBytes?: number; keep?: number; sessionMax?: number; now?: () => Date }): Log;
  fromPage(raw: unknown): Entry | null;
};

const made: string[] = [];
const folder = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'roadcraft-problems-'));
  made.push(dir);
  return join(dir, 'problems');
};
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const lines = (file: string): Entry[] => readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Entry);

describe('the field problem log', () => {
  it('writes one JSON line an entry, stamped with the time', () => {
    const log = createProblemLog({ folder: folder(), now: () => new Date('2026-10-21T12:00:00Z') });
    log.write({ kind: 'error', message: 'boom' });
    log.write({ kind: 'webgl-lost', message: 'WebGL context lost' });
    expect(lines(log.file)).toEqual([
      { at: '2026-10-21T12:00:00.000Z', kind: 'error', message: 'boom' },
      { at: '2026-10-21T12:00:00.000Z', kind: 'webgl-lost', message: 'WebGL context lost' },
    ]);
  });

  it('rotates by size and never keeps more than its files, each under the cap', () => {
    const dir = folder();
    const log = createProblemLog({ folder: dir, maxBytes: 400, keep: 2 });
    for (let i = 0; i < 60; i++) log.write({ kind: 'error', message: `problem number ${i} ${'x'.repeat(40)}` });
    const files = readdirSync(dir).sort();
    expect(files).toEqual(['problems.1.log', 'problems.2.log', 'problems.log']);
    for (const name of files) expect(statSync(join(dir, name)).size).toBeLessThanOrEqual(400);
    // The newest entry is in the current file, the older ones moved down in order.
    expect(lines(log.file).at(-1)!.message).toContain('problem number 59');
    const numbers = (file: string): number[] => lines(file).map((e) => Number(/number (\d+)/.exec(e.message)![1]));
    expect(Math.max(...numbers(join(dir, 'problems.2.log')))).toBeLessThan(Math.min(...numbers(join(dir, 'problems.1.log'))));
    expect(Math.max(...numbers(join(dir, 'problems.1.log')))).toBeLessThan(Math.min(...numbers(log.file)));
  });

  it('stops writing past the session cap and counts what it dropped', () => {
    const log = createProblemLog({ folder: folder(), sessionMax: 5 });
    for (let i = 0; i < 9; i++) log.write({ kind: 'error', message: `e${i}` });
    expect(lines(log.file)).toHaveLength(5);
    expect(log.dropped).toBe(4);
  });

  it('hands each entry to a plugged sink after the disk, and a failing sink harms nothing', () => {
    const log = createProblemLog({ folder: folder() });
    const seen: string[] = [];
    log.addSink(() => { throw new Error('remote down'); });
    const remove = log.addSink((record) => seen.push(record.message));
    log.write({ kind: 'ensure', message: 'first' });
    remove();
    log.write({ kind: 'ensure', message: 'second' });
    expect(seen).toEqual(['first']);
    expect(lines(log.file).map((e) => e.message)).toEqual(['first', 'second']);
  });

  it("checks a page's report: known kinds only, cut to size, flat data", () => {
    expect(fromPage(null)).toBeNull();
    expect(fromPage({ kind: 'start', message: 'forged' })).toBeNull();
    expect(fromPage({ kind: 'error', message: '' })).toBeNull();
    const entry = fromPage({ kind: 'session', message: 'm'.repeat(2000), detail: 7, data: { gpu: 'ANGLE', p95: 18.5, nested: { a: 1 }, 'bad key': 1, nan: Number.NaN } })!;
    expect(entry.message).toHaveLength(500);
    expect(entry.detail).toBeUndefined();
    expect(entry.data).toEqual({ gpu: 'ANGLE', p95: 18.5 });
  });
});

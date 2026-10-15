import { afterEach, describe, expect, it } from 'vitest';

import { CellPool } from '@render/buildings/cellPool';
import type { KitBoxes } from '@render/buildings/cellArrays';
import type { CellEntry } from '@render/buildings/cellWork';

/** A JOB WAITING ITS TURN HOLDS NO TEXT (`cellPool.ts`) */
class FakeWorker {
  static made: FakeWorker[] = [];
  readonly posted: unknown[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  constructor() { FakeWorker.made.push(this); }
  postMessage(message: unknown): void { this.posted.push(message); }
  terminate(): void {}
}
const realWorker = (globalThis as { Worker?: unknown }).Worker;
afterEach(() => {
  (globalThis as { Worker?: unknown }).Worker = realWorker;
  FakeWorker.made = [];
});

const boxes = { parts: {}, furniture: {} } as unknown as KitBoxes;
const env = { groundAt: () => 0, naturalAt: () => 0 };
const entry = (key: string): CellEntry => ({ key, sig: 0, digest: 0 }) as unknown as CellEntry;

describe('a cell job waiting its turn', () => {
  it('writes no record text until a worker takes it', () => {
    (globalThis as { Worker?: unknown }).Worker = FakeWorker;
    const written: string[] = [];
    const pool = new CellPool(() => boxes, (e) => () => { written.push(e.key); return '{}'; });
    // Ten jobs on one cell: one lane, one job at a time on it; the other nine wait.
    for (let k = 0; k < 10; k++) pool.run('mass', 'cell-a', [entry(`b${k}a`), entry(`b${k}b`)], env, () => {});
    // Only the job a worker took has had its records written.
    expect(written).toEqual(['b0a', 'b0b']);
    expect(pool.running).toBe(10);
  });
});

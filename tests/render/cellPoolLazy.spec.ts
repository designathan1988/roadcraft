import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KitBoxes } from '@render/buildings/cellArrays';
import type { CellEntry } from '@render/buildings/cellWork';
import { GroundShare } from '@render/sharedGround';

/** A JOB WAITING ITS TURN HOLDS NO TEXT (`cellPool.ts`, `jobPool.ts` `JobSpec.write`) */
class FakeWorker {
  static made: FakeWorker[] = [];
  readonly posted: unknown[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  constructor() { FakeWorker.made.push(this); }
  postMessage(message: unknown): void { this.posted.push(message); }
  terminate(): void {}
}

const boxes = { parts: {}, furniture: {} } as unknown as KitBoxes;
const env = { groundAt: Object.assign(() => 0, { share: new GroundShare(3, 1, 1, 0) }), naturalAt: () => 0 };
const entry = (key: string): CellEntry => ({ key, sig: 0, digest: 0 }) as unknown as CellEntry;

describe('a cell job waiting its turn', () => {
  beforeEach(() => {
    FakeWorker.made = [];
    vi.resetModules();
    vi.stubGlobal('Worker', FakeWorker);
    // Two workers: two jobs at once, the others wait in the queue.
    vi.stubGlobal('navigator', { hardwareConcurrency: 4 });
    vi.stubGlobal('document', {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes no record text until a worker takes it', async () => {
    const { CellPool } = await import('@render/buildings/cellPool');
    const written: string[] = [];
    const pool = new CellPool(() => boxes, (e) => () => { written.push(e.key); return '{}'; });
    for (let k = 0; k < 10; k++) pool.run('mass', `${k},0`, [entry(`b${k}a`), entry(`b${k}b`)], env, () => {});
    // Only the jobs the two workers took have had their records written: the two nearest the eye.
    expect(FakeWorker.made).toHaveLength(2);
    expect(written).toEqual(['b0a', 'b0b', 'b1a', 'b1b']);
    expect(pool.running).toBe(10);
  });
});

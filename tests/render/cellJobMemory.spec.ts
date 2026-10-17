import { setFlagsFromString, getHeapStatistics } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import { type CellJob, runCellJob } from '@render/buildings/cellWork';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import { encodeRecords } from '@world/buildings/recordTable';
import type { Building } from '@world/buildings/types';
import { m } from '@world/units';

/** WHAT A MASS JOB HOLDS WHILE IT RUNS (`cellWork.ts` runCellJob): a plate's job is thousands of buildings, and every worker shares one V8 heap cage with the page (`jobs/jobPool.ts` CAGE_BYTES) */

setFlagsFromString('--expose_gc');
const collect = runInNewContext('gc') as () => void;
const used = (): number => { collect(); return getHeapStatistics().used_heap_size; };

/** `count` buildings of every blueprint in a row, in one table as a tile keeps them. */
function table(count: number): { buffer: ArrayBufferLike; rows: number } {
  const buildings: Building[] = [];
  for (let i = 0; i < count; i++) {
    const bp = BLUEPRINTS[i % BLUEPRINTS.length]!;
    buildings.push({ ...JSON.parse(JSON.stringify(bp.body)), id: i + 1, x: (i % 40) * m(60), y: Math.floor(i / 40) * m(60), rotation: 0 } as Building);
  }
  return { buffer: encodeRecords(buildings).buffer, rows: count };
}

describe("a mass job's buildings", () => {
  it('are let go as their masses are made: the job never holds the whole tile read', () => {
    const { buffer, rows } = table(400);
    const job: CellJob = {
      id: 1, kind: 'massTile', cell: 'tile', paved: false, boxes: { parts: {}, furniture: {} } as unknown as CellJob['boxes'],
      entries: Array.from({ length: rows }, (_, row) => ({ key: String(row), sig: 1, digest: 1, record: { buffer, row } })),
    };
    // The heap held as the job goes, every few thousand reads of the ground: its most.
    const before = used();
    let held = 0, n = 0;
    const read = (): number => { if (++n % 500 === 0) held = Math.max(held, used() - before); return 0; };
    const reply = runCellJob(job, { groundAt: read, naturalAt: read });
    expect(reply.kind).toBe('done');
    expect(n).toBeGreaterThan(5000);
    // One building and its masses so far (1.7 MB), not four hundred read whole with all they worked out (11 MB).
    expect(held / 1e6).toBeLessThan(4);
  }, 10_000);
});

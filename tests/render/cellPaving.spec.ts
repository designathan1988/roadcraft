import { refOf } from '@world/buildings/recordTable';
import { describe, expect, it } from 'vitest';

import { emitChunk, kitBoxes } from '@render/buildings/buildingMesh';
import { type CellArrays, cellArrays } from '@render/buildings/cellArrays';
import { type CellJob, type WorkReply, runCellJob } from '@render/buildings/cellWork';
import { PART_KINDS, createBuildingKit } from '@render/buildings/kit';
import { BATCH_CELL, COARSE_PARTS } from '@render/buildings/layerCells';
import { growOnLot } from '@editor/zoning';
import type { Building } from '@world/buildings/types';
import { RoadDoc } from '@world/doc';
import { GROUND_ONLY, buildRoadElevation } from '@world/elevation';
import { applyLots, planLots, zoneLots } from '@world/lots';
import { Network } from '@world/network';
import { type PavingSource, pavedHeightFrom, pavingReader } from '@world/paving';
import { footwayRiseAt, packFlush } from '@world/roads/footwayRise';
import { FOOTWAY_RISE } from '@world/roadTypes';
import { m } from '@world/units';

/** THE PAVING READ BY A BUILDING CELL'S WORKER ITSELF (`cellPool.ts`, `world/paving.ts`): handed the roads near its cell */
const ground = (x: number, y: number): number => 2 * Math.sin(x / 90) + 1.5 * Math.cos(y / 70);
const naturalAt = (x: number, y: number): number => ground(x, y) - m(0.3);

/** Every array of a batch, as bytes, and its other values, by path. */
function bytes(o: CellArrays | null): string {
  const out: string[] = [];
  const walk = (v: unknown, path: string): void => {
    if (ArrayBuffer.isView(v)) out.push(`${path}=${v.constructor.name}:${Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')}`);
    else if (v && typeof v === 'object') for (const [k, w] of Object.entries(v)) walk(w, `${path}.${k}`);
    else out.push(`${path}=${String(v)}`);
  };
  walk(o, '');
  return out.join('|');
}

/** A town of four blocks, one street with a footway laid flush, grown on its lots. */
function town(): { doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  const ids: number[][] = [];
  for (let i = 0; i <= 2; i++) { ids.push([]); for (let j = 0; j <= 2; j++) ids[i]!.push(doc.addNode({ x: m(120) * (i - 1), y: m(120) * (j - 1) }).id); }
  const flush = { laneWidth: m(3), sidewalk: m(4), median: 0, speedKmh: 50, priority: 1, flushLeft: true, flushRight: true };
  for (let i = 0; i <= 2; i++) {
    for (let j = 0; j <= 2; j++) {
      if (i < 2) doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, 1, null, 0, 'both', null, 'ground', j === 1 ? flush : undefined);
      if (j < 2) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, 1);
    }
  }
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  doc.lots.forEach((l, k) => zoneLots(doc, [l.id], { use: (['residential', 'commercial'] as const)[k % 2]!, density: 'medium' }));
  const refused = new Set<number>();
  for (let k = 0; k < doc.lots.length * 2; k++) {
    if (growOnLot({ doc, net, groundAt: () => 0 }, refused, 0x5eed) === null && refused.size >= doc.lots.length) break;
  }
  return { doc, net };
}

describe('the paving read by a building cell worker', () => {
  it('is the page\'s, point by point and in the cell it puts together', () => {
    const { doc, net } = town();
    expect(net.flushCells.size).toBeGreaterThan(0);
    const elevation = buildRoadElevation(net, ground);
    // As the renderer reads it (`pavedHeightAt`), and packs it for a cell.
    const rise = (x: number, y: number): number => footwayRiseAt(net, x, y);
    const paved: PavingSource = Object.assign(
      (x: number, y: number): number => (elevation.has(GROUND_ONLY) ? pavedHeightFrom(elevation, GROUND_ONLY, rise, x, y) : NaN),
      { pack: (rect: readonly [number, number, number, number]) => ({
        data: { rect, field: elevation.fieldFor!([rect], []).data, flush: packFlush(net, [rect]).data }, transfer: [] }) });
    expect(FOOTWAY_RISE).toBeGreaterThan(0);

    // Point by point, over a cell and past its edge: the worker's number inside the roads handed over (reading the ground the roads were solved on), none past them.
    const rect: [number, number, number, number] = [-m(130), -m(130), m(10), m(10)];
    const here = pavingReader(structuredClone(paved.pack!(rect)!.data), ground);
    let read = 0, onRoad = 0, flushRise = 0;
    for (let x = -m(150); x <= m(30); x += m(0.73)) {
      for (let y = -m(150); y <= m(30); y += m(0.91)) {
        const local = here(x, y);
        const page = paved(x, y);
        const outside = x < rect[0] || x > rect[2] || y < rect[1] || y > rect[3];
        expect(local === undefined, `${x}, ${y}`).toBe(outside);
        if (local === undefined) continue;
        read++;
        expect(Object.is(local, page), `${x}, ${y}`).toBe(true);
        if (Number.isFinite(page)) onRoad++;
        if (Number.isFinite(page) && rise(x, y) === 0) flushRise++;
      }
    }
    expect(read).toBeGreaterThan(10_000);
    expect(onRoad).toBeGreaterThan(1_000);
    expect(flushRise).toBeGreaterThan(50);

    // A cell put together as a worker does, the paving read there
    const kit = createBuildingKit();
    const buildings = [...doc.buildings.all()].filter((b) => Math.floor(b.x / BATCH_CELL) === -1 && Math.floor(b.y / BATCH_CELL) === -1);
    expect(buildings.length).toBeGreaterThan(3);
    const cellRect: [number, number, number, number] = [-BATCH_CELL - m(64), -BATCH_CELL - m(64), m(64), m(64)];
    const job: CellJob = structuredClone({ id: 1, kind: 'cell', cell: '-1,-1', paved: true, boxes: kitBoxes(kit),
      entries: buildings.map((b) => ({ key: String(b.id), sig: b.id, digest: 0, record: refOf(b) })),
      paving: paved.pack!(cellRect)!.data });
    /** The job's reads as a worker has them: the ground, and the paving off the roads handed over. */
    const reads = (asked: CellJob) => ({ groundAt: ground, naturalAt, ...(asked.paving ? { pavedAt: pavingReader(asked.paving, ground) } : {}) });
    // Without the roads handed over the job asks for them, once, over every point it read; with them it is done in one pass.
    const { paving: _, ...bare } = job;
    let pass: WorkReply = runCellJob({ ...bare, id: 2 }, reads(bare));
    expect(pass.kind).toBe('wider');
    // As the pool asks it again (`cellPool.ts` `MOST_WIDER`).
    for (let k = 0; k < 2 && pass.kind === 'wider'; k++) {
      const paving = paved.pack!(pass.rect)!.data;
      pass = runCellJob({ ...bare, id: 3, paving }, reads({ ...bare, paving }));
    }
    expect(pass.kind).toBe('done');
    const reply = runCellJob(job, reads(job));
    expect(reply.kind).toBe('done');
    if (reply.kind !== 'done' || pass.kind !== 'done') return;
    const chunks = buildings.map((b) => emitChunk(b, ground, paved, naturalAt));
    const coarse = cellArrays(chunks, { parts: PART_KINDS.filter((k) => COARSE_PARTS.has(k)), shells: true, furniture: true, ghost: false, dim: false }, kitBoxes(kit));
    expect(bytes(reply.result.batch)).toBe(bytes(coarse));
    expect(bytes(pass.result.batch)).toBe(bytes(coarse));
    for (const s of reply.result.summaries) {
      const b = buildings.find((x) => String(x.id) === s.key)! as Building;
      const chunk = emitChunk(b, ground, paved, naturalAt);
      expect(s.signatureFloor).toBe(chunk.signatureFloor);
      expect(s.flags ?? null).toEqual(chunk.flags ?? null);
      expect(JSON.stringify(s.lot)).toBe(JSON.stringify(chunk.lotGround?.recipe ?? null));
    }
  });
});

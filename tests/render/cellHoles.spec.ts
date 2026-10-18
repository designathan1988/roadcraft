import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, type WebGLRenderer } from 'three';
import type { CellEnv, CellPool } from '@render/buildings/cellPool';
import type { BuildingKit } from '@render/buildings/kit';
import { CellRequests, MOST_HOLES } from '@render/buildings/cellRequests';
import { WARM_CEILING, cancelWarm, drainWarm, warmFull, warmLooseAhead, warmQueuedBytes, warmReservedBytes } from '@render/uploads';

/** THE HOLE AT THE CAMERA PAST A FULL UPLOAD QUEUE (`cellRequests.ts` want with `hole`): a cell wanted in detail with no level landed is asked, a few at once; the rest waits */

describe('a cell wanted in detail with no level landed', () => {
  it('is asked past a full queue, never more than a few at once; a facade level far off waits', () => {
    const renderer = { render: () => {}, getRenderTarget: () => null, setRenderTarget: () => {}, autoClear: true } as unknown as WebGLRenderer;
    // The frame loop warming; 70 MiB of meshes waiting to go up (a reopening's far levels).
    drainWarm(renderer);
    const waiting = Array.from({ length: 70 }, () => {
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(new Float32Array((1024 * 1024) / 4), 3));
      return new Mesh(g, new MeshBasicMaterial());
    });
    for (const mesh of waiting) void warmLooseAhead([mesh]);
    expect(warmFull()).toBe(true);
    // A pool whose jobs stay in flight.
    let id = 0;
    const pool = { run: () => ++id, supersede: () => {}, cancel: () => {} } as unknown as CellPool;
    const requests = new CellRequests(pool, {} as BuildingKit, () => {});
    const env = {} as CellEnv;
    requests.want('cell', '0,0', [], env, true, false, true);
    expect(requests.isAsked('cell', '0,0')).toBe(true);
    requests.want('facade', '9,9', [], env, true);
    expect(requests.isAsked('facade', '9,9')).toBe(false);
    // Ten holes: only `MOST_HOLES` in flight at once.
    for (let i = 1; i <= 10; i++) requests.want('cell', `${i},0`, [], env, true, false, true);
    let asked = 0;
    for (let i = 0; i <= 10; i++) if (requests.isAsked('cell', `${i},0`)) asked++;
    expect(MOST_HOLES).toBe(4);
    expect(asked).toBe(MOST_HOLES);
    // One let go: another comes in its place.
    requests.drop('cell', '0,0');
    requests.want('cell', '10,0', [], env, true, false, true);
    expect(requests.isAsked('cell', '10,0')).toBe(true);
    cancelWarm(waiting);
  });

  it('the layer asks past the cells asked before it (`STREAM_AHEAD`), as many as it lets holes in', () => {
    const source = readFileSync('src/render/buildings/layer.ts', 'utf8');
    expect(source).toMatch(/requests\.asking < STREAM_AHEAD \|\| \(hole && requests\.holeRoom\(\)\)/);
    let id = 0;
    const pool = { run: () => ++id, supersede: () => {}, cancel: () => {} } as unknown as CellPool;
    const requests = new CellRequests(pool, {} as BuildingKit, () => {});
    // Holes asked with the queue empty count too: the fifth finds no room.
    for (let i = 0; i < MOST_HOLES; i++) requests.want('cell', `${i},5`, [], {} as CellEnv, true, false, true);
    expect(requests.holeRoom()).toBe(false);
    requests.drop('cell', '0,5');
    expect(requests.holeRoom()).toBe(true);
  });
});

describe('the levels asked of the workers', () => {
  it('hold their bytes in the upload queue from the ask: the jobs in flight never bring it past its ceiling by more than one', () => {
    const renderer = { render: () => {}, getRenderTarget: () => null, setRenderTarget: () => {}, autoClear: true } as unknown as WebGLRenderer;
    drainWarm(renderer);
    let id = 0;
    const pool = { run: () => ++id, supersede: () => {}, cancel: () => {} } as unknown as CellPool;
    const level = 10 * 1024 * 1024;
    const requests = new CellRequests(pool, {} as BuildingKit, () => {}, () => true, () => 0, () => level);
    const env = {} as CellEnv;
    let asked = 0, most = 0;
    for (let i = 0; i < 40; i++) {
      requests.want('cell', `${i},9`, [], env, true);
      if (requests.isAsked('cell', `${i},9`)) asked++;
      most = Math.max(most, warmQueuedBytes() + warmReservedBytes());
    }
    // Asked while the queue and the jobs in flight are under the ceiling: about 64 MiB of 10 MiB levels, not all forty.
    expect(asked).toBe(Math.floor(WARM_CEILING / level) + 1);
    expect(most).toBeLessThanOrEqual(WARM_CEILING + level);
    // Let go, their bytes are let go too: the next ones are asked.
    for (let i = 0; i < 40; i++) requests.drop('cell', `${i},9`);
    expect(warmReservedBytes()).toBe(0);
    requests.want('cell', '50,9', [], env, true);
    expect(requests.isAsked('cell', '50,9')).toBe(true);
    requests.drop('cell', '50,9');
  });
});

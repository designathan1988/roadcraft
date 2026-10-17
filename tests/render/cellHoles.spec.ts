import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, type WebGLRenderer } from 'three';
import type { CellEnv, CellPool } from '@render/buildings/cellPool';
import type { BuildingKit } from '@render/buildings/kit';
import { CellRequests, MOST_HOLES } from '@render/buildings/cellRequests';
import { cancelWarm, drainWarm, warmFull, warmLooseAhead } from '@render/uploads';

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
});

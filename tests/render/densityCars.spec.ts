import { describe, expect, it } from 'vitest';
import type { BufferAttribute, InstancedBufferGeometry, Mesh } from 'three';
import { createDensityCars } from '@render/densityCars';
import { ML, MESO_PRESENT, MesoDeltaBuilder, type MesoDelta } from '@sim/meso/memory';
import { linkId } from '@sim/meso/tileLinks';
import { TILE } from '@world/tiles';
import { m } from '@world/units';
import type { Network } from '@world/network';
import type { SimClient } from '@sim/host/simClient';

/** THE FAR CARS: a mesh a tile, culled by the tile's sphere; a meso delta writes only the tiles whose links changed (`densityCars.ts`, R15) */

/** A far road (not on the page) appended to a delta: its slot's record, its middle at (x, y), `count` cars on it, its line's serial `shape` (0: unchanged). */
function road(out: MesoDeltaBuilder, slot: number, x: number, y: number, count: number, shape: number, link = linkId(slot + 1, 0)): void {
  const at = out.push(slot, link), r = out.recordsNow;
  r[at + ML.count] = count; r[at + ML.queued] = 0; r[at + ML.speed] = m(10); r[at + ML.length] = m(200); r[at + ML.lanes] = 1; r[at + ML.flags] = MESO_PRESENT;
  r[at + ML.ax] = x - m(100); r[at + ML.ay] = y; r[at + ML.mx] = x; r[at + ML.my] = y; r[at + ML.bx] = x + m(100); r[at + ML.by] = y;
  r[at + ML.shape] = shape;
}

/** A page's client that hands the far cars the deltas queued, and notes the windows asked. */
function client(): { sim: SimClient; send(d: MesoDelta | null): void; wholes: boolean[] } {
  let queue: MesoDelta[] = [];
  const wholes: boolean[] = [];
  const sim = {
    window: (_x: number, _y: number, _r: number, whole: boolean) => { wholes.push(whole); },
    takeMeso: () => { const q = queue; queue = []; return q; },
    clock: { time: 0 },
  } as unknown as SimClient;
  return { sim, send: (d) => { if (d) queue.push(d); }, wholes };
}

const net = { state: {}, changesSince: () => ({ segments: [] }), ribbons: new Map() } as unknown as Network;

describe('the far cars', () => {
  it('are a mesh a tile, and a delta that changes one link writes only its tile', () => {
    const cars = createDensityCars(() => 0);
    const { sim, send, wholes } = client();
    cars.update(net, sim, 0, 0);
    // The first window asks for every link.
    expect(wholes).toEqual([true]);
    const out = new MesoDeltaBuilder();
    out.startWhole();
    road(out, 0, TILE * 0.5, TILE * 0.5, 4, 1);
    road(out, 1, TILE * 3.5, TILE * 0.5, 6, 2);
    out.end(2, 0, 0, 0, 0);
    send(out.take());
    cars.update(net, sim, 0, 0);
    const meshes = cars.object.children as Mesh[];
    expect(meshes.length).toBe(2);
    const counts = meshes.map((mesh) => (mesh.geometry as InstancedBufferGeometry).instanceCount).sort();
    expect(counts).toEqual([4, 6]);
    // Each culled by its own tile's sphere.
    for (const mesh of meshes) {
      const sphere = mesh.geometry.boundingSphere!;
      expect(mesh.frustumCulled).toBe(true);
      expect(Math.abs(sphere.center.x % TILE)).toBeCloseTo(TILE / 2, 3);
    }
    const versions = (): number[] => meshes.map((mesh) => (mesh.geometry.getAttribute('aLink') as BufferAttribute).version);
    const before = versions();
    // A delta with the second road's count changed (its line not): its tile written again, the first one's left as it was.
    road(out, 1, TILE * 3.5, TILE * 0.5, 3, 0);
    out.end(2, 0, 0, 0, 0);
    send(out.take());
    cars.update(net, sim, 0, 0);
    const after = versions();
    const second = meshes.findIndex((mesh) => (mesh.geometry as InstancedBufferGeometry).instanceCount === 3);
    expect(second).toBeGreaterThanOrEqual(0);
    expect(after[second]).toBeGreaterThan(before[second]!);
    expect(after[1 - second]).toBe(before[1 - second]);
    // A step that changed no link sends none, and writes nothing.
    out.end(2, 0, 0, 0, 0);
    send(out.take());
    cars.update(net, sim, 0, 0);
    expect(versions()).toEqual(after);
    cars.dispose();
  });

  it('hold a mesh only for the tiles their window has roads in, however far the camera has gone', () => {
    const cars = createDensityCars(() => 0);
    const { sim, send } = client();
    cars.update(net, sim, 0, 0);
    const out = new MesoDeltaBuilder();
    // The worker's window walks 60 tiles east: its 8 slots hold the roads of the 2 x 2 tiles about it, each step other links.
    let serial = 0, link = 0;
    for (let step = 0; step < 60; step++) {
      for (let slot = 0; slot < 8; slot++) road(out, slot, TILE * (step + (slot % 2) + 0.5), TILE * ((slot >> 1) % 2 + 0.5), 3, ++serial, linkId(++link, 0));
      out.end(8, 0, 0, 0, 0);
      send(out.take());
      cars.update(net, sim, TILE * step, 0);
      expect(cars.object.children.length, `step ${step}`).toBeLessThanOrEqual(4);
    }
    cars.dispose();
  });

  it('take a whole delta in place of everything they had: a link not in it is gone', () => {
    const cars = createDensityCars(() => 0);
    const { sim, send } = client();
    cars.update(net, sim, 0, 0);
    const out = new MesoDeltaBuilder();
    road(out, 0, TILE * 0.5, TILE * 0.5, 4, 1);
    road(out, 1, TILE * 3.5, TILE * 0.5, 6, 2);
    out.end(2, 0, 0, 0, 0);
    send(out.take());
    cars.update(net, sim, 0, 0);
    const drawn = (): number => (cars.object.children as Mesh[]).reduce((n, mesh) => n + (mesh.visible ? (mesh.geometry as InstancedBufferGeometry).instanceCount : 0), 0);
    expect(drawn()).toBe(10);
    // Another map: the worker sends every link it has, only the first road now.
    out.startWhole();
    road(out, 0, TILE * 0.5, TILE * 0.5, 4, 3);
    out.end(1, 0, 0, 0, 0);
    send(out.take());
    cars.update(net, sim, 0, 0);
    expect(drawn()).toBe(4);
    cars.dispose();
  });
});

describe('a far tile let go (AGT-17)', () => {
  it("frees its own buffers only, never the car's shape every tile draws", () => {
    const cars = createDensityCars(() => 0);
    const { sim, send } = client();
    cars.update(net, sim, 0, 0);
    const out = new MesoDeltaBuilder();
    road(out, 0, TILE * 0.5, TILE * 0.5, 4, 1);
    road(out, 1, TILE * 3.5, TILE * 0.5, 6, 2);
    out.end(2, 0, 0, 0, 0);
    send(out.take());
    cars.update(net, sim, 0, 0);
    const [a, b] = cars.object.children as Mesh[];
    const shared = { index: a!.geometry.index, position: a!.geometry.getAttribute('position') };
    expect(b!.geometry.index).toBe(shared.index);
    const gone = b!.geometry;
    let disposedWith: unknown[] | null = null;
    gone.addEventListener('dispose', () => { disposedWith = [gone.index, gone.getAttribute('position'), gone.getAttribute('normal')]; });
    // The second slot's road now another one, in the first road's tile: the second tile left with none, let go.
    road(out, 1, TILE * 0.6, TILE * 0.5, 6, 3, linkId(7, 0));
    out.end(2, 0, 0, 0, 0);
    send(out.take());
    cars.update(net, sim, 0, 0);
    // Disposed with none of the shape on it: three frees what a disposed geometry holds (r186 WebGLGeometries).
    expect(disposedWith).toEqual([null, undefined, undefined]);
    expect(a!.geometry.index).toBe(shared.index);
    expect(a!.geometry.getAttribute('position')).toBe(shared.position);
    cars.dispose();
  });
});

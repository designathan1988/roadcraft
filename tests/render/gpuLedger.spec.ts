import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry } from 'three';

import { GpuLedger, deviceGpuCap, geometryCost, gpuLedger, integratedGpu } from '@render/gpuLedger';
import { cellMass } from '@render/buildings/cellArrays';
import type { CellEnv, CellPool } from '@render/buildings/cellPool';
import { CellRequests } from '@render/buildings/cellRequests';
import type { CellEntry, CellResult } from '@render/buildings/cellWork';
import { createBuildingKit } from '@render/buildings/kit';
import { createMassCells } from '@render/buildings/massCells';
import { emitMassing } from '@render/buildings/massing';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { m } from '@world/units';

/** THE GPU'S BYTES IN ONE BOOK (`render/gpuLedger.ts`): every owner registers, the cap comes from the device, selection asks before it requests */

const GiB = 2 ** 30;
const UHD_770 = 'ANGLE (Intel, Intel(R) UHD Graphics 770 (0x00004680) Direct3D11 vs_5_0 ps_5_0, D3D11)';
/** 1920 x 1080 drawn at 1.5 (the high tier's pixel ratio). */
const HIGH_1080 = 2880 * 1620;

describe('the ledger', () => {
  it('sums bytes and triangles by class, an owner set again replacing what it held, and leaves the rest of the cap to a class', () => {
    const book = new GpuLedger();
    book.set('a', 'cell masses', 100, 10);
    book.set('b', 'cell masses', 50, 5);
    book.set('t', 'render targets', 300);
    book.set('d', 'building detail', 200, 20);
    expect(book.bytes()).toBe(650);
    expect(book.bytes('cell masses')).toBe(150);
    expect(book.triangles('cell masses')).toBe(15);
    expect(book.triangles()).toBe(35);
    book.set('a', 'cell masses', 40, 4);
    expect(book.bytes('cell masses')).toBe(90);
    book.remove('b');
    book.remove('b');
    expect(book.bytes('cell masses')).toBe(40);
    expect(book.roomFor(['building detail'])).toBe(Infinity);
    book.cap = 1000;
    // The detail may hold what the masses and the targets leave: 1000 - 40 - 300.
    expect(book.roomFor(['building detail', 'building facade'])).toBe(660);
  });

  it('counts a geometry by its arrays, or by what they were once let go', () => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(12), 3));
    g.setIndex(new BufferAttribute(new Uint16Array(6), 1));
    expect(geometryCost(g)).toEqual({ bytes: 48 + 12, triangles: 2 });
  });
});

describe('the cap from the device', () => {
  it('tells an integrated GPU from a discrete card by its name', () => {
    expect(integratedGpu(UHD_770)).toBe(true);
    expect(integratedGpu('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(true);
    expect(integratedGpu('Apple M2')).toBe(true);
    expect(integratedGpu('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(false);
    expect(integratedGpu('ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(false);
  });

  it('on an iGPU, a quarter of the system memory, never past the per-pixel budget of the window', () => {
    expect(deviceGpuCap({ memoryGB: 8, renderer: UHD_770, pixels: HIGH_1080 })).toBeCloseTo(2 * GiB, -3);
    expect(deviceGpuCap({ memoryGB: 16, renderer: UHD_770, pixels: HIGH_1080 })).toBeCloseTo(3 * GiB, -3);
    expect(deviceGpuCap({ memoryGB: 32, renderer: UHD_770, pixels: HIGH_1080 })).toBeCloseTo(3 * GiB, -3);
    // A 4K window drawn at 1.5 is allowed four times the pixels' bytes: the system's share bounds it.
    expect(deviceGpuCap({ memoryGB: 32, renderer: UHD_770, pixels: 4 * HIGH_1080 })).toBeCloseTo(8 * GiB, -3);
    // Memory not said: 8 GB assumed.
    expect(deviceGpuCap({ memoryGB: null, renderer: UHD_770, pixels: HIGH_1080 })).toBeCloseTo(2 * GiB, -3);
  });

  it('on a discrete card, three quarters of 4 GB; never under the floor', () => {
    expect(deviceGpuCap({ memoryGB: 8, renderer: 'NVIDIA GeForce RTX 3060', pixels: 4 * HIGH_1080 })).toBeCloseTo(3 * GiB, -3);
    expect(deviceGpuCap({ memoryGB: 8, renderer: UHD_770, pixels: 640 * 360 })).toBe(512 * 2 ** 20);
  });
});

function building(index: number, x: number, y: number): Building {
  const bp = BLUEPRINTS[index % BLUEPRINTS.length]!;
  return { ...JSON.parse(JSON.stringify(bp.body)), id: index + 1, x, y, rotation: 0 } as Building;
}

describe('the owners in the ledger', () => {
  it('a cell of masses registers what it sends to the GPU, and takes it back when it goes', () => {
    const kit = createBuildingKit();
    const cells = createMassCells(kit, m(256));
    const before = gpuLedger.bytes('cell masses');
    const mass = cellMass([0, 1].map((i) => emitMassing(building(i, m(20) + i * m(40), m(20)), () => 0)!))!;
    const expected = mass.position.byteLength + mass.normal.byteLength + mass.color.byteLength + mass.facade.byteLength + mass.glazing.byteLength + mass.index.byteLength;
    cells.land('0,0', mass);
    expect(gpuLedger.bytes('cell masses') - before).toBe(expected);
    expect(gpuLedger.triangles('cell masses')).toBeGreaterThan(0);
    cells.remove('0,0');
    expect(gpuLedger.bytes('cell masses')).toBe(before);
    cells.dispose();
    kit.dispose();
  });

  it('a cell level landed and not admitted is never wrapped nor uploaded, and is asked again only when wanted again', () => {
    const asked: string[] = [];
    let next = 1;
    const pool = {
      run(_kind: string, cell: string, _entries: readonly CellEntry[], _env: CellEnv, done: (r: CellResult) => void) {
        asked.push(cell);
        done({ batch: null, details: [], summaries: [], mass: null });
        return next++;
      },
      cancel() {},
      supersede() {},
      isRunning() { return false; },
    } as unknown as CellPool;
    const kit = createBuildingKit();
    const admitted: [string, string, number][] = [];
    let room = false;
    const requests = new CellRequests(pool, kit, () => {}, (kind, cell, bytes) => { admitted.push([kind, cell, bytes]); return room; });
    const entries: CellEntry[] = [{ key: '1', sig: 1, digest: 1 }];
    const env = { groundAt: () => 0, naturalAt: () => 0 } as CellEnv;
    expect(requests.want('cell', '0,0', entries, env, true)).toBeNull();
    expect(admitted).toEqual([['cell', '0,0', 0]]);
    expect(requests.waiting).toBe(0);
    room = true;
    expect(requests.want('cell', '0,0', entries, env, true)).not.toBeNull();
    expect(asked).toEqual(['0,0', '0,0']);
    requests.clear();
    kit.dispose();
  });
});

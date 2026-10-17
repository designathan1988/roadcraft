import { describe, expect, it } from 'vitest';
import { DataUtils } from 'three';

import { MASS_FACADE, MASS_GRID, cellMass } from '@render/buildings/cellArrays';
import { createBuildingKit } from '@render/buildings/kit';
import { cellMesh } from '@render/buildings/massCells';
import { emitMassing } from '@render/buildings/massing';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';

/** A MASS VERTEX IS 44 BYTES, AND THE SHADER READS FROM IT WHAT IT READ FROM THE 52 (`cellArrays.ts` `CellMass`, `massingMaterial.ts`) */

const building = (n: number): Building => ({ ...JSON.parse(JSON.stringify(BLUEPRINTS[n % BLUEPRINTS.length]!.body)), id: n + 1, x: n * 60, y: 30, rotation: n * 0.3 }) as Building;

describe('a mass vertex', () => {
  it('holds in 44 bytes what the masses\' shader reads, the long and the high in full floats', () => {
    const chunks = [0, 3, 4, 6, 8].map((n) => emitMassing(building(n), (x, y) => x * 0.01 + y * 0.02)!);
    const mass = cellMass(chunks)!;
    const vertices = mass.position.length / 3;
    const bytes = mass.position.byteLength + mass.normal.byteLength + mass.color.byteLength + mass.facade.byteLength + mass.grid.byteLength + mass.seed.byteLength;
    expect(bytes / vertices).toBe(44);
    let v = 0;
    for (const c of chunks) {
      for (let k = 0; k < c.position.length / 3; k++, v++) {
        // What the vertex shader makes of it (`vFacade`, `vGlazing`, `vColor`).
        const half = (i: number): number => DataUtils.fromHalfFloat(mass.grid[v * MASS_GRID + i]!);
        const facade = [mass.facade[v * MASS_FACADE]!, half(0), half(1), mass.facade[v * MASS_FACADE + 1]!];
        const glazing = [half(2), mass.seed[v]!];
        expect(facade[0]).toBe(Math.fround(c.facade[k * 4]!));
        expect(facade[3]).toBe(Math.fround(c.facade[k * 4 + 3]!));
        for (const i of [1, 2]) expect(Math.abs(facade[i]! - c.facade[k * 4 + i]!)).toBeLessThanOrEqual(Math.abs(c.facade[k * 4 + i]!) / 1024);
        expect(Math.abs(glazing[0]! - c.glazing[k * 2]!)).toBeLessThanOrEqual(1 / 1024);
        // The seed whole: each lit window's lot is drawn from its fraction.
        expect(glazing[1]).toBe(Math.fround(c.glazing[k * 2 + 1]!));
        for (let ch = 0; ch < 3; ch++) {
          const was = c.colour[k * 3 + ch]!;
          expect(Math.abs(DataUtils.fromHalfFloat(mass.color[v * 4 + ch]!) - was)).toBeLessThanOrEqual(Math.max(was, 1e-3) / 1024);
        }
      }
    }
  });

  it('is drawn from its half floats as half floats, its full ones as floats', () => {
    const kit = createBuildingKit();
    const mass = cellMass([emitMassing(building(3), () => 0)!])!;
    const g = cellMesh(mass, kit).geometry;
    const flagged = (name: string): boolean => (g.getAttribute(name) as { isFloat16BufferAttribute?: boolean }).isFloat16BufferAttribute === true;
    expect(flagged('color')).toBe(true);
    expect(flagged('facadeGrid')).toBe(true);
    expect(flagged('facade')).toBe(false);
    expect(flagged('glazingSeed')).toBe(false);
    expect(g.getAttribute('facade').itemSize).toBe(MASS_FACADE);
    expect(g.getAttribute('facadeGrid').itemSize).toBe(MASS_GRID);
    expect(g.getAttribute('color').itemSize).toBe(4);
    kit.dispose();
  });
});

describe('a mass\'s slabs', () => {
  it('share their corners between their triangles: a roof slab is its points once, not three a triangle', () => {
    for (const n of [0, 3, 4, 6, 8]) {
      const chunk = emitMassing(building(n), () => 0)!;
      const up = (v: number): boolean => chunk.normal[v * 3 + 1]! > 0.9999;
      // The flat faces' triangles and the points they are drawn from: shared, fewer points than three a triangle.
      const used = new Set<number>();
      let triangles = 0;
      for (let t = 0; t < chunk.index.length; t += 3) {
        const corners = [chunk.index[t]!, chunk.index[t + 1]!, chunk.index[t + 2]!];
        if (!corners.every(up)) continue;
        triangles++;
        for (const c of corners) used.add(c);
      }
      expect(triangles, `building ${n}`).toBeGreaterThan(0);
      expect(used.size, `building ${n}`).toBeLessThan(triangles * 3);
    }
  });
});

describe('a lot\'s plate in the masses', () => {
  it('is its corners once: a paved lot of four corners is four points and two triangles', () => {
    const b = building(0);
    // Its one block made a paved lot: the masses draw its plate alone (`emitLotPlates`).
    b.volumes = [{ ...b.volumes[0]!, open: 'paving' }];
    const chunk = emitMassing(b, () => 0)!;
    expect(chunk.index.length / 3).toBe(2);
    expect(chunk.position.length / 3).toBe(4);
  });
});

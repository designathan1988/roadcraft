import { describe, expect, it } from 'vitest';
import { Frustum, Matrix4, OrthographicCamera } from 'three';
import { createBuildingKit } from '@render/buildings/kit';
import { cellMass } from '@render/buildings/cellArrays';
import { createMassCells } from '@render/buildings/massCells';
import { emitMassing } from '@render/buildings/massing';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { m } from '@world/units';

/** THE DETAIL DRAWN WITHIN ITS BYTES (`massCells.ts` `cap`, the brief: detail residency capped in bytes, falling back to L1) */

const CELL = m(256);

/** Five cells in a row east of the origin, each with a building's masses, chosen near and at full detail from an eye over the first. */
function row(): ReturnType<typeof createMassCells> {
  const cells = createMassCells(createBuildingKit(), CELL);
  for (let i = 0; i < 5; i++) {
    const bp = BLUEPRINTS[0]!;
    const b = { ...JSON.parse(JSON.stringify(bp.body)), id: i + 1, x: (i + 0.5) * CELL, y: CELL / 2, rotation: 0 } as Building;
    cells.land(`${i},0`, cellMass([emitMassing(b, () => 0)!]));
  }
  // From above, 10 px a metre: every cell's detail is wanted.
  cells.choose(CELL / 2, CELL / 2, m(300), 1000, 10, false, Infinity);
  return cells;
}

const bytesOf = (_key: string, fine: boolean): number => (fine ? 100 : 40);

describe('the detail drawn', () => {
  it('stays as chosen within its budget', () => {
    const cells = row();
    for (let i = 0; i < 5; i++) expect([cells.near(`${i},0`), cells.fine(`${i},0`)]).toEqual([true, true]);
    cells.cap(CELL / 2, CELL / 2, 500, bytesOf, false);
    for (let i = 0; i < 5; i++) expect(cells.fine(`${i},0`)).toBe(true);
    cells.dispose();
  });

  it('over its budget, the farthest cells fall back to their facade level first, then to their masses; the nearest keeps its detail', () => {
    const cells = row();
    cells.cap(CELL / 2, CELL / 2, 260, bytesOf, false);
    expect(cells.fine('0,0')).toBe(true);
    for (let i = 1; i < 5; i++) expect([cells.near(`${i},0`), cells.fine(`${i},0`)]).toEqual([true, false]);
    cells.dispose();

    const tight = row();
    tight.cap(CELL / 2, CELL / 2, 150, bytesOf, false);
    for (let i = 0; i < 3; i++) expect([tight.near(`${i},0`), tight.fine(`${i},0`)]).toEqual([true, false]);
    for (let i = 3; i < 5; i++) expect(tight.near(`${i},0`)).toBe(false);
    tight.dispose();
  });

  it('gives two cells as far from the camera on either side of the eye the same level under the budget', () => {
    const cells = createMassCells(createBuildingKit(), CELL);
    for (const i of [-1, 0, 1]) {
      const b = { ...JSON.parse(JSON.stringify(BLUEPRINTS[0]!.body)), id: i + 2, x: (i + 0.5) * CELL, y: CELL / 2, rotation: 0 } as Building;
      cells.land(`${i},0`, cellMass([emitMassing(b, () => 0)!]));
    }
    // A perspective eye over the middle cell: the two others the same distance off, west and east.
    cells.choose(CELL / 2, CELL / 2, m(120), 1000, null, false, Infinity);
    for (const key of ['-1,0', '0,0', '1,0']) expect(cells.near(key)).toBe(true);
    // Room for the middle one's detail and one more: the budget does not pick one side.
    cells.cap(CELL / 2, CELL / 2, 260, bytesOf, false);
    expect([cells.near('-1,0'), cells.fine('-1,0')]).toEqual([cells.near('1,0'), cells.fine('1,0')]);
    expect(cells.fine('0,0')).toBe(true);
    cells.dispose();
  });

  it('never moves a cell forced near (the one being edited)', () => {
    const cells = row();
    cells.cap(CELL / 2, CELL / 2, 0, bytesOf, new Set(['4,0']));
    expect([cells.near('4,0'), cells.fine('4,0')]).toEqual([true, true]);
    cells.dispose();
  });
});

describe('the detail and the view', () => {
  it('gives no detail to a cell the view does not meet, however many pixels a metre spans (the view from above)', () => {
    const cells = createMassCells(createBuildingKit(), CELL);
    for (let i = 0; i < 5; i++) {
      const b = { ...JSON.parse(JSON.stringify(BLUEPRINTS[0]!.body)), id: i + 1, x: (i + 0.5) * CELL, y: CELL / 2, rotation: 0 } as Building;
      cells.land(`${i},0`, cellMass([emitMassing(b, () => 0)!]));
    }
    // Straight down over the first cell, 200 m across (three's axes: map y is -z).
    const camera = new OrthographicCamera(-100, 100, 100, -100, 1, 2000);
    camera.position.set(CELL / 2, 1000, -CELL / 2);
    camera.lookAt(CELL / 2, 0, -CELL / 2);
    camera.updateMatrixWorld();
    const view = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    cells.choose(CELL / 2, CELL / 2, m(1000), 1000, 10, false, Infinity, view);
    expect(cells.near('0,0')).toBe(true);
    for (let i = 2; i < 5; i++) expect(cells.near(`${i},0`)).toBe(false);
    cells.dispose();
  });
});

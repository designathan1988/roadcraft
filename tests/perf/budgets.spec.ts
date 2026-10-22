import { MeshBasicMaterial, type BufferGeometry, type Mesh } from 'three';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Budget } from '@core/perfBudget';
import { COUNT_BUDGETS, withinBudget } from './support/countBudgets';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { buildDefaultTown } from '../world/support/town/defaultTown';
import { buildingPads, padsWork } from '@world/buildings/pads';
import { kerbward, kerbWork } from '@world/poleLines';
import { buildRoadElevation } from '@world/elevation';
import { buildRoadSurfaces } from '@render/roadSurfaces';
import type { SceneMaterials } from '@render/materials';
import { m } from '@world/units';

/** THE PERFORMANCE BUDGETS, COUNTED (`core/perfBudget.ts` COUNT_BUDGETS) */

const materials = new Proxy({}, { get: (_t, key) => key === 'scale' ? new Proxy({}, { get: () => 4 }) : new MeshBasicMaterial() }) as unknown as SceneMaterials;
const report = (name: string, value: number, budget: Budget): void => {
  expect(withinBudget(value, budget), `${name} = ${value} (budget ${budget.min ?? '-'}..${budget.max}: ${budget.why})`).toBe(true);
};

describe('performance budgets, counted', () => {
  const doc = new RoadDoc();
  buildDefaultTown(doc);
  const net = new Network(doc);
  net.rebuild();
  const ground = (x: number, y: number): number => 2 * Math.sin(x / 37) + 1.3 * Math.cos(y / 23);
  const pads = buildingPads([...doc.buildings.all()], ground, undefined, m(6.4));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of pads.shapeBounds()) { x0 = Math.min(x0, b.minX); y0 = Math.min(y0, b.minY); x1 = Math.max(x1, b.maxX); y1 = Math.max(y1, b.maxY); }

  it('grades the ground to the platforms measuring few rings a corner', () => {
    padsWork.rings = 0;
    let corners = 0;
    for (let y = y0; y <= y1; y += m(2)) for (let x = x0; x <= x1; x += m(2)) { pads.shapeAt(x, y, ground(x, y)); corners++; }
    report('rings per corner', padsWork.rings / corners, COUNT_BUDGETS.padRingsPerCorner);
  });

  it('finds the kerb nearest a pole walking few edges', () => {
    kerbWork.edges = 0;
    let asks = 0;
    for (let y = y0; y <= y1; y += m(8)) for (let x = x0; x <= x1; x += m(8)) { kerbward(net, { x, y }, m(6)); asks++; }
    report('edges per ask', kerbWork.edges / asks, COUNT_BUDGETS.kerbEdgesPerAsk);
  });

  it("files the town's crossing surface in a small grid", () => {
    report('crossing cells', net.crossingSurface().cells, COUNT_BUDGETS.townWalkableCells);
  });

  it('draws the fixed scene with its detail, in few meshes', () => {
    const fixture = RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/grid-and-bends.json', 'utf8')).document);
    const fnet = new Network(fixture);
    fnet.rebuild();
    const surfaces = buildRoadSurfaces(fnet, buildRoadElevation(fnet, () => 0), materials, () => 0);
    let triangles = 0, meshes = 0;
    surfaces.group.traverse((o) => {
      const g = (o as Mesh).geometry as BufferGeometry | undefined;
      if (!g) return;
      meshes++;
      triangles += (g.getIndex()?.count ?? g.getAttribute('position').count) / 3;
    });
    report('road triangles', triangles, COUNT_BUDGETS.fixtureRoadTriangles);
    report('road meshes', meshes, COUNT_BUDGETS.fixtureRoadMeshes);
  });
});

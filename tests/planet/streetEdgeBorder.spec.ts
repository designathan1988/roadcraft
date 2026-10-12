import { MeshBasicMaterial, Vector3, type BufferGeometry, type Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import { U, acrossBorders } from './_border';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { TILES_PER_SIDE } from '@core/planetTiles';
import { tileCentre } from '@world/planet/atlas';
import { chartAt, onChartOf, toOwner } from '@world/planet/charts';
import { buildRoadElevation } from '@world/elevation';
import { onFootway } from '@world/poleLines';
import type { SceneMaterials } from '@render/materials';
import { buildRoadSurfaces } from '@render/roadSurfaces';
import { commitRoadPath } from '@editor/commit';
import { commitPoleRunPoles, planPoleRun } from '@editor/poles';

/**
 * A STREET OVER THE PIECES' BORDERS, ITS EDGE AND ITS POLE LINE
 * (`render/roadSurfaces.ts` the verge's footway edges, `world/poleLines.ts`
 * the contours, `editor/poles.ts` one chart a run). The part of a street on
 * the next piece is built and asked on that piece's chart, and what was kept
 * only on the street's own was not found there: the grass verge fell flat
 * to the ground (a brick wall of footway skirt along the street past the
 * border) and a pole line along its footway was refused, "poles only on
 * footways" (the tools over a border, 2026-10-11). Run with
 * `vitest.planet.config.ts`.
 */

const materials = new Proxy({}, {
  get: (_target, key) => key === 'scale' ? new Proxy({}, { get: () => 4 }) : new MeshBasicMaterial(),
}) as unknown as SceneMaterials;

for (const [where, chart, dir] of [
  ['on one face of the cube', 2 * TILES_PER_SIDE * TILES_PER_SIDE + 5 * TILES_PER_SIDE + 5, 1],
  ['over an edge of the cube', 3 * TILES_PER_SIDE * TILES_PER_SIDE + 1 * TILES_PER_SIDE + 1, -1],
] as const) {
  const c = tileCentre(chart);
  const along = acrossBorders(chart, dir, 0);
  const at = (x: number, y: number) => toOwner(chart, { x: c.x + dir * along(x), y: c.y + y * U });
  const street = (): { doc: RoadDoc; net: Network } => {
    const doc = new RoadDoc();
    doc.setBalance(1e9);
    const net = new Network(doc);
    net.rebuild();
    const a = at(-100, 0), b = onChartOf(at(1100, 0), a);
    expect(commitRoadPath(doc, net, { kind: 'free', at: a }, { kind: 'free', at: b }, 1,
      [{ start: { at: a, heightOffset: 0 }, end: { at: b, heightOffset: 0 }, curve: null }]).committed).toBe(true);
    if (net.revision !== doc.revision) net.rebuild();
    return { doc, net };
  };

  describe(`a street across the borders, ${where}`, () => {
    it('keeps its grass verge up to the footway on every piece', () => {
      const { net } = street();
      // The drawn ground a metre under the road's own: the verge must climb it.
      const elevation = buildRoadElevation(net, () => 0);
      const surfaces = buildRoadSurfaces(net, elevation, materials, () => -1, undefined, new MeshBasicMaterial());
      surfaces.group.updateMatrixWorld(true);
      // The footway's top where it ends, by place; then the verge's inner edge on it.
      const key = (x: number, z: number): string => `${Math.round(x * 50)}:${Math.round(z * 50)}`;
      const footwayTop = new Map<string, number>();
      const vergeTop = new Map<string, number>();
      const v = new Vector3();
      surfaces.group.traverse((o) => {
        const footway = o.name.startsWith('footway'), isVerge = o.name.startsWith('verge');
        if (!footway && !isVerge) return;
        const p = ((o as Mesh).geometry as BufferGeometry).getAttribute('position');
        for (let i = 0; i < p.count; i++) {
          v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
          if (footway) footwayTop.set(key(v.x, v.z), Math.max(footwayTop.get(key(v.x, v.z)) ?? -Infinity, v.y));
          else vergeTop.set(key(v.x, v.z), Math.max(vergeTop.get(key(v.x, v.z)) ?? -Infinity, v.y));
        }
      });
      let met = 0, worst = 0;
      for (const [k, y] of vergeTop) {
        const top = footwayTop.get(k);
        if (top === undefined) continue;
        // The verge's top on the footway's outer edge: at the footway's height, not down on the ground.
        worst = Math.max(worst, Math.abs(top - y));
        met++;
      }
      expect(met).toBeGreaterThan(50);
      expect(worst).toBeLessThan(0.25);
    });

    it('takes a pole line along its footway over every border, each pole on its own piece', () => {
      const { doc, net } = street();
      const charts = new Set<number>();
      for (let x = 0; x <= 900; x += 150) {
        const from = at(x, 13), to = at(x + 140, 13);
        const plan = planPoleRun(doc, net, from, to, 8 * U);
        expect(plan.refused, `from ${x}`).toBeUndefined();
        const ids = commitPoleRunPoles(doc, plan);
        expect(ids, `from ${x}`).not.toBeNull();
        for (const id of ids!) {
          const pole = doc.pole(id)!;
          // Written on the chart of the piece it stands on, and on the footway.
          const own = chartAt(pole.x, pole.y);
          const back = toOwner(own, pole);
          expect(Math.hypot(back.x - pole.x, back.y - pole.y)).toBeLessThan(1e-6);
          expect(onFootway(net, pole)).toBe(true);
          charts.add(own);
        }
      }
      expect(charts.size).toBeGreaterThan(2);
    });
  });
}

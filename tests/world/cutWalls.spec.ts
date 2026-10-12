import { describe, expect, it } from 'vitest';
import { InstancedMesh, Matrix4, MeshBasicMaterial, Quaternion, Vector3, type Mesh } from 'three';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { CUT_WALL_REACH, buildRoadElevation } from '@world/elevation';
import { TerrainIndex, sampleTerrainHeight } from '@world/terrain';
import { casingHalf } from '@world/roadTypes';
import { ROAD_TUNING } from '@world/roads/tuning';
import { PORTAL_COPING, buildStructureDetails } from '@render/structures';
import { TUNNEL_ARCH, TUNNEL_BORE, TUNNEL_HEADROOM } from '@world/structures';
import type { SceneMaterials } from '@render/materials';

/**
 * A CUTTING HELD BY RETAINING WALLS (docs/VIAS.md V3, `RoadSegment.cutWalls`):
 * saved with the map and absent from every older one; the ground is cut back
 * no wider than the band the wall's backfill covers; the wall stands from
 * under the road to just over the natural ground, and the backfill meets the
 * ground at its edge - nothing floats, nothing is buried, no step shows.
 */
function hillRoad(walls: boolean, strength = 30, tunnel = false) {
  const doc = new RoadDoc();
  doc.addTerrainStamp({ x: 0, y: 0, radius: 150, strength, mode: 'raise' });
  const a = doc.addNode({ x: -500, y: 0 }), b = doc.addNode({ x: 500, y: 0 });
  const seg = doc.addSegment(a.id, b.id, 1)!;
  // At grade through a hill sharper than the grade line smooths: a cutting about 5 m deep in the middle.
  if (walls) doc.setSegmentCutWalls(seg.id, true);
  // As the road tool bores a road this deep (`commit.ts` `boreDeepCuts`).
  if (tunnel) doc.setSegmentStructure(seg.id, 'tunnel');
  const net = new Network(doc);
  net.rebuild();
  const index = new TerrainIndex(doc.terrainStamps, 0, doc.terrainRelief);
  const natural = (x: number, y: number): number => sampleTerrainHeight(index, x, y);
  const elevation = buildRoadElevation(net, natural);
  const shaped = (x: number, y: number): number => {
    const g = natural(x, y);
    const s = elevation.shapeAt(x, y, g);
    return g + (s.height - g) * s.weight;
  };
  return { doc, net, seg, natural, elevation, shaped };
}

const fakeMaterials = (): SceneMaterials => {
  const m = new MeshBasicMaterial();
  return { concrete: m, parapet: m, verge: m, scale: { deck: 8, verge: 8 } } as unknown as SceneMaterials;
};

describe('retaining walls in a cutting', () => {
  it('are saved with the map, and a map without them loads without them', () => {
    const { doc, seg } = hillRoad(true);
    const again = RoadDoc.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    expect(again.requireSegment(seg.id).cutWalls).toBe(true);
    const plain = hillRoad(false);
    expect('cutWalls' in plain.doc.toJSON().segments[0]!).toBe(false);
  });

  it('the ground is cut back no further than the backfill reaches; the batter road cuts wider', () => {
    const walled = hillRoad(true), batter = hillRoad(false);
    const edge = casingHalf(walled.net.ribbons.get(walled.seg.id)!.road);
    const deck = walled.elevation.onSegment(walled.seg.id, 0, 0);
    expect(walled.natural(0, 0) - deck).toBeGreaterThan(ROAD_TUNING.economy.fillFrom * 3);
    // Past the backfill, the natural ground stands untouched beside the walled road...
    const past = edge + CUT_WALL_REACH + 1;
    expect(walled.shaped(0, past)).toBeCloseTo(walled.natural(0, past), 1);
    // ...where the batter still cuts it down.
    expect(batter.shaped(0, past)).toBeLessThan(batter.natural(0, past) - 1);
    // Beside the road, at its level: nothing stands over the deck.
    expect(walled.shaped(0, edge + 1)).toBeLessThanOrEqual(deck);
  });

  it('the wall stands from under the road to over the ground, and its backfill meets the ground', () => {
    const { net, seg, elevation, shaped } = hillRoad(true);
    const details = buildStructureDetails(net, elevation, shaped, fakeMaterials(), new MeshBasicMaterial());
    const face = details.group.getObjectByName('retaining-walls') as Mesh | undefined;
    const lid = details.group.getObjectByName('retaining-wall-backfill') as Mesh | undefined;
    expect(face).toBeDefined();
    expect(lid).toBeDefined();
    const deck = elevation.onSegment(seg.id, 0, 0);
    const edge = casingHalf(net.ribbons.get(seg.id)!.road);
    const heights = (mesh: Mesh): number[] => {
      const p = mesh.geometry.getAttribute('position');
      return Array.from({ length: p.count }, (_, i) => p.getY(i));
    };
    expect(Math.min(...heights(face!))).toBeLessThan(deck);
    // Every backfill vertex sits on the ground at its own point, a hair over it: not floating, not buried.
    const p = lid!.geometry.getAttribute('position');
    // The outer edge lies on the natural ground (within 0.3 units); the inner edge over the dug band.
    const outer: number[] = [];
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = -p.getZ(i), h = p.getY(i);
      const d = Math.abs(y);
      if (d > edge + CUT_WALL_REACH - 2) outer.push(Math.abs(h - shaped(x, y)));
      expect(h).toBeGreaterThanOrEqual(shaped(x, y) - 0.3);
    }
    expect(outer.length).toBeGreaterThan(0);
    expect(Math.max(...outer)).toBeLessThan(0.3);
    details.dispose();
  });

  it('no wall where the road has gone into a bore: walls stand only over an open cutting', () => {
    const { net, seg, elevation, shaped, natural } = hillRoad(true, 120);
    const line = net.ribbons.get(seg.id)!.full;
    let deepest = 0, highestDeck = -Infinity;
    for (let s = 0; s <= line.length; s += 4) {
      const p = line.sampleAt(s).p;
      const deck = elevation.onSegment(seg.id, p.x, p.y);
      deepest = Math.max(deepest, natural(p.x, p.y) - deck);
      highestDeck = Math.max(highestDeck, deck);
    }
    expect(deepest).toBeGreaterThan(TUNNEL_BORE * 2);
    const details = buildStructureDetails(net, elevation, shaped, fakeMaterials(), new MeshBasicMaterial());
    const face = details.group.getObjectByName('retaining-walls') as Mesh | undefined;
    if (face) {
      const p = face.geometry.getAttribute('position');
      for (let i = 0; i < p.count; i++) {
        const deck = elevation.onSegment(seg.id, p.getX(i), 0);
        expect(p.getY(i) - deck).toBeLessThan(TUNNEL_BORE + 1);
      }
    }
    details.dispose();
  });

  it('nothing stands up out of the ground: wall tops and portal wing walls end at the ground beside them', () => {
    for (const strength of [30, 120]) {
      const { net, seg, elevation, shaped } = hillRoad(true, strength, strength === 120);
      const details = buildStructureDetails(net, elevation, shaped, fakeMaterials(), new MeshBasicMaterial());
      // The highest ground across the road at x, out to the backfill's end and a little past.
      const highest = (x: number, y: number, along = 0): number => {
        let top = -Infinity;
        for (let d = -along; d <= along; d += 1) for (let k = 0; k <= 60; k += 1) top = Math.max(top, shaped(x + d, Math.sign(y || 1) * k));
        return top;
      };
      const face = details.group.getObjectByName('retaining-walls') as Mesh | undefined;
      if (face) {
        const p = face.geometry.getAttribute('position');
        for (let i = 0; i < p.count; i++) {
          const x = p.getX(i), y = -p.getZ(i);
          expect(p.getY(i), `wall at ${x.toFixed(0)},${y.toFixed(0)}`).toBeLessThanOrEqual(highest(x, y) + 0.5);
        }
      }
      const jambs = details.group.getObjectByName('tunnel-jambs') as InstancedMesh | undefined;
      if (strength === 120) expect(jambs).toBeDefined();
      if (jambs) {
        const m4 = new Matrix4(), pos = new Vector3(), q = new Quaternion(), sc = new Vector3();
        for (let i = 0; i < jambs.count; i++) {
          jambs.getMatrixAt(i, m4);
          m4.decompose(pos, q, sc);
          const x = pos.x, y = -pos.z, top = pos.y + sc.y / 2;
          const arch = elevation.onSegment(seg.id, x, 0) + TUNNEL_HEADROOM + TUNNEL_ARCH + 1.5;
          const ground = Math.max(shaped(x, y), shaped(x + 4, y), shaped(x - 4, y));
          expect(top, `wing at ${x.toFixed(0)},${y.toFixed(0)}`).toBeLessThanOrEqual(Math.max(arch, ground + PORTAL_COPING) + 0.05);
        }
      }
      details.dispose();
    }
  });
});

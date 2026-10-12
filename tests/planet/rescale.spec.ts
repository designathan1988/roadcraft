import { describe, expect, it } from 'vitest';
import { U, borderShift } from './_border';
import { FACE_HALF, PLANET_RADIUS, type Vec3 } from '@core/cubeSphere';
import { TILE_HALF, sphereToTileInto, tileOfDirection, tileToSphereInto } from '@core/planetTiles';
import { ATLAS_COLUMNS, ATLAS_ROWS, atlasToTileInto, tileCellOf, tileCentre, type TileLocal } from '@world/planet/atlas';
import { RoadDoc } from '@world/doc';
import { placeFor } from '@world/rescale';
import { normalizeSettings, type SavedSettings } from '@editor/persistence';
import { METERS_PER_UNIT, m } from '@world/units';

/** The atlas's pitch in a build of `unit` metres a unit on a planet of faces `half` units across: a reach of 120 m, a grid of 160 m, 80 m to spare. */
const oldPitch = (half: number, unit: number): number =>
  Math.ceil((2 * (TILE_HALF * (half / FACE_HALF) + 120 / unit) + 80 / unit) / (160 / unit)) * (160 / unit);
/** A piece's centre in that build's atlas. */
const oldCentre = (tile: number, pitch: number): { x: number; y: number } =>
  ({ x: ((tile % ATLAS_COLUMNS) - ATLAS_COLUMNS / 2) * pitch, y: (Math.floor(tile / ATLAS_COLUMNS) - ATLAS_ROWS / 2) * pitch });

const where: TileLocal = { tile: 0, x: 0, y: 0 };
const onSphere = (p: { x: number; y: number }): Vec3 => {
  atlasToTileInto(p.x, p.y, where);
  return tileToSphereInto(where.tile, where.x, where.y, { x: 0, y: 0, z: 0 });
};
const arc = (a: { x: number; y: number }, b: { x: number; y: number }): number => {
  const p = onSphere(a), q = onSphere(b);
  return Math.acos(Math.min(1, p.x * q.x + p.y * q.y + p.z * q.z)) * PLANET_RADIUS;
};

/**
 * On the planet a saved map in another unit shrinks (or grows) about the
 * middle of its town on the sphere, never piece by piece: a road across a
 * piece's border keeps its two ends together (docs/ESCALA.md).
 */
describe('a planet map in another unit', () => {
  it('scales every distance about the town, across a piece border', () => {
    const home = tileCellOf(0, 0);
    const c = tileCentre(home);
    // A town straddling the home piece's east border (its owner's map past ~250 units).
    const shift = borderShift(home, 1, 0);
    const town = [{ x: c.x + 150 * U + shift, y: c.y }, { x: c.x + 240 * U + shift, y: c.y + 30 * U }, { x: c.x + 230 * U + shift, y: c.y - 60 * U }];
    const points = [...town];
    const owners = new Set<number>();
    for (const factor of [0.4, 2.5]) {
      const place = placeFor(points, factor);
      for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
          expect(arc(place(points[i]!.x, points[i]!.y), place(points[j]!.x, points[j]!.y))).toBeCloseTo(arc(points[i]!, points[j]!) * factor, 0);
        }
      }
      // Every point comes back written on the piece that owns it.
      for (const p of points) {
        const q = place(p.x, p.y);
        const back = onSphere(q);
        expect(Number.isFinite(back.x)).toBe(true);
        owners.add(tileCellOf(q.x, q.y));
      }
    }
    // Grown 2.5 times, the town reaches past the border onto the neighbour's piece.
    expect(owners.size).toBeGreaterThan(1);
    expect(owners.has(home)).toBe(true);
  });
});

/**
 * A map made on the first planet (faces of 3 000 units: no `planetHalf` in
 * it) opened on today's, 2.5 times larger: its town keeps its size and its
 * place on the sphere (`world/rescale.ts` resizedPlanetPlace).
 */
describe('a map made on the smaller first planet', () => {
  it('opens with its town the same size, where it was on the sphere', () => {
    // That planet's build: 0.4 m a unit (no `unit` in the map either).
    const pitch = oldPitch(3000, 0.4);
    const tile = 2 * 144 + 5 * 12 + 5;
    const oc = oldCentre(tile, pitch);
    // Two nodes 100 units (40 m) apart on the old piece's map, a road between them.
    const old = new RoadDoc();
    const a = old.addNode({ x: 0, y: 0 }).id, b = old.addNode({ x: 0, y: 0 }).id;
    old.addSegment(a, b, 1);
    const saved = old.toJSON() as unknown as { nodes: { x: number; y: number }[]; planetHalf?: number };
    saved.nodes[0]!.x = oc.x + 10; saved.nodes[0]!.y = oc.y;
    saved.nodes[1]!.x = oc.x + 110; saved.nodes[1]!.y = oc.y;
    delete saved.planetHalf;
    delete (saved as { unit?: number }).unit;
    const doc = RoadDoc.fromJSON(saved as never);
    const [p, q] = [...doc.nodes.values()];
    expect(arc(p!, q!)).toBeCloseTo(m(40), 0);
    // Where it was: some 4 and 44 m from the piece's centre.
    expect(arc(p!, tileCentre(tile))).toBeGreaterThan(m(2));
    expect(arc(p!, tileCentre(tile))).toBeLessThan(m(56));
    // And saved again, it says the planet it is on.
    expect((doc.toJSON() as { planetHalf?: number }).planetHalf).toBe(FACE_HALF);
  });
});

/**
 * A map saved at the other unit (0.4 m a unit and 1 m), on the same planet in
 * metres: every point opens where it was on the sphere, whichever piece it
 * lies on and however the atlas's spacing changed with the unit
 * (`world/rescale.ts` reads the old atlas with its own build's measures).
 */
describe('a planet map saved at the other unit', () => {
  it('opens with every point where it was on the sphere', () => {
    const oldUnit = METERS_PER_UNIT === 1 ? 0.4 : 1;
    const oldHalf = (FACE_HALF * METERS_PER_UNIT) / oldUnit;
    const pitch = oldPitch(oldHalf, oldUnit);
    const k = oldHalf / FACE_HALF;
    const home = 2 * 144 + 5 * 12 + 5;
    // A town some 600 m across, over the piece's east border.
    const dirs: Vec3[] = [];
    for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) dirs.push(tileToSphereInto(home, m(-100 + 120 * i), m(-200 + 130 * j), { x: 0, y: 0, z: 0 }));
    const old = new RoadDoc();
    const ids = dirs.map(() => old.addNode({ x: 0, y: 0 }).id);
    for (let i = 0; i + 1 < ids.length; i++) old.addSegment(ids[i]!, ids[i + 1]!, 1);
    const saved = old.toJSON() as unknown as { nodes: { x: number; y: number }[]; unit?: number; planetHalf?: number };
    const at = { x: 0, y: 0 };
    const owners = new Set<number>();
    dirs.forEach((d, i) => {
      const owner = tileOfDirection(d);
      owners.add(owner);
      sphereToTileInto(owner, d, at);
      const c = oldCentre(owner, pitch);
      saved.nodes[i]!.x = c.x + at.x * k;
      saved.nodes[i]!.y = c.y + at.y * k;
    });
    expect(owners.size).toBeGreaterThan(1);
    saved.unit = oldUnit;
    saved.planetHalf = oldHalf;
    const doc = RoadDoc.fromJSON(saved as never);
    const nodes = [...doc.nodes.values()];
    let worst = 0;
    nodes.forEach((n, i) => {
      const p = onSphere(n), d = dirs[i]!;
      worst = Math.max(worst, Math.acos(Math.min(1, p.x * d.x + p.y * d.y + p.z * d.z)) * PLANET_RADIUS);
    });
    // Within a millimetre, in this build's units.
    expect(worst).toBeLessThan(m(0.001));

    // The camera saved with it looks at the same place: written with the size
    // of its planet, or (settings older than the field) read with the size of
    // the map saved beside it.
    const look = saved.nodes[9]!;
    const camera = { x: look.x, y: look.y, zoom: 3 };
    const settings = { camera, paused: false, speed: 1, trafficIntensity: 1, pedestrianIntensity: 1, congestionOverlay: false, unit: oldUnit };
    for (const now of [normalizeSettings({ ...settings, planetHalf: oldHalf } as SavedSettings), normalizeSettings(settings as SavedSettings, oldHalf)]) {
      const p = onSphere(now.camera), d = dirs[9]!;
      expect(Math.acos(Math.min(1, p.x * d.x + p.y * d.y + p.z * d.z)) * PLANET_RADIUS).toBeLessThan(m(0.001));
      expect(now.camera.zoom).toBeCloseTo(3 * METERS_PER_UNIT / oldUnit, 9);
      // Read again, it stays where it is.
      expect(normalizeSettings(now).camera).toEqual(now.camera);
    }
  });
});

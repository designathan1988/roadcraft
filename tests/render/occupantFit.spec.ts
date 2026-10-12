import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ARCHETYPES } from '@sim/vehicles/archetypes';
import {
  CAB_EXTENTS, CHAIR_EXTENTS, REAR_SEATED_EXTENTS, SEATED_EXTENTS, buildBusModel, buildTruckModel, buildVehicleModel, extentsOf, occupantScale,
  type SeatedExtents,
} from '@render/vehicleModels';
import { RIDER_CLIPS } from '@render/riderPoses';
import { CROWD } from '@render/citizenCasting';
import { m } from '@world/units';

/**
 * EVERY OCCUPANT FITS INSIDE THEIR VEHICLE.
 *
 * Reported: people in cars with parts of their bodies outside the bodywork.
 * The cause was the seated clips (chair poses, head 0.91 m above the pelvis,
 * feet 0.54 m below it) in cabins 1.1 m tall. Occupants now sit in car-seat
 * poses, and each seat of each model states the room it has; this checks the
 * worst body of the roster, measured on the rig, against every seat.
 */
/** How far below the floor a sole resting on it may measure, metres: the pose's own precision. */
const FEET_ON_FLOOR = m(0.003);

describe('occupants', () => {
  type Reach = { top: number; bottom: number; fwd: number; back: number; half: number; worst: Record<string, string> };
  const measured = JSON.parse(readFileSync('tests/fixtures/seated-pose-extents.json', 'utf8')) as
    Record<string, Reach> & { bodies: number; phases: number };
  /** The room each kind of seat states (`extentsOf`), by the poses sat in it. */
  const roomFor = (key: string): SeatedExtents | null =>
    key.startsWith('carRear') ? REAR_SEATED_EXTENTS : key.startsWith('car') ? SEATED_EXTENTS
      : key.startsWith('cab') ? CAB_EXTENTS : key.startsWith('chair') ? CHAIR_EXTENTS : null;
  // Every pose a seat is sat in (the slumped ones belong to the crime
  // simulation, out of the game).
  const seated = RIDER_CLIPS.map((c) => c.key).filter((k) => roomFor(k) && !k.endsWith('Dead'));
  const adults = CROWD.filter((c) => c.ageBand !== 'child').map((c) => c.id);

  it('was measured on the bodies the game draws, in every seated pose and its whole idle loop', () => {
    // The roster's MakeHuman people (`scripts/measure-seated-poses.mjs`), not
    // the glTF crowd that left the game: every worst case is one of them.
    expect(measured.bodies).toBe(adults.length);
    expect(measured.phases).toBeGreaterThanOrEqual(8);
    for (const key of seated) {
      const pose = measured[key];
      expect(pose, `${key} measured`).toBeDefined();
      for (const id of Object.values(pose!.worst)) expect(adults, `${key} worst body`).toContain(id);
    }
  });

  it('gives every seat room no smaller than the worst body in each of its poses', () => {
    for (const key of seated) {
      const pose = measured[key]!;
      const room = roomFor(key)!;
      expect(room.top, key).toBeGreaterThanOrEqual(pose.top - 1e-3);
      expect(room.bottom, key).toBeGreaterThanOrEqual(-pose.bottom - 1e-3);
      expect(room.forward, key).toBeGreaterThanOrEqual(pose.fwd - 1e-3);
      expect(room.back, key).toBeGreaterThanOrEqual(pose.back - 1e-3);
      expect(room.half, key).toBeGreaterThanOrEqual(pose.half - 1e-3);
    }
  });

  it('seats every body of the roster inside every cabin, at a human size', () => {
    const undersized: string[] = [];
    for (const a of ARCHETYPES) {
      const model = a.shape === 'car' ? buildVehicleModel(a)
        : a.shape === 'bus' ? buildBusModel(a) : a.shape === 'truck' ? buildTruckModel(a) : null;
      if (!model) continue;
      expect(model.seats.length, a.id).toBeGreaterThanOrEqual(a.seats);
      // The seats somebody is drawn in (`agents.ts`: the first `a.seats`); a
      // bus's other seats stay empty, solids like any other (`interiorSolids.spec`).
      for (const seat of model.seats.slice(0, a.seats)) {
        // At the size the body is drawn at: shrunk to fit in a car seat, as
        // the pose was solved in a cab or a bus seat (`occupantScale`).
        const s = occupantScale(seat);
        // Nobody is shrunk into a child to make them fit: at worst the
        // tallest body of the roster is drawn at 90 % in the lowest cabin.
        if (s < 0.9) {
          const e = extentsOf(seat);
          undersized.push(`${a.id} row ${seat.row} at ${seat.x.toFixed(1)}: ${s.toFixed(3)} ` +
            `(head ${((seat.headroom / m(1) - 0.02) / e.top).toFixed(3)}, ` +
            `feet ${((seat.hipY - seat.floor) / m(1) / e.bottom).toFixed(3)}, ` +
            `legs ${(seat.legroom / m(1) / e.forward).toFixed(3)}, ` +
            `shoulders ${(seat.sideRoom / m(1) / e.half).toFixed(3)})`);
        }
        const u = (metres: number): number => m(metres) * s;
        // A car seat is sized for the reclined car poses, a bus seat for the
        // upright captured sitting clip.
        const e = extentsOf(seat);
        expect(u(e.top), `${a.id} head`).toBeLessThanOrEqual(seat.headroom);
        // The soles on the floor, not through it: the pose puts them there
        // to the millimetre over its idle loop (`riderPoses.ts` seated).
        expect(u(e.bottom), `${a.id} feet`).toBeLessThanOrEqual(seat.hipY - seat.floor + FEET_ON_FLOOR);
        expect(u(e.forward), `${a.id} legs`).toBeLessThanOrEqual(seat.legroom + 1e-6);
        expect(u(e.half), `${a.id} shoulders`).toBeLessThanOrEqual(seat.sideRoom + 1e-6);
        // And the seat itself is inside the body.
        expect(Math.abs(seat.z) + u(e.half)).toBeLessThan(a.width / 2);
        expect(seat.hipY + u(e.top)).toBeLessThan(a.height);
      }
    }
    expect(undersized).toEqual([]);
  });
});

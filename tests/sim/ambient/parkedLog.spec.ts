import { describe, expect, it } from 'vitest';
import { AmbientWorld } from '@sim/ambient/ambient';
import type { Vehicle } from '@sim/vehicles/state';

/** THE PARKED CARS' LOG IS KEPT FOR EACH READER (`AmbientWorld.parkedSince`): one lagging reader reads the list whole, the others go on reading changes */

const car = (id: number): Vehicle => ({ id, free: { x: id, y: 0, angle: 0, px: id, py: 0, pangle: 0, lot: null } }) as unknown as Vehicle;

describe('the parked cars log', () => {
  it('keeps what a reader has not read, and lets go only the lagging reader', () => {
    const world = new AmbientWorld();
    const fast = {}, slow = {};
    let fastAt = world.parkedSerialNow();
    expect(world.parkedSince(fastAt, fast)).toEqual([]);
    const slowAt = world.parkedSerialNow();
    expect(world.parkedSince(slowAt, slow)).toEqual([]);
    // Many comings and goings while the list stays short: the fast reader reads each round.
    for (let k = 0; k < 100; k++) {
      const c = car(k);
      world.addParked(c);
      world.removeParked(c);
      const read = world.parkedSince(fastAt, fast);
      expect(read?.map((e) => [e.car.id, e.added])).toEqual([[k, true], [k, false]]);
      fastAt = world.parkedSerialNow();
    }
    // The slow one's part grew past the list (reading it whole is no dearer): it alone reads it whole.
    expect(world.parkedSince(slowAt, slow)).toBeNull();
    world.addParked(car(500));
    expect(world.parkedSince(fastAt, fast)?.map((e) => e.car.id)).toEqual([500]);
  });

  it('lets go what every reader has read', () => {
    const world = new AmbientWorld();
    const reader = {};
    let at = world.parkedSerialNow();
    world.parkedSince(at, reader);
    for (let k = 0; k < 10; k++) world.addParked(car(k));
    expect(world.parkedSince(at, reader)).toHaveLength(10);
    at = world.parkedSerialNow();
    world.addParked(car(10));
    expect(world.parkedSince(at, reader)?.map((e) => e.car.id)).toEqual([10]);
    // A serial before what was let go: read whole.
    expect(world.parkedSince(at - 5, reader)).toBeNull();
  });
});

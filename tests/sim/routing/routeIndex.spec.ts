import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import { RouteIndex } from '@sim/routing/routeIndex';

/** THE VEHICLES BY THE LANES OF THEIR ROUTES (`RouteIndex`), kept by what came and went of each route: the same as filing every route again */

type Car = { route: string[] };

describe('the route index', () => {
  it('holds every vehicle under the lanes of its route as it stands, through steps along, changes and repeats', () => {
    const index = new RouteIndex<Car>();
    const rng = new Rng(0x1d);
    const lanes = Array.from({ length: 12 }, (_, k) => `L${k}`);
    const cars: Car[] = Array.from({ length: 6 }, () => ({ route: [] }));
    for (let round = 0; round < 400; round++) {
      const car = cars[rng.int(0, cars.length - 1)]!;
      const roll = rng.float();
      if (roll < 0.5 && car.route.length) car.route.shift();
      else if (roll < 0.8) car.route.push(...Array.from({ length: rng.int(1, 4) }, () => lanes[rng.int(0, lanes.length - 1)]!));
      else car.route = [lanes[rng.int(0, lanes.length - 1)]!];
      index.file(car);
      for (const lane of lanes) {
        const want = cars.filter((c) => index['filed'].has(c) && c.route.includes(lane));
        expect([...(index.routing(lane) ?? [])].sort((a, b) => cars.indexOf(a) - cars.indexOf(b)), `${lane} round ${round}`).toEqual(want);
      }
    }
  });
});

import { DT } from '../params';
import type { SimWorld } from '../world';
import { TransitSim } from '../transit/transit';
import { LotTraffic } from '../agents/lotTraffic';

/** Game seconds per simulated second: a day lasts 72 minutes of play. */
const TIME_SCALE = 20;
/** The time of day the city wakes at, minutes after midnight. */
const DAY_START = 6 * 60 + 30;

/** THE CITY'S OWN SERVICES, with nobody living in it: the time of day, read off the simulation's fixed clock */
export class City {
  /** Buses and trains on the drawn lines (`transit/transit.ts`). */
  readonly transit = new TransitSim();
  /** Cars driving in and out of the lots through their car gates (`agents/lotTraffic.ts`). */
  readonly lots = new LotTraffic();
  /** Minutes the clock was moved on by hand (`skip`). */
  private skipped = 0;

  /** Minutes since midnight of the first day, from the simulation clock. */
  minutes(w: SimWorld): number {
    return DAY_START + this.skipped + (w.clock.tick * DT * TIME_SCALE) / 60;
  }

  /** Moves the clock on. */
  skip(minutes: number): void {
    this.skipped += Math.max(0, minutes);
  }

  /** Stage 2 (`pipeline.ts`): the lines run; traffic comes in at the road ends */
  step(w: SimWorld): void {
    w.edgeTraffic = !(w.ambient.enabled && w.ambient.source === 'view');
    this.transit.step(w);
    // Cars in and out of the lots' car parks by their car gates.
    this.lots.step(w);
  }
}

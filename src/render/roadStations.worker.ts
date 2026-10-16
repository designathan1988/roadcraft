import { roadStations } from '@world/elevation';
import type { JobScope } from '../jobs/jobScope';
import { type SharedGroundData, sharedGroundReaders } from './sharedGround';

/** THE GROUND UNDER THE ROADS A SOLVE WILL READ, OFF THE PAGE (`renderer.ts` buildWorld, `world/elevation.ts` roadStations): each road's stations read off the shared plates' natural ground, point for point as the page reads it (`sharedGround.ts`) */

export interface RoadStationsJob {
  readonly ground: SharedGroundData;
  readonly roads: readonly { readonly id: number; readonly xy: Float64Array; readonly half: number }[];
}
export interface RoadStationsReply {
  readonly roads: readonly { readonly id: number; readonly ceil: Float64Array; readonly base: Float64Array }[];
}

export function serve(scope: JobScope): void {
  scope.onmessage = (event: MessageEvent<RoadStationsJob>) => {
    const { ground, roads } = event.data;
    const { naturalAt } = sharedGroundReaders(ground);
    const out: { id: number; ceil: Float64Array; base: Float64Array }[] = [];
    for (const road of roads) {
      const { ceil, base } = roadStations(road.xy, road.half, naturalAt);
      out.push({ id: road.id, ceil: Float64Array.from(ceil), base: Float64Array.from(base) });
    }
    const reply: RoadStationsReply = { roads: out };
    scope.postMessage(reply, out.flatMap((r) => [r.ceil.buffer, r.base.buffer]));
  };
}

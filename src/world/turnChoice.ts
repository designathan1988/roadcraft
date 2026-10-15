import { Polyline } from '@core/polyline';
import type { ChosenTurn, SurfaceRings, TurnAsk } from './junctionTurns';
import { JunctionSurface, chooseTurn } from './turnPaths';

/**
 * The turn a worker chooses (`conflictTable.worker.ts`): `chooseTurn` on the numbers the page sent
 * (`TurnAsk`), the surface made once per key (`surfaces`). Answers what `turnPath` keeps: the same turn
 * the page would choose (`tests/world/turnPlan.spec.ts`).
 */
export function chooseTurnOf(ask: TurnAsk, rings: SurfaceRings, surfaces: Map<string, JunctionSurface>): ChosenTurn {
  let surface = surfaces.get(ask.surfaceKey);
  if (!surface) surfaces.set(ask.surfaceKey, (surface = new JunctionSurface(rings)));
  const { choice, body } = chooseTurn(Polyline.fromFlat(ask.inXY), Polyline.fromFlat(ask.outXY), surface,
    ask.waiting.map((xy) => ({ centre: Polyline.fromFlat(xy) })), { fromRoadEnd: ask.fromRoadEnd, toRoadEnd: ask.toRoadEnd });
  return { choice, maxBodyClass: body };
}

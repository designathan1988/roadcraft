import type { TurnKind } from '@world/lanelets';
import type { DriverParams } from '../vehicles/driver';
import { canStopComfortably } from '../vehicles/idm';
import type { SignalState } from './query';

/** One shared yellow/red decision for both longitudinal braking and admission. */
/** Whether a right turn may be taken on red after a full stop. */
const RIGHT_ON_RED_ALLOWED = false;

/** `mustStopAtSignal` for one vehicle and connector, with the amber decision held once it is made. */
export function signalHolds(
  v: { amberStop: string | null; rorCredit: boolean; driver: DriverParams; v: number },
  connector: string,
  state: SignalState,
  turn: TurnKind,
  distanceToStop: number,
): boolean {
  if (state === 'green') {
    if (v.amberStop === connector) v.amberStop = null;
    return false;
  }
  if (state === 'amber' && v.amberStop === connector) return true;
  const stop = mustStopAtSignal(state, turn, v.rorCredit, v.driver, v.v, distanceToStop);
  if (stop && state === 'amber') v.amberStop = connector;
  return stop;
}

function mustStopAtSignal(
  state: SignalState,
  turn: TurnKind,
  rightOnRedCredit: boolean,
  driver: DriverParams,
  speed: number,
  distanceToStop: number,
): boolean {
  if (state === 'red') {
    return !(RIGHT_ON_RED_ALLOWED && turn === 'right' && rightOnRedCredit);
  }
  if (state === 'amber') {
    return canStopComfortably(driver, speed, distanceToStop);
  }
  return false;
}

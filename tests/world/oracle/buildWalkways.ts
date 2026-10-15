import type { Network } from '@world/network';
import { type WalkGraph, Walkways } from '@world/walkways';

/** The pedestrian network of the whole map, from nothing. Pure: the same network gives the same walkways. */
export function buildWalkways(net: Network): WalkGraph {
  return new Walkways().update(net);
}

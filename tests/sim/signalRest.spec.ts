import { describe, expect, it } from 'vitest';

import { asNodeId } from '@world/ids';
import { DT } from '@sim/params';
import { stepController, type SignalController, type SignalDeps } from '@sim/signals/fsm';

describe('actuated signal rest', () => {
  it('keeps the empty junction green and transfers right of way when another approach calls', () => {
    const stage = (group: number) => ({
      greenGroups: [group], pedWalk: [], minGreen: 2, targetGreen: 5, maxGreen: 8,
      amber: 1, allRed: 1, exclusivePed: false, protectedMovements: [],
    });
    const calls = new Set<number>();
    let tick = 0;
    const deps: SignalDeps = {
      tick: () => tick,
      connectorsOf: () => undefined,
      pedestriansCrossing: () => false,
      demandOn: (_node, groups) => groups.some((group) => calls.has(group)),
      pedestrianDemandOn: () => false,
      reservationDemandOn: () => false,
    };
    const controller: SignalController = {
      node: asNodeId(1), plan: { stages: [stage(1), stage(2)], groups: [1, 2], crossings: [], cycle: 20 },
      stageIndex: 0, sub: 'GREEN', elapsed: 0,
      lastServed: new Map([[1, 0], [2, 0]]), stageServed: new Map([[0, 0], [1, 0]]),
      offsetApplied: 0, degraded: false,
    };
    for (let i = 0; i < Math.round(30 / DT); i++) { tick++; stepController(controller, deps); }
    expect([controller.stageIndex, controller.sub]).toEqual([0, 'GREEN']);

    calls.add(2);
    for (let i = 0; i < Math.round(4 / DT); i++) { tick++; stepController(controller, deps); }
    expect([controller.stageIndex, controller.sub]).toEqual([1, 'GREEN']);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { trapLanes } from '@sim/routing/router';
import { SimWorld } from '@sim/world';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { HEAVY } from '@world/conflictPoints';

/**
 * A street whose only way out lies, lanes further on, through a bend no car
 * fits is a trap: the router never sends a car into it (`trapLanes`). In the
 * player's city a car took one and stood at its end for 75 s, its junction
 * queued (defects.spec, player-city).
 *
 * That bend - the hairpins of the player's grid - fits a car since a turn is
 * shaped for the largest body that can make it (P92, `turnPaths.ts
 * chooseTurn`), and it is driven; it still fits no bus, so for a bus the
 * street before it is the trap.
 */
describe('lanes a car can never leave', () => {
  it("player's city: the street before a bend no bus fits is a trap for a bus, not for a car; roads off the map never are", () => {
    const raw = JSON.parse(readFileSync(join(process.cwd(), 'tests', 'fixtures', 'player-city.json'), 'utf8')) as { document: unknown };
    const doc = RoadDoc.fromJSON(raw.document as never);
    const net = new Network(doc);
    net.rebuild();
    const sim = new SimWorld(doc, net, 1);
    sim.rebuildTopology();
    const traps = trapLanes(sim, HEAVY);
    expect(traps.has('32:38>37:0')).toBe(true);
    expect(traps.has('33:39>38:0')).toBe(true);
    expect(trapLanes(sim, 1).has('32:38>37:0')).toBe(false);
    expect(trapLanes(sim, 1).has('33:39>38:0')).toBe(false);
    for (const id of traps) expect(sim.graph.exitsOf(id).length).toBeGreaterThan(0);
    // A trap's every fitting way on is a trap too.
    for (const id of traps) {
      for (const cid of sim.graph.exitsOf(id)) {
        const c = sim.connector(cid)!;
        if (c.maxBodyClass >= HEAVY) expect(traps.has(c.toLane)).toBe(true);
      }
    }
  });
});

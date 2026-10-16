import { describe, expect, it } from 'vitest';
import { m } from '@world/units';
import { Rng } from '@core/rng';
import { step } from '@sim/pipeline';
import { runAudit } from '@sim/invariants';
import { createAgentWalkEngine } from '@sim/agents/walk';
import { runAudit as oldRunAudit } from './oracle/invariantsOld';
import { seededEdit, seededWorld } from './support';

/** The audit with the longest signal cycle worked out once (`runAudit`) says what the audit of before said */
describe('the audit, the longest cycle worked out once', () => {
  it('finds what the old audit found, tick by tick', () => {
    const w = seededWorld(0xa0d17);
    for (const node of [...w.doc.nodes.keys()].filter((_, i) => i % 3 === 0)) w.doc.setNodeControl(node, 'signal');
    w.net.rebuild();
    w.rebuildTopology();
    w.usePedestrianEngine(createAgentWalkEngine());
    w.trafficCount = 90;
    w.pedestrianCount = 0;
    w.ambient.enabled = true;
    w.ambient.source = 'edges';
    w.clock.paused = false;
    const rng = new Rng(17);
    let stopped = 0, issues = 0;
    for (let t = 1; t <= 300; t++) {
      step(w, { traffic: true, pedestrians: false });
      if (t % 100 === 0) seededEdit(w, rng);
      if (t % 3 !== 0) continue;
      for (const level of ['cheap', 'full'] as const) {
        const now = runAudit(w, level);
        expect(JSON.stringify(now)).toBe(JSON.stringify(oldRunAudit(w, level)));
        issues += now.length;
      }
      for (const v of w.vehicles.values()) {
        const lane = w.lanelet(v.lanelet);
        if (lane?.kind === 'link' && lane.controlled && v.v < m(0.04)) stopped++;
      }
    }
    // The branch that read the cycle ran: cars stood at the lights.
    expect(stopped).toBeGreaterThan(50);
    expect(w.signalisedControllers().length).toBeGreaterThan(2);
    void issues;
  });

  it('given the signals stepped, looks at them and at those planned again, never at every signal', () => {
    const w = seededWorld(0xa0d17);
    for (const node of [...w.doc.nodes.keys()].filter((_, i) => i % 3 === 0)) w.doc.setNodeControl(node, 'signal');
    w.net.rebuild();
    w.rebuildTopology();
    w.trafficCount = 90;
    w.pedestrianCount = 0;
    for (let t = 0; t < 60; t++) step(w, { traffic: true, pedestrians: false });
    // The first audit files every plan's cycle; the walks of every signal counted after it.
    runAudit(w, 'cheap', []);
    const some = w.signalisedControllers().slice(0, 2);
    expect(some.length).toBe(2);
    const map = w.controllers;
    const values = map.values.bind(map), entries = map[Symbol.iterator].bind(map);
    let whole = 0;
    map.values = () => { whole++; return values(); };
    map[Symbol.iterator] = () => { whole++; return entries(); };
    for (let k = 0; k < 5; k++) runAudit(w, 'full', some);
    expect(whole).toBe(0);
    // Without the signals: every one, as the specs and doing everything ask.
    runAudit(w, 'cheap');
    expect(whole).toBe(1);
  });
});

import { afterEach, describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import type { Connector } from '@world/lanelets';
import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import { admissionProbe, holderState } from '@sim/intersections/admission';
import { zoneShareable } from '@sim/intersections/claims';
import { cycleFull, cyclesOf } from '@sim/intersections/cycles';
import { JAM_GAP } from '@sim/params';
import type { Vehicle } from '@sim/vehicles/state';
import type { SimWorld } from '@sim/world';
import { simOf } from './support/bodies';

/**
 * The Banker's test reads the applicant's group, not the town
 * (`intersections/admission.ts` bankerSafeInGroup): the holders linked to it
 * through the resources of their maximum claims. Against the test over every
 * holder of the town (the old one, written out here as the oracle): the same
 * verdict, but where the rest of the town is locked on its own - there the
 * old test refused every grant in the city for a lock elsewhere (audit P2-11),
 * and the new one answers for the applicant's group alone. And the ring meter
 * reads the cars on the ring's own lanes (`cycles.ts` cycleFull): the same
 * answer as the walk over the whole fleet.
 */

/** Two signalised T junctions a car length apart (a compact box: maximum claims), at `dx`. */
function closeTees(doc: RoadDoc, dx: number): void {
  const west = doc.addNode({ x: dx - 500, y: 0 });
  const a = doc.addNode({ x: dx - 25, y: 0 });
  const b = doc.addNode({ x: dx + 25, y: 0 });
  const east = doc.addNode({ x: dx + 500, y: 0 });
  doc.addSegment(west.id, a.id, 2);
  doc.addSegment(a.id, b.id, 2);
  doc.addSegment(b.id, east.id, 2);
  doc.addSegment(doc.addNode({ x: dx - 25, y: 400 }).id, a.id, 1);
  doc.addSegment(doc.addNode({ x: dx + 25, y: -400 }).id, b.id, 1);
}

type Resource = number;

/** The old test's resources of a connector: its conflict points, or a token of its own. */
function resourcesOf(w: SimWorld, c: { id: string }, tokens: Map<string, number>): Resource[] {
  const refs = w.conflicts.refs(c.id);
  if (refs.length) return refs.map((ref) => ref.point);
  let t = tokens.get(c.id);
  if (t === undefined) tokens.set(c.id, t = -1 - tokens.size);
  return [t];
}

function allocationOf(w: SimWorld, v: Vehicle, tokens: Map<string, number>): Set<Resource> {
  const out = new Set<Resource>(w.claims.points(v.id));
  const movements = new Set<string>();
  if (v.admittedConnector) movements.add(v.admittedConnector);
  for (const t of v.clearingConnectors) movements.add(t.connector);
  const lane = w.lanelet(v.lanelet);
  if (lane?.kind === 'connector') movements.add(lane.id);
  for (const id of movements) if (w.conflicts.refs(id).length === 0) for (const r of resourcesOf(w, { id }, tokens)) out.add(r);
  return out;
}

function sharedConvoy(w: SimWorld, resource: Resource): boolean {
  if (resource < 0) return true;
  const point = w.conflicts.points[resource];
  const claims = w.claims.holdersAt(resource);
  if (!point || claims.length === 0) return false;
  if (point.kind === 'merge' && (w.doc.node(point.node)?.incident.length ?? 0) === 2) return true;
  const placed = claims.map((claim) => ({ connector: claim.connector, state: holderState(w, claim) }));
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]!, b = placed[j]!;
      if (a.connector === b.connector) continue;
      if (!a.state || !b.state) return false;
      if (!zoneShareable(point, { connector: a.connector, state: a.state }, { connector: b.connector, state: b.state })) return false;
    }
  }
  return true;
}

interface Process { id: number; allocation: Set<Resource>; maximum: Set<Resource> }

/** The old Banker's test over these processes (the applicant first), double holdings judged on `mine`. */
function bankerOver(w: SimWorld, processes: readonly Process[], mine: ReadonlySet<Resource>): boolean {
  const owners = new Map<Resource, number>();
  const universe = new Set<Resource>();
  const live: Process[] = [];
  for (const p of processes) {
    if (!p.allocation.size || !p.maximum.size) continue;
    for (const r of p.allocation) {
      const owner = owners.get(r);
      if (owner !== undefined && owner !== p.id && !sharedConvoy(w, r) && mine.has(r)) return false;
      owners.set(r, p.id);
      universe.add(r);
    }
    for (const r of p.maximum) universe.add(r);
    live.push(p);
  }
  const work = new Set<Resource>();
  for (const r of universe) if (!owners.has(r)) work.add(r);
  const unfinished = new Set(live.map((_, i) => i));
  for (let progressed = true; unfinished.size && progressed;) {
    progressed = false;
    for (const i of [...unfinished]) {
      const p = live[i]!;
      let can = true;
      for (const r of p.maximum) if (!p.allocation.has(r) && !work.has(r)) { can = false; break; }
      if (!can) continue;
      for (const r of p.allocation) work.add(r);
      unfinished.delete(i);
      progressed = true;
    }
  }
  return unfinished.size === 0;
}

/** Every holder of the town as the old test read it. */
function holders(w: SimWorld, but: number, tokens: Map<string, number>): Process[] {
  const out: Process[] = [];
  for (const v of w.vehicles.values()) {
    if (v.id === but) continue;
    const allocation = allocationOf(w, v, tokens);
    if (!allocation.size) continue;
    const maximum = new Set(allocation);
    for (const id of v.reservedConnectors) {
      const c = w.connector(id);
      if (c) for (const r of resourcesOf(w, c, tokens)) maximum.add(r);
    }
    out.push({ id: v.id, allocation, maximum });
  }
  return out;
}

afterEach(() => { admissionProbe.banker = null; });

describe('the Banker reads the applicant\'s group', () => {
  it('answers as the test over the whole town, but for a lock elsewhere', () => {
    const doc = new RoadDoc();
    closeTees(doc, 0);
    closeTees(doc, 3000);
    const sim = simOf(doc, 0x5eed, 2);
    let compared = 0, groupOnly = 0;
    admissionProbe.banker = (w, applicant, proposal: readonly Connector[], safe) => {
      const tokens = new Map<string, number>();
      const own = allocationOf(w, applicant, tokens);
      const mine = new Set<Resource>(own);
      for (const c of proposal) for (const r of resourcesOf(w, c, tokens)) mine.add(r);
      const allocation = new Set(own);
      if (proposal[0]) for (const r of resourcesOf(w, proposal[0], tokens)) allocation.add(r);
      const maximum = new Set(own);
      for (const c of proposal) for (const r of resourcesOf(w, c, tokens)) maximum.add(r);
      const rest = holders(w, applicant.id, tokens);
      const old = bankerOver(w, [{ id: applicant.id, allocation, maximum }, ...rest], mine);
      compared++;
      if (safe === old) return;
      // Only where the rest of the town is locked by itself, with no part of the applicant's.
      expect(old).toBe(false);
      expect(safe).toBe(true);
      expect(bankerOver(w, rest, new Set(rest.flatMap((p) => [...p.allocation])))).toBe(false);
      groupOnly++;
    };
    for (let i = 0; i < Math.round(40 / DT); i++) step(sim, { traffic: true, pedestrians: true });
    expect(compared).toBeGreaterThan(50);
    console.log(`admissionGroup: ${compared} Banker verdicts compared, ${groupOnly} for the group alone`);
  }, 60_000);
});

describe('the ring meter', () => {
  it('reads the cars on the ring as the walk over the fleet did', () => {
    // A ring of short one-way streets with arms: `roundabout.spec`'s kind of town.
    const doc = new RoadDoc();
    const r = 60, n = 6;
    const ring = Array.from({ length: n }, (_, k) => doc.addNode({ x: Math.cos((k / n) * Math.PI * 2) * r, y: Math.sin((k / n) * Math.PI * 2) * r }));
    for (let k = 0; k < n; k++) doc.addSegment(ring[k]!.id, ring[(k + 1) % n]!.id, 1);
    for (let k = 0; k < n; k += 2) {
      const out = doc.addNode({ x: Math.cos((k / n) * Math.PI * 2) * 600, y: Math.sin((k / n) * Math.PI * 2) * 600 });
      doc.addSegment(out.id, ring[k]!.id, 1);
    }
    const sim = simOf(doc, 0x5eed, 2);
    let asked = 0;
    for (let i = 0; i < Math.round(30 / DT); i++) {
      step(sim, { traffic: true, pedestrians: true });
      if (i % 10) continue;
      for (const lane of sim.graph.lanelets.values()) {
        if (lane.kind !== 'connector' || !lane.fromLane || !lane.toLane) continue;
        const need = 4 + JAM_GAP;
        const old = cyclesOf(sim, lane.toLane).some((cycle) => {
          if (cycle.lanelets.has(lane.fromLane!)) return false;
          let used = need;
          for (const v of sim.vehicles.values()) if (cycle.lanelets.has(v.lanelet)) used += v.archetype.length + Math.max(JAM_GAP, v.driver.s0);
          return used > cycle.storage * 0.7;
        });
        expect(cycleFull(sim, lane.fromLane, lane.toLane, need)).toBe(old);
        asked++;
      }
    }
    expect(asked).toBeGreaterThan(100);
  }, 60_000);
});

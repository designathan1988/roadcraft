import { DT, L_MIN, SIGNAL, STUCK_SECONDS } from './params';
import type { SimWorld } from './world';
import { type AuditIssue, issue } from './audit';
import { anyGreen, signalStateFor } from './signals/query';
import type { SignalController } from './signals/fsm';
import { COARSE_EPS } from '@core/scalar';
import { pedestrianAffectsSpan, reservationCoversCrossing } from './intersections/crossingSpans';
import { m } from '@world/units';
import type { Vehicle } from './vehicles/state';

/** Runtime invariant checks. */
/** When demand was first seen waiting at each group's red, per controller (`groupStarved`). */
const DEMAND_ONSET = new WeakMap<SignalController, Map<number, number>>();

export function runAudit(w: SimWorld, level: 'cheap' | 'full'): AuditIssue[] {
  const out: AuditIssue[] = [];
  const tick = w.clock.tick;
  const signalDeps = w.signalDeps();

  // ---- signals ----------------------------------------------------------
  const maxDark = SIGNAL.amber + SIGNAL.minAllRed + 0.5;
  for (const c of w.controllers.values()) {
    if (c.degraded) {
      out.push(issue('degradedPlan', tick, c.node, 'plan failed validation'));
    }
    const currentStage = c.plan.stages[c.stageIndex];
    if (!anyGreen(c) && c.sub === 'GREEN' && !currentStage?.exclusivePed) {
      out.push(issue('planCoverageGap', tick, c.node, 'green stage serves no group'));
    }
    // Against the stage's own yellow and all-red: a stage releasing a fast approach has a longer yellow
    const stageDark = currentStage ? currentStage.amber + currentStage.allRed + 0.5 : maxDark;
    if (c.sub !== 'GREEN' && c.elapsed > Math.max(maxDark, stageDark)) {
      out.push(
        issue('allRedTooLong', tick, c.node, `${c.sub} for ${c.elapsed.toFixed(1)}s`),
      );
    }
    // A busy stage is allowed to extend from its target to maxGreen.
    const limit = SIGNAL.starvationCycles * maxSignalCycle(c) + maxDark;
    // Starved is demand left waiting, not a group long unused
    let onsets = DEMAND_ONSET.get(c);
    if (!onsets) DEMAND_ONSET.set(c, onsets = new Map());
    for (const g of c.plan.groups) {
      const last = c.lastServed.get(g);
      if (last === undefined) continue;
      const demanded =
        signalDeps.demandOn(c.node, [g]) ||
        signalDeps.reservationDemandOn(c.node, [g]);
      if (!demanded || signalStateFor(c, g) !== 'red') { onsets.delete(g); continue; }
      let since = onsets.get(g);
      if (since === undefined) onsets.set(g, since = tick);
      const red = (tick - Math.max(last, since)) * DT;
      if (red > limit) {
        out.push(issue('groupStarved', tick, `${c.node}/${g}`, `red for ${red.toFixed(1)}s with demand waiting`));
      }
    }
  }

  // DO NOT move this back into the loop.
  const wedgeLimit = 2 * maxCycle(w);
  for (const v of w.vehicles.values()) {
    const lane = w.lanelet(v.lanelet);
    if (!lane) {
      out.push(issue('routeless', tick, v.id, 'vehicle on a missing lanelet'));
      continue;
    }

    if (v.s < v.prev.s - COARSE_EPS && v.lanelet === v.prev.lanelet) {
      out.push(
        issue('nonMonotoneS', tick, v.id, `s went ${v.prev.s.toFixed(3)} -> ${v.s.toFixed(3)}`),
      );
    }

    if (v.route.length === 0) {
      out.push(issue('routeless', tick, v.id, 'empty route'));
    }

    // Standing still on a green with nothing in the way: the exact symptom the rewrite exists to eliminate.
    if (v.greenStall > 5) {
      out.push(issue('greenBlocked', tick, v.id, `${v.greenStall.toFixed(1)}s stalled on green`));
    }

    // `greenStall` above is the UNEXPLAINED stall
    if (lane.kind === 'link' && lane.controlled && lane.to !== undefined) {
      const controller = w.controller(lane.to);
      if (controller && v.greenDenied > maxSignalCycle(controller)) {
        out.push(
          issue(
            'greenBlocked',
            tick,
            v.id,
            `${v.greenDenied.toFixed(1)}s held at green, longer than the whole cycle`,
          ),
        );
      }
    }

    if (lane.kind === 'link' && lane.controlled && v.v < m(0.04)) {
      const stalled = w.clock.since(v.lastMovedTick);

      // Being held out of a full lane is correct behaviour — it is what stops the network gridlocking
      if (
        stalled > wedgeLimit &&
        v.constraints.obstacles.some((o) => o.kind === 'spillback')
      ) {
        if (junctionIsStuck(w, lane.to, wedgeLimit)) {
          out.push(
            issue('spillbackWedge', tick, v.id, `held ${stalled.toFixed(0)}s at a stalled junction`),
          );
        }
      }

      // Cross-node compact reservations can keep one access blocked while the same junction continues serving other directions.
      const requestWait =
        v.firstRequestTick === null ? 0 : w.clock.since(v.firstRequestTick);
      const ownsCompoundAllocation =
        v.reservedConnectors.length > 0 &&
        (v.admittedConnector !== null ||
          v.clearingConnectors.length > 0);
      // `firstRequestTick` deliberately spans the complete compact-box transaction so admission can preserve FIFO priority
      const currentAccessWait = Math.min(
        requestWait,
        w.clock.since(v.lastMovedTick),
      );
      if (
        ownsCompoundAllocation &&
        currentAccessWait > wedgeLimit &&
        v.constraints.obstacles.some(
          (o) => o.kind === 'yield' || o.kind === 'conflict' || o.kind === 'pedestrian',
        )
      ) {
        out.push(
          issue(
            'greenBlocked',
            tick,
            v.id,
            `access arbitration unresolved ${currentAccessWait.toFixed(0)}s`,
          ),
        );
      }
    }
  }

  if (level === 'cheap') return out;

  // ---- full checks ------------------------------------------------------

  // Overlap: bumper-to-bumper gaps must never go negative.
  for (const rt of w.runtime.values()) {
    for (let i = 0; i + 1 < rt.order.length; i++) {
      const aId = rt.order[i];
      const bId = rt.order[i + 1];
      const a = aId === undefined ? undefined : w.veh(aId);
      const b = bId === undefined ? undefined : w.veh(bId);
      if (!a || !b) continue;
      const gap = b.s - b.archetype.length - a.s;
      if (gap < -m(0.004)) {
        out.push(issue('overlap', tick, `${a.id}/${b.id}`, `gap ${gap.toFixed(3)}`));
      }
    }
  }

  // Claims must belong to a live vehicle.
  for (const v of w.vehicles.values()) {
    for (const p of v.claims) {
      if (!w.claims.holds(v.id, p)) {
        out.push(issue('orphanClaim', tick, v.id, `point ${p}`));
      }
    }
    if (v.admittedConnector && w.clock.since(v.lastMovedTick) > STUCK_SECONDS) {
      out.push(issue('staleClaim', tick, v.id, 'holder immobile'));
    }
  }

  // Link lanelets should be able to hold the largest vehicle.
  for (const lane of w.graph.lanelets.values()) {
    if (lane.kind !== 'link') continue;
    if (lane.length <= 0) {
      out.push(issue('degenerateGeometry', tick, lane.id, 'zero length'));
    } else if (lane.length < L_MIN) {
      out.push(issue('shortLink', tick, lane.id, `length ${lane.length.toFixed(1)} < ${L_MIN.toFixed(1)}`));
    }
  }

  // ---- pedestrians ------------------------------------------------------
  w.pedEngine.audit(w, out);

  // DO NOT walk the fleet for each person on each crossing (people x vehicles an audit).
  const holding = new Map<number, { v: Vehicle; ids: string[] }[]>();
  for (const v of w.vehicles.values()) {
    const lane = w.lanelet(v.lanelet);
    if (!v.clearingConnectors.length && !v.admittedConnector && lane?.kind !== 'connector') continue;
    const connectorIds = new Set(v.clearingConnectors.map((token) => token.connector));
    if (v.admittedConnector) connectorIds.add(v.admittedConnector);
    if (lane?.kind === 'connector') connectorIds.add(lane.id);
    for (const id of connectorIds) {
      const node = w.connector(id)?.node;
      if (node === undefined) continue;
      // The vehicles are filed one after another: its entry at a node, if it has one, is that node's last.
      const list = holding.get(node);
      const last = list?.[list.length - 1];
      if (last?.v === v) last.ids.push(id);
      else if (list) list.push({ v, ids: [id] });
      else holding.set(node, [{ v, ids: [id] }]);
    }
  }
  for (const [crossing, state] of w.crossingStates) {
    if (!state.occupants.length) continue;
    const split = crossing.indexOf(':');
    const node = Number(crossing.slice(0, split));
    const segment = Number(crossing.slice(split + 1));
    const here = holding.get(node);
    if (!here) continue;
    for (const occupant of state.occupants) {
      for (const { v, ids } of here) {
        for (const connectorId of ids) {
          const connector = w.connector(connectorId);
          if (connector?.node === node) {
            const span = w.crossingSpans.span(connector.id, crossing);
            if (span === null || (span && !pedestrianAffectsSpan(occupant, span))) continue;
            if (!reservationCoversCrossing(w, v, connector, segment, span)) continue;
            out.push(
              issue(
                'pedSignalContradiction',
                tick,
                `${occupant.id}/${v.id}`,
                `crossing ${crossing} overlaps reserved connector ${connector.id}`,
              ),
            );
          }
        }
      }
    }
  }

  return out;
}

/** True when a junction has admitted nobody for longer than `limit` seconds. */
function junctionIsStuck(w: SimWorld, node: number | undefined, limit: number): boolean {
  if (node === undefined) return false;
  const last = w.lastAdmission.get(node as never);
  if (last === undefined) return w.clock.time > limit;
  return w.clock.since(last) > limit;
}

function maxCycle(w: SimWorld): number {
  let max = 30;
  for (const c of w.controllers.values()) max = Math.max(max, c.plan.cycle);
  return Math.min(max, 200);
}

function maxSignalCycle(c: SignalController): number {
  return c.plan.stages.reduce(
    (total, stage) => total + stage.maxGreen + stage.amber + stage.allRed,
    0,
  );
}

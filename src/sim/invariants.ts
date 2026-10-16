import { DT, L_MIN, SIGNAL, STUCK_SECONDS } from './params';
import type { SimWorld } from './world';
import { type AuditIssue, issue } from './audit';
import { anyGreen, signalStateFor } from './signals/query';
import type { SignalController } from './signals/fsm';
import { COARSE_EPS } from '@core/scalar';
import { pedestrianAffectsSpan, reservationCoversCrossing } from './intersections/crossingSpans';
import { m } from '@world/units';
import type { Vehicle } from './vehicles/state';
import type { NodeId } from '@world/ids';

/** Runtime invariant checks. */
/** What a world's audits keep from one to the next (`runAudit`) */
interface AuditMemory {
  /** The audits run so far. */
  pass: number;
  /** The signals' log read so far (`SimWorld.signalChangesSince`). */
  serial: number;
  /** When demand was first seen waiting at each group's red, per controller (`groupStarved`), and the audit that last looked at it. */
  readonly onsets: WeakMap<SignalController, { audited: number; readonly since: Map<number, number> }>;
  /** Each junction's plan cycle, and the longest with how many have it (`maxCycle`); `stale`: the last of the longest went, found again when next asked. */
  readonly cycles: Map<NodeId, number>;
  longest: number;
  longestCount: number;
  stale: boolean;
}
const MEMORY = new WeakMap<SimWorld, AuditMemory>();

/** The floor and the ceiling of the longest cycle the audit reads (`maxCycle`), s; a wedge is twice it, so never under twice the floor. */
const CYCLE_FLOOR = 30;
const CYCLE_CEILING = 200;
const MIN_WEDGE = 2 * CYCLE_FLOOR;

/** DO NOT walk every signal of the map each audit: `signals` (those stepped since, `pipeline.ts`) and those planned again are looked at; without it, every one */
export function runAudit(w: SimWorld, level: 'cheap' | 'full', signals?: readonly SignalController[]): AuditIssue[] {
  const out: AuditIssue[] = [];
  const tick = w.clock.tick;
  const signalDeps = w.signalDeps();
  const memory = memoryOf(w);
  const pass = ++memory.pass;
  const planned = followSignals(w, memory);

  // ---- signals ----------------------------------------------------------
  const maxDark = SIGNAL.amber + SIGNAL.minAllRed + 0.5;
  for (const c of auditedSignals(w, signals, planned)) {
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
    const onsets = onsetsOf(memory, c, pass);
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

  // DO NOT move this back into the loop, nor work it out while no car has stood past its floor.
  let wedge = -1;
  const wedgeLimit = (): number => (wedge < 0 ? (wedge = 2 * maxCycle(memory)) : wedge);
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
        stalled > MIN_WEDGE && stalled > wedgeLimit() &&
        v.constraints.obstacles.some((o) => o.kind === 'spillback')
      ) {
        if (junctionIsStuck(w, lane.to, wedgeLimit())) {
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
        currentAccessWait > MIN_WEDGE && currentAccessWait > wedgeLimit() &&
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

function memoryOf(w: SimWorld): AuditMemory {
  let memory = MEMORY.get(w);
  if (!memory) MEMORY.set(w, memory = { pass: 0, serial: -1, onsets: new WeakMap(), cycles: new Map(), longest: -Infinity, longestCount: 0, stale: false });
  return memory;
}

/** The longest plan cycle of the map, from the cycles kept by node (`followSignals`), between the floor and the ceiling. */
function maxCycle(memory: AuditMemory): number {
  if (memory.stale) {
    memory.stale = false;
    memory.longest = -Infinity;
    memory.longestCount = 0;
    for (const cycle of memory.cycles.values()) keepLongest(memory, cycle);
  }
  return Math.min(Math.max(CYCLE_FLOOR, memory.longest), CYCLE_CEILING);
}

/** The signals an audit looks at: every one, or those given and those planned again since the last audit (`planned`, null: any may have been). */
function auditedSignals(w: SimWorld, signals: readonly SignalController[] | undefined, planned: readonly NodeId[] | null): Iterable<SignalController> {
  if (!signals || planned === null) return everySignal(w);
  if (!planned.length) return signals;
  const out = [...signals];
  const seen = new Set(signals);
  for (const node of planned) {
    const c = w.controllers.get(node);
    if (c && !seen.has(c)) { seen.add(c); out.push(c); }
  }
  return out;
}

/** @rebuild Every signal: the audit of everything (doing everything, the specs), or the first after the signals' log was forgotten. */
function everySignal(w: SimWorld): Iterable<SignalController> {
  return w.controllers.values();
}

/** A signal's demand onsets for this audit: forgotten when the audit before did not look at it (asleep then, no demand waited at it) */
function onsetsOf(memory: AuditMemory, c: SignalController, pass: number): Map<number, number> {
  let entry = memory.onsets.get(c);
  if (!entry) memory.onsets.set(c, entry = { audited: pass, since: new Map() });
  else if (entry.audited !== pass - 1) entry.since.clear();
  entry.audited = pass;
  return entry.since;
}

/** The plans' cycles brought up to the signals' log: the junctions planned again since the last audit, null when it cannot say which. */
function followSignals(w: SimWorld, memory: AuditMemory): readonly NodeId[] | null {
  const log = w.signalChangesSince(memory.serial);
  memory.serial = log.serial;
  if (log.nodes === null) {
    refileCycles(w, memory);
    return null;
  }
  for (const node of log.nodes) {
    dropCycle(memory, node);
    const c = w.controllers.get(node);
    if (c) keepCycle(memory, node, c.plan.cycle);
  }
  return log.nodes;
}

/** @rebuild Every junction's cycle filed again: the first audit of a world, or after the signals' log was forgotten. */
function refileCycles(w: SimWorld, memory: AuditMemory): void {
  memory.cycles.clear();
  memory.longest = -Infinity;
  memory.longestCount = 0;
  memory.stale = false;
  for (const [node, c] of w.controllers) keepCycle(memory, node, c.plan.cycle);
}

function keepCycle(memory: AuditMemory, node: NodeId, cycle: number): void {
  memory.cycles.set(node, cycle);
  if (!memory.stale) keepLongest(memory, cycle);
}

function keepLongest(memory: AuditMemory, cycle: number): void {
  if (cycle > memory.longest) { memory.longest = cycle; memory.longestCount = 1; }
  else if (cycle === memory.longest) memory.longestCount++;
}

/** A junction's cycle taken out: when it was the last of the longest, the longest is found again only when asked (`maxCycle`). */
function dropCycle(memory: AuditMemory, node: NodeId): void {
  const cycle = memory.cycles.get(node);
  if (cycle === undefined) return;
  memory.cycles.delete(node);
  if (!memory.stale && cycle === memory.longest && --memory.longestCount === 0) memory.stale = true;
}

function maxSignalCycle(c: SignalController): number {
  return c.plan.stages.reduce(
    (total, stage) => total + stage.maxGreen + stage.amber + stage.allRed,
    0,
  );
}

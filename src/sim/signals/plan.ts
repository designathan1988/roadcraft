import { clamp } from '@core/scalar';
import type { NodeId } from '@world/ids';
import type { Connector, JunctionTopology } from '@world/lanelets';
import { METERS_PER_UNIT } from '@world/units';
import { PED, SIGNAL } from '../params';

export type GroupId = number;
export type CrossingId = string;

interface Stage {
  readonly greenGroups: readonly GroupId[];
  /** Crossings showing WALK during this stage. */
  readonly pedWalk: readonly CrossingId[];
  readonly minGreen: number;
  readonly maxGreen: number;
  readonly targetGreen: number;
  readonly amber: number;
  readonly allRed: number;
  readonly exclusivePed: boolean;
  /** Movements green in this stage that no conflicting movement from another approach can meet */
  readonly protectedMovements: readonly string[];
  /** When set, this stage exists only to serve these movements */
  readonly demandMovements?: readonly string[];
}

export interface SignalPlan {
  readonly stages: readonly Stage[];
  readonly cycle: number;
  readonly groups: readonly GroupId[];
  readonly crossings: readonly CrossingId[];
}

export class PlanValidationError extends Error {}

/** Builds a fixed-time plan for one junction and validates it before returning. */
export function buildSignalPlan(
  junction: JunctionTopology,
  crossings: readonly CrossingId[],
  connectorsOf: (id: string) => Connector | undefined,
  conflictsOf?: (id: string) => readonly string[],
  approachSpeed?: (lane: string) => number,
): SignalPlan {
  const raw = buildStages(junction, crossings, connectorsOf, conflictsOf);
  const plan = annotate(raw, junction, connectorsOf, conflictsOf);
  return validate(approachSpeed && junction.signalised ? withAmbers(plan, junction, connectorsOf, approachSpeed) : plan);
}

/** Perception-reaction time of the yellow interval, s (ITE). */
const AMBER_REACTION = 1;
/** Comfortable deceleration of the yellow interval, m/s² (ITE: 10 ft/s²). */
const AMBER_DECELERATION = 3.05;
/** Longest yellow change interval, s (MUTCD: 3 to 6 s). */
const AMBER_MAX = 6;
/** The 85th-percentile approach speed over the limit, m/s, where it is not measured (ITE RP-040B: limit + 7 mph). */
const APPROACH_OVER_LIMIT = 3.13;

/** Each stage's yellow from the fastest approach it releases, by the ITE kinematic formula Y = t + V / 2a (level ground) */
function withAmbers(plan: SignalPlan, junction: JunctionTopology, connectorsOf: (id: string) => Connector | undefined,
  approachSpeed: (lane: string) => number): SignalPlan {
  const fastest = new Map<GroupId, number>();
  for (const id of junction.connectors) {
    const c = connectorsOf(id);
    if (!c) continue;
    fastest.set(c.group, Math.max(fastest.get(c.group) ?? 0, approachSpeed(c.fromLane)));
  }
  const stages = plan.stages.map((s) => {
    const limit = s.greenGroups.reduce((most, g) => Math.max(most, fastest.get(g) ?? 0), 0) * METERS_PER_UNIT;
    if (limit <= 0) return s;
    const speed = limit + APPROACH_OVER_LIMIT;
    const amber = clamp(AMBER_REACTION + speed / (2 * AMBER_DECELERATION), SIGNAL.amber, AMBER_MAX);
    return amber === s.amber ? s : { ...s, amber };
  });
  const cycle = stages.reduce((sum, s) => sum + s.targetGreen + s.amber + s.allRed, 0);
  return { ...plan, stages, cycle };
}

/** Marks every stage's protected movements from the real conflict matrix and adds an exclusive stage for any approach whose */
function annotate(
  plan: SignalPlan,
  junction: JunctionTopology,
  connectorsOf: (id: string) => Connector | undefined,
  conflictsOf?: (id: string) => readonly string[],
): SignalPlan {
  const connectors = junction.connectors
    .map(connectorsOf)
    .filter((c): c is Connector => !!c);
  const protectedIn = (green: readonly GroupId[]): string[] => connectors
    .filter((c) => green.includes(c.group))
    .filter((c) => {
      if (!conflictsOf) return c.turn === 'through';
      return conflictsOf(c.id).every((otherId) => {
        const other = connectorsOf(otherId);
        return !other || other.inSegment === c.inSegment || !green.includes(other.group) ||
          TURN_RANK[other.turn] < TURN_RANK[c.turn];
      });
    })
    .map((c) => c.id);

  const stages: Stage[] = plan.stages.map((s) => ({ ...s, protectedMovements: protectedIn(s.greenGroups) }));

  if (conflictsOf && junction.signalised && junction.groups.length > 1) {
    for (const group of junction.groups) {
      const mine = connectors.filter((c) => c.group === group.id);
      const serving = stages.filter((s) => s.greenGroups.includes(group.id));
      const neverProtected = mine.filter((c) =>
        c.turn !== 'through' && serving.every((s) => !s.protectedMovements.includes(c.id)));
      if (!neverProtected.length) continue;
      const green = [group.id];
      stages.push({
        ...stage({
          green,
          // No WALK: a turn stage is too short for anybody to finish crossing, so its lamp would only ever flash
          pedWalk: [],
          target: SIGNAL.exclusiveGreen,
        }),
        // Short: it only serves the turns that could not find a gap
        maxGreen: SIGNAL.exclusiveGreen * EXCLUSIVE_MAX_FACTOR,
        protectedMovements: protectedIn(green),
        demandMovements: neverProtected.map((c) => c.id),
      });
    }
  }

  const cycle = stages.reduce((sum, s) => sum + s.targetGreen + s.amber + s.allRed, 0);
  return { ...plan, stages, cycle };
}

const EXCLUSIVE_MAX_FACTOR = 1.6;

/** Who gives way to whom between two green movements that cross. */
const TURN_RANK: Record<Connector['turn'], number> = { through: 3, right: 2, left: 1, uturn: 0 };

function buildStages(
  junction: JunctionTopology,
  crossings: readonly CrossingId[],
  connectorsOf: (id: string) => Connector | undefined,
  conflictsOf?: (id: string) => readonly string[],
): SignalPlan {
  const groups = junction.groups.map((g) => g.id);

  if (!junction.signalised) {
    // Unsignalised junctions hold a permanent green; right of way is resolved by gap acceptance instead.
    return validate({
      stages: [
        stage({
          green: groups,
          pedWalk: crossings,
          target: SIGNAL.uncontrolledGreen,
        }),
      ],
      cycle: SIGNAL.uncontrolledGreen,
      groups,
      crossings,
    });
  }

  if (groups.length <= 1) {
    // A signalised junction still needs a real cycle when all its approaches collapse into one geometry group.
    const compatible = crossingsCompatibleWith(
      junction,
      groups,
      crossings,
      connectorsOf,
    );
    const compatibleSet = new Set(compatible);
    const uncovered = crossings.filter((crossing) => !compatibleSet.has(crossing));
    const exclusiveCrossings = groups.length === 0 ? crossings : uncovered;
    const stages: Stage[] = [];

    if (groups.length) {
      stages.push(
        stage({
          green: groups,
          pedWalk: compatible,
          target: SIGNAL.baseGreen,
        }),
      );
    }
    if (exclusiveCrossings.length || groups.length === 0) {
      stages.push(
        stage({
          green: [],
          pedWalk: exclusiveCrossings,
          target: SIGNAL.baseGreen,
          exclusivePed: true,
        }),
      );
    }

    const cycle = stages.reduce((sum, current) =>
      sum + current.targetGreen + current.amber + current.allRed, 0);
    return validate({ stages, cycle, groups, crossings });
  }

  const stages: Stage[] = [];
  const covered = new Set<CrossingId>();
  const together_ = conflictsOf
    ? conflictFreeStages(junction, connectorsOf, conflictsOf)
    : pairOpposingGroups(junction);
  for (const together of together_) {
    const green = clamp(SIGNAL.baseGreen, SIGNAL.minGreen, SIGNAL.maxGreen);
    const walk = crossingsCompatibleWith(junction, together, crossings, connectorsOf);
    for (const crossing of walk) covered.add(crossing);
    stages.push(stage({ green: together, pedWalk: walk, target: green }));
  }

  // A crossing that no vehicle stage can safely share still has to be served
  const uncovered = crossings.filter((crossing) => !covered.has(crossing));
  if (uncovered.length) {
    stages.push(
      stage({
        green: [],
        pedWalk: uncovered,
        target: SIGNAL.baseGreen,
        exclusivePed: true,
      }),
    );
  }

  const cycle = stages.reduce((s, st) => s + st.targetGreen + st.amber + st.allRed, 0);
  return validate({ stages, cycle, groups, crossings });
}

/** Groups that may take green together WITHOUT any two of their movements crossing, merging or sweeping into one another. */
function conflictFreeStages(
  junction: JunctionTopology,
  connectorsOf: (id: string) => Connector | undefined,
  conflictsOf: (id: string) => readonly string[],
): GroupId[][] {
  const movements = new Map<GroupId, Connector[]>();
  for (const id of junction.connectors) {
    const c = connectorsOf(id);
    if (!c) continue;
    const list = movements.get(c.group);
    if (list) list.push(c);
    else movements.set(c.group, [c]);
  }
  const compatible = (a: GroupId, b: GroupId): boolean => {
    const theirs = new Set((movements.get(b) ?? []).map((c) => c.id));
    for (const c of movements.get(a) ?? []) {
      for (const other of conflictsOf(c.id)) {
        if (!theirs.has(other)) continue;
        const o = connectorsOf(other);
        // Two movements of one approach leave side by side; that is lane discipline and car-following, not a signal conflict.
        if (o && o.inSegment === c.inSegment) continue;
        return false;
      }
    }
    return true;
  };

  const pending = junction.groups.slice().sort((a, b) => a.meanAngle - b.meanAngle || a.id - b.id);
  const byId = new Map(pending.map((g) => [g.id, g] as const));
  const stages: GroupId[][] = [];
  while (pending.length) {
    const head = pending.shift();
    if (!head) break;
    const stage = [head.id];
    for (;;) {
      let best = -1;
      let bestError = Infinity;
      for (let i = 0; i < pending.length; i++) {
        const candidate = pending[i]!;
        if (!stage.every((g) => compatible(g, candidate.id) && compatible(candidate.id, g))) continue;
        const error = Math.min(...stage.map((g) => Math.abs(
          Math.abs(normaliseAngle(candidate.meanAngle - (byId.get(g)?.meanAngle ?? 0))) - Math.PI)));
        if (error < bestError) {
          bestError = error;
          best = i;
        }
      }
      if (best < 0) break;
      stage.push(pending.splice(best, 1)[0]!.id);
    }
    stages.push(stage);
  }
  return stages;
}

/** Groups that may take green together, as one entry per stage. */
const OPPOSED_TOLERANCE = (35 * Math.PI) / 180;

function pairOpposingGroups(junction: JunctionTopology): GroupId[][] {
  const pending = junction.groups.slice();
  const stages: GroupId[][] = [];

  while (pending.length) {
    const head = pending.shift();
    if (!head) break;

    let bestIndex = -1;
    let bestError = OPPOSED_TOLERANCE;
    for (let i = 0; i < pending.length; i++) {
      const candidate = pending[i];
      if (!candidate) continue;
      // How far from anti-parallel the two mean directions are.
      const delta = Math.abs(
        Math.abs(normaliseAngle(candidate.meanAngle - head.meanAngle)) - Math.PI,
      );
      if (delta < bestError) {
        bestError = delta;
        bestIndex = i;
      }
    }

    if (bestIndex < 0) {
      stages.push([head.id]);
      continue;
    }
    const partner = pending.splice(bestIndex, 1)[0];
    stages.push(partner ? [head.id, partner.id] : [head.id]);
  }

  return stages;
}

/** Wraps an angle into (-PI, PI]. */
const normaliseAngle = (a: number): number => {
  let x = a % (2 * Math.PI);
  if (x > Math.PI) x -= 2 * Math.PI;
  if (x <= -Math.PI) x += 2 * Math.PI;
  return x;
};

interface StageInput {
  readonly green: readonly GroupId[];
  readonly pedWalk: readonly CrossingId[];
  readonly target: number;
  readonly exclusivePed?: boolean;
}

function stage(input: StageInput): Stage {
  return {
    greenGroups: input.green,
    pedWalk: input.pedWalk,
    minGreen: SIGNAL.minGreen,
    maxGreen: SIGNAL.maxGreen,
    targetGreen: input.target,
    amber: SIGNAL.amber,
    allRed: SIGNAL.minAllRed,
    exclusivePed: input.exclusivePed ?? false,
    protectedMovements: [],
  };
}

/** A crossing over leg L may show WALK during a stage if and only if no connector green in that stage DEPARTS from L. */
export function crossingsCompatibleWith(
  junction: JunctionTopology,
  greenGroups: readonly GroupId[],
  crossings: readonly CrossingId[],
  connectorsOf: (id: string) => Connector | undefined,
): CrossingId[] {
  const green = junction.connectors
    .map(connectorsOf)
    .filter((c): c is Connector => !!c && greenGroups.includes(c.group));

  return crossings.filter((x) => {
    const segment = crossingSegment(x);
    // The leg being ENTERED is driven over by every green movement using it, turning or not
    if (green.some((c) => c.inSegment === segment)) return false;
    // The leg being LEFT is driven over on the way out.
    return !green.some((c) => c.outSegment === segment && !mustYieldToPeds(c));
  });
}

/** True when this connector must yield to pedestrians already in the crossing over its destination leg. */
const mustYieldToPeds = (c: Connector): boolean => c.turn !== 'through';

/** Crossing ids are `${nodeId}:${segmentId}`. */
export const makeCrossingId = (node: NodeId, segment: number): CrossingId =>
  `${node}:${segment}`;

export const crossingSegment = (id: CrossingId): number =>
  Number(id.slice(id.indexOf(':') + 1));

function validate(plan: SignalPlan): SignalPlan {
  const covered = new Set<GroupId>();
  for (const s of plan.stages) for (const g of s.greenGroups) covered.add(g);

  // I0 - coverage: no group may be left permanently red.
  const missing = plan.groups.filter((g) => !covered.has(g));
  if (missing.length) {
    throw new PlanValidationError(
      `signal plan leaves group(s) permanently red: ${missing.join(', ')}`,
    );
  }

  // I1 - liveness: when vehicle groups exist, at least one stage serves them.
  if (
    plan.groups.length > 0 &&
    !plan.stages.some((s) => !s.exclusivePed && s.greenGroups.length > 0)
  ) {
    throw new PlanValidationError('signal plan has no vehicle stage');
  }

  // I3 - every crossing gets WALK somewhere.
  const walkable = new Set<CrossingId>();
  for (const s of plan.stages) for (const x of s.pedWalk) walkable.add(x);
  const stranded = plan.crossings.filter((x) => !walkable.has(x));
  if (stranded.length) {
    throw new PlanValidationError(`crossing(s) never get WALK: ${stranded.join(', ')}`);
  }

  // I4 - each stage is long enough for the pedestrians it releases.
  for (const s of plan.stages) {
    const available = s.targetGreen + s.amber + s.allRed;
    if (s.pedWalk.length && available < PED.startLag) {
      throw new PlanValidationError('stage too short for pedestrian clearance');
    }
  }

  return Object.freeze({ ...plan, stages: Object.freeze(plan.stages) });
}

/** Fallback plan used when validation fails in a production build. */
export function roundRobinPlan(groups: readonly GroupId[], crossings: readonly CrossingId[]): SignalPlan {
  const stages = groups.map((g) =>
    // The fallback has no connector topology with which to prove that a crossing is compatible.
    stage({ green: [g], pedWalk: [], target: SIGNAL.baseGreen }),
  );
  if (crossings.length || groups.length === 0) {
    stages.push(
      stage({
        green: [],
        pedWalk: crossings,
        target: SIGNAL.baseGreen,
        exclusivePed: true,
      }),
    );
  }
  const cycle = stages.reduce((s, st) => s + st.targetGreen + st.amber + st.allRed, 0);
  return Object.freeze({ stages: Object.freeze(stages), cycle, groups, crossings });
}

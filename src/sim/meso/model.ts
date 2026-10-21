import { kmh, m } from '@world/units';
import { BlockArena, Threads, grown } from './slots';

/** THE MESO TRAFFIC OF THE WHOLE MAP: each directed road a link of the Link Transmission Model, flows between them at the nodes */
// LTM (Yperman 2007 §4.6; Boyles et al., Transportation Network Analysis I §9.5.2): S = min(N_up(t+dt-L/v) - N_down(t), C dt), R = min(N_down(t+dt-L/w) + k_jam L - N_up(t), C dt).
// Node model: equal-priority movements by capacity, FIFO hold-back at a diverge (Tampère et al. 2011, restated in tabenchmark ADR-017).

/** Room a car takes standing in a queue, bumper to bumper, per lane (jam density 1 / 7.5 m). */
export const JAM_SPACING = m(7.5);
/** How fast a queue's tail moves back (the backward wave), 18 km/h: the usual 15 to 20 km/h of measured urban queues. */
export const WAVE_SPEED = kmh(18);
/** Share of the hour a lane into a signal has green, on average. */
const GREEN_SHARE = 0.5;
/** Cars queued at an origin (an entry of the map, a street's driveways) per lane before more are lost, as `vehicles/spawn.ts` ENTRY_QUEUE. */
const ORIGIN_QUEUE = 6;
const EPS = 1e-9;

/** A lane's capacity, vehicles a second: the triangular diagram's peak, v w k_jam / (v + w) (about 1,900 an hour at 50 km/h). */
export function laneCapacity(vFree: number): number {
  const v = Math.max(m(0.5), vFree);
  return (v * WAVE_SPEED) / ((v + WAVE_SPEED) * JAM_SPACING);
}

/** A link's capacity, vehicles a second: its lanes', times the green's share into a signal or a stop line. */
export function linkCapacity(vFree: number, lanes: number, controlled: boolean): number {
  return laneCapacity(vFree) * Math.max(1, lanes) * (controlled ? GREEN_SHARE : 1);
}

/** One directed road: what the model needs of it. */
export interface MesoLinkSpec {
  /** The node it runs into: the node model groups its links by it. */
  readonly to: number;
  readonly lanes: number;
  readonly length: number;
  /** Free speed, world units a second. */
  readonly vFree: number;
  /** Into a signal: its capacity is the green's share of the lanes'. */
  readonly controlled?: boolean;
  /** Vehicles a second the whole link discharges; by default its lanes' (`laneCapacity`), times the green's share into a signal. */
  readonly capacity?: number;
  /** Ends at the map's edge: what reaches its end leaves the map. */
  readonly exit: boolean;
}

/** The model over links by slot (a slot is a directed road, `meso.ts`), all in typed arrays: no object, list or Map entry a link. */
export class MesoModel {
  private size = 0;
  private cap = 0;
  private present = new Uint8Array(0);
  private exitOf = new Uint8Array(0);
  private insideOf = new Uint8Array(0);
  /** Node ids: a tile's pass 2^31 (`tileIdBase`), so doubles. */
  private toOf = new Float64Array(0);
  private lanesOf = new Float64Array(0);
  private lengthOf = new Float64Array(0);
  private vFreeOf = new Float64Array(0);
  private capOf = new Float64Array(0);
  /** Share of what reaches the end of a link that ends its trip there (parks, turns into a lot): set by the owner each tick. */
  private sinkOf = new Float64Array(0);
  /** Vehicles a second wanting to start on the link (from off the map, from its street's lots): set by the owner each tick. */
  private genOf = new Float64Array(0);
  private origin = new Float64Array(0);
  /** Vehicles handed to the micro simulation inside its window, not on the road yet. */
  private pendingOf = new Float64Array(0);
  /** Vehicles the micro simulation has on a link inside its window (`setMicro`). */
  private microOf = new Float64Array(0);
  private sending = new Float64Array(0);
  private room = new Float64Array(0);
  private inflow = new Float64Array(0);
  private outflow = new Float64Array(0);
  private left = new Float64Array(0);
  private wanted = new Float64Array(0);
  /** A node's round of the node model: the demand on each exit (cleared after each round). */
  private exitDemand = new Float64Array(0);
  private live = new Uint8Array(0);
  /** Cumulative counts at each end, back in time a step a cell (rings): entries upstream, exits downstream; each a block of `rings` (-1: none). */
  private readonly rings = new BlockArena();
  private upAt = new Int32Array(0);
  private upLen = new Int32Array(0);
  private downAt = new Int32Array(0);
  private downLen = new Int32Array(0);
  /** Each link's turns: a block of `turns`, the links it feeds then the share going to each (summing to 1); none when `turnLen` is 0. */
  private readonly turns = new BlockArena();
  private turnAt = new Int32Array(0);
  private turnLen = new Int32Array(0);
  /** The links into each node, in the order they came. */
  private readonly into = new Threads();
  private tick = 0;

  /** Since the start: vehicles generated, lost at a full origin, arrived (sunk or off the map), handed in by the micro simulation and out to it. */
  generated = 0;
  lost = 0;
  sunk = 0;
  handedIn = 0;
  handedOut = 0;

  constructor(readonly dt = 1) {}

  /** One past the highest slot ever set. */
  get slots(): number {
    return this.size;
  }

  /** Bytes the model holds: its tables by slot, the rings' and turns' arenas, the nodes' lists. */
  get bytes(): number {
    return this.cap * (3 + 17 * 8 + 6 * 4 + 1) + this.rings.bytes + this.turns.bytes + this.into.bytes;
  }

  has(slot: number): boolean {
    return slot < this.size && this.present[slot] === 1;
  }

  isInside(slot: number): boolean {
    return this.has(slot) && this.insideOf[slot] === 1;
  }

  /** The links into `node`, in the order they came. */
  inLinks(node: number): readonly number[] {
    return this.into.list(node);
  }

  /** A link made or changed: its vehicles kept (spread along it again when its length or speed changed). */
  setLink(slot: number, spec: MesoLinkSpec): void {
    this.finish();
    this.reserve(slot + 1);
    const had = this.has(slot);
    const keep = had ? this.count(slot) : 0;
    if (!had || this.toOf[slot] !== spec.to) this.into.add(slot, spec.to);
    const lanes = Math.max(1, spec.lanes);
    const changed = !had || this.lengthOf[slot] !== spec.length || this.vFreeOf[slot] !== spec.vFree;
    this.present[slot] = 1;
    this.toOf[slot] = spec.to;
    this.lanesOf[slot] = lanes;
    this.lengthOf[slot] = Math.max(m(1), spec.length);
    this.vFreeOf[slot] = Math.max(m(0.5), spec.vFree);
    this.capOf[slot] = Math.max(0, spec.capacity ?? linkCapacity(spec.vFree, lanes, spec.controlled ?? false));
    this.exitOf[slot] = spec.exit ? 1 : 0;
    if (!had) { this.insideOf[slot] = 0; this.pendingOf[slot] = 0; this.microOf[slot] = 0; this.origin[slot] = 0; }
    if (changed && this.insideOf[slot] === 0) this.spread(slot, keep);
  }

  /** A link gone: what was on it and waiting for it leaves the model (counted as arrived); its blocks given back. */
  dropLink(slot: number): void {
    this.finish();
    if (!this.has(slot)) return;
    this.sunk += this.count(slot) + this.origin[slot]!;
    if (this.insideOf[slot]) this.sunk -= this.microOf[slot]!;
    this.into.remove(slot);
    this.present[slot] = 0;
    this.insideOf[slot] = 0;
    this.pendingOf[slot] = 0;
    this.microOf[slot] = 0;
    this.origin[slot] = 0;
    this.dropRings(slot);
    this.dropTurns(slot);
  }

  /** The links `slot` feeds, each with its weight (normalised here); none: everything reaching its end leaves the network. */
  setTurns(slot: number, to: readonly number[], weights: readonly number[]): void {
    this.finish();
    if (!this.has(slot)) return;
    let sum = 0;
    for (const w of weights) sum += Math.max(0, w);
    this.dropTurns(slot);
    if (!to.length || sum <= 0) return;
    const n = to.length, at = this.turns.alloc(2 * n), d = this.turns.data;
    for (let k = 0; k < n; k++) {
      d[at + k] = to[k]! | 0;
      d[at + n + k] = Math.max(0, weights[k]!) / sum;
    }
    this.turnAt[slot] = at;
    this.turnLen[slot] = n;
  }

  setGeneration(slot: number, perSecond: number): void {
    this.finish();
    if (this.has(slot)) this.genOf[slot] = Math.max(0, perSecond);
  }

  /** Every link's generation and sink share from its cell's demand (`meso.ts` rates), read from the arrays here: DO NOT ask a link's length, lanes and speed by calls, each double handed back a new heap number a link a step.
   *  `entry`: each slot's trips from off the world; `cars`, `weight`: its cell's cars per 100 m and the share of trips ending there; the slots in [`from`, `to`) only (the meso's step spread over ticks, `meso.ts`). */
  setRates(entry: Float64Array, cars: Float64Array, weight: Float64Array, per100m: number, tripLength: number, scale: number, from = 0, to = this.size): void {
    this.finish();
    for (let slot = from, end = Math.min(to, this.size); slot < end; slot++) {
      if (this.present[slot] !== 1) continue;
      const L = this.lengthOf[slot]!;
      // As `setGeneration` and `setSinkShare` clamp them.
      this.genOf[slot] = Math.max(0, (entry[slot]! + cars[slot]! * (L / per100m) * this.vFreeOf[slot]! / tripLength) * scale);
      this.sinkOf[slot] = Math.min(1, Math.max(0, Math.min(1, L / tripLength) * weight[slot]!));
    }
  }

  setSinkShare(slot: number, share: number): void {
    this.finish();
    if (this.has(slot)) this.sinkOf[slot] = Math.min(1, Math.max(0, share));
  }

  /** Vehicles on the link: on the road (outside the window), or the micro simulation's and those waiting to be made there (inside). */
  count(slot: number): number {
    if (!this.has(slot)) return 0;
    if (this.insideOf[slot]) return this.microOf[slot]! + this.pendingOf[slot]!;
    return Math.max(0, this.cum(this.upAt[slot]!, this.upLen[slot]!, 0) - this.cum(this.downAt[slot]!, this.downLen[slot]!, 0));
  }

  /** Vehicles standing in the link's queue: those that have had the time to reach its end and not left. */
  queued(slot: number): number {
    if (!this.has(slot) || this.insideOf[slot]) return 0;
    const L = this.lengthOf[slot]!, v = this.vFreeOf[slot]!;
    const reached = this.cum(this.upAt[slot]!, this.upLen[slot]!, L / v / this.dt) - this.cum(this.downAt[slot]!, this.downLen[slot]!, 0);
    return Math.min(this.count(slot), Math.max(0, reached));
  }

  /** The link's mean speed: its length over the free run plus the wait in its queue at the discharge rate. */
  speed(slot: number): number {
    if (!this.has(slot)) return 0;
    const L = this.lengthOf[slot]!, v = this.vFreeOf[slot]!, q = this.queued(slot), c = this.capOf[slot]!;
    if (q <= EPS) return v;
    return c > EPS ? L / (L / v + q / c) : 0;
  }

  /**
   * `count`, `queued` and `speed` of a present link at once, into `out` (the page's buffer, `meso.ts` publish): the same numbers,
   * from three interpolations of the rings, not ten (`queued` counts again, `speed` queues again; SIM-26).
   */
  flowInto(slot: number, out: { count: number; queued: number; speed: number }): void {
    const v = this.vFreeOf[slot]!;
    if (this.insideOf[slot]) {
      out.count = this.microOf[slot]! + this.pendingOf[slot]!;
      out.queued = 0;
      out.speed = v;
      return;
    }
    const L = this.lengthOf[slot]!, c = this.capOf[slot]!;
    const ua = this.upAt[slot]!, ul = this.upLen[slot]!;
    const down = this.cum(this.downAt[slot]!, this.downLen[slot]!, 0);
    const count = Math.max(0, this.cum(ua, ul, 0) - down);
    const q = Math.min(count, Math.max(0, this.cum(ua, ul, L / v / this.dt) - down));
    out.count = count;
    out.queued = q;
    out.speed = q <= EPS ? v : c > EPS ? L / (L / v + q / c) : 0;
  }

  /** `n` vehicles put on a link outside the window, spread along it in free flow (counted as generated). */
  seed(slot: number, n: number): void {
    this.finish();
    if (!this.has(slot) || this.insideOf[slot] || n <= 0) return;
    this.generated += n;
    this.spread(slot, this.count(slot) + n);
  }

  freeSpeedAt(slot: number): number {
    return this.has(slot) ? this.vFreeOf[slot]! : 0;
  }

  lengthAt(slot: number): number {
    return this.has(slot) ? this.lengthOf[slot]! : 0;
  }

  lanesAt(slot: number): number {
    return this.has(slot) ? this.lanesOf[slot]! : 0;
  }

  capacityAt(slot: number): number {
    return this.has(slot) ? this.capOf[slot]! : 0;
  }

  /** The node the link runs into (NaN: no link). */
  toAt(slot: number): number {
    return this.has(slot) ? this.toOf[slot]! : Number.NaN;
  }

  /** The links `slot` feeds (`setTurns`). */
  turnsAt(slot: number): readonly number[] {
    const n = this.has(slot) ? this.turnLen[slot]! : 0;
    if (!n) return NONE;
    const at = this.turnAt[slot]!, d = this.turns.data, out: number[] = [];
    for (let k = 0; k < n; k++) out.push(d[at + k]!);
    return out;
  }

  pending(slot: number): number {
    return this.has(slot) ? this.pendingOf[slot]! : 0;
  }

  /** Last step's flow out of the link's end and onto its start, vehicles. */
  outflowOf(slot: number): number {
    return slot < this.size ? this.outflow[slot]! : 0;
  }

  inflowOf(slot: number): number {
    return slot < this.size ? this.inflow[slot]! : 0;
  }

  /** Every vehicle the model holds: on links outside the window, waiting at origins, and handed to the window not made yet. */
  vehicles(): number {
    let n = 0;
    for (let s = 0; s < this.size; s++) {
      if (!this.present[s]) continue;
      n += this.origin[s]! + (this.insideOf[s] ? this.pendingOf[s]! : this.count(s));
    }
    return n;
  }

  /** The link comes into the micro window: its vehicles are handed over (`pending`), its own counts set aside. */
  enterWindow(slot: number): number {
    this.finish();
    if (!this.has(slot) || this.insideOf[slot]) return 0;
    const n = this.count(slot);
    this.insideOf[slot] = 1;
    this.pendingOf[slot] = n;
    this.microOf[slot] = 0;
    this.dropRings(slot);
    return n;
  }

  /** The link leaves the micro window with `micro` vehicles of the micro simulation on it (taken off there): they and the pending are the model's again. */
  leaveWindow(slot: number, micro: number): void {
    this.finish();
    if (!this.has(slot) || !this.insideOf[slot]) return;
    const n = micro + this.pendingOf[slot]!;
    this.handedIn += micro;
    this.insideOf[slot] = 0;
    this.pendingOf[slot] = 0;
    this.microOf[slot] = 0;
    this.spread(slot, n);
  }

  /** The micro simulation's vehicles on a link inside the window, for its supply. */
  setMicro(slot: number, n: number): void {
    if (this.isInside(slot)) this.microOf[slot] = n;
  }

  /** `k` of the link's pending vehicles made by the micro simulation. */
  takePending(slot: number, k: number): void {
    if (!this.isInside(slot)) return;
    const take = Math.min(k, this.pendingOf[slot]!);
    this.pendingOf[slot] = this.pendingOf[slot]! - take;
    this.handedOut += take;
  }

  /** A vehicle of the micro simulation drove out of the window onto `slot`: it enters the link now. */
  microExit(slot: number): void {
    this.finish();
    if (!this.has(slot) || this.insideOf[slot]) return;
    const at = this.upAt[slot]! + this.ringAt(this.upLen[slot]!, 0), d = this.rings.data;
    d[at] = d[at]! + 1;
    this.handedIn++;
  }

  /** The links of the micro window handed a whole vehicle or more by the last step (`pending`): the micro simulation is to make them (`meso.ts` admit). */
  readonly handed: number[] = [];

  /** Where the step under way stands (`stepSome`): -1 none; 0 the links' sending and receiving flows; 1 the nodes; 2 the origins; 3 the counts moved on. */
  private phase = -1;
  private cursor = 0;

  /** Whether a step is under way (begun by `stepSome`, not finished). */
  get stepping(): boolean {
    return this.phase >= 0;
  }

  /** One whole step of `dt`: origins fed, sending and receiving flows, each node's transfers, the cumulative counts moved on. */
  step(): void {
    this.stepSome(Infinity);
  }

  /**
   * Up to `budget` links and nodes of a step (one begun when none is under way); the budget left (the step is done when `stepping` is false).
   * DO NOT step the whole map in one tick: the step is spread over the ticks of its `dt` (`meso.ts`), each phase resumed where it
   * stopped. Spread or whole, a step gives the same numbers: anything that changes the links finishes the step under way first
   * (`finish`), so a step never sees a link change half way.
   */
  stepSome(budget: number): number {
    if (this.phase < 0) this.beginStep();
    let left = budget;
    while (left > 0) {
      if (this.phase === 0) {
        const end = Math.min(this.size, this.cursor + left);
        this.linkFlows(this.cursor, end);
        left -= end - this.cursor;
        this.cursor = end;
        if (end >= this.size) { this.phase = 1; this.cursor = 0; }
      } else if (this.phase === 1) {
        const limit = this.into.groupLimit, end = Math.min(limit, this.cursor + left);
        for (let g = this.cursor; g < end; g++) this.node(g);
        left -= end - this.cursor;
        this.cursor = end;
        if (end >= limit) { this.sunk = this.tally[0]!; this.phase = 2; this.cursor = 0; }
      } else if (this.phase === 2) {
        const end = Math.min(this.size, this.cursor + left);
        this.originsIn(this.cursor, end);
        left -= end - this.cursor;
        this.cursor = end;
        if (end >= this.size) { this.phase = 3; this.cursor = 0; }
      } else {
        const end = Math.min(this.size, this.cursor + left);
        this.moveCounts(this.cursor, end);
        left -= end - this.cursor;
        this.cursor = end;
        if (end >= this.size) { this.tick++; this.phase = -1; this.cursor = 0; return left; }
      }
    }
    return left;
  }

  /** The step under way finished now (a link about to change). */
  private finish(): void {
    if (this.phase >= 0) this.stepSome(Infinity);
  }

  private beginStep(): void {
    this.handed.length = 0;
    // What the nodes sink, added in `tally` in their order and stored once (`stepSome`).
    this.tally[0] = this.sunk;
    this.phase = 0;
    this.cursor = 0;
  }

  /** The sending and receiving flows of the links in [`from`, `to`), and their origins fed. */
  private linkFlows(from: number, to: number): void {
    const dt = this.dt;
    // The tallies summed here and stored once a run, in the same order: DO NOT add to a field a link at a time, a double stored in a field being a new heap number each time (the 20 km's garbage between collections, sim20a).
    let generated = this.generated, lost = this.lost;
    for (let s = from; s < to; s++) {
      this.inflow[s] = 0;
      this.outflow[s] = 0;
      this.sending[s] = 0;
      this.room[s] = 0;
      if (!this.present[s]) continue;
      const L = this.lengthOf[s]!, lanes = this.lanesOf[s]!, cdt = this.capOf[s]! * dt;
      const storage = (L * lanes) / JAM_SPACING;
      if (this.insideOf[s]) {
        this.room[s] = Math.max(0, Math.min(cdt, storage - this.microOf[s]! - this.pendingOf[s]!));
      } else {
        const ua = this.upAt[s]!, ul = this.upLen[s]!, da = this.downAt[s]!, dl = this.downLen[s]!;
        // `cum` written out here, not called: every double handed to or back from a call left out of line was a new heap number, four a link a step (the 20 km's ~1 GB of garbage between collections, sim20a).
        const ring = this.rings.data, tick = this.tick;
        const up0 = ring[ua + ((tick % ul) + ul) % ul]!, down0 = ring[da + ((tick % dl) + dl) % dl]!;
        let b = Math.min(ul - 1, Math.max(0, Math.max(0, L / this.vFreeOf[s]! / dt - 1)));
        let k0 = Math.floor(b), k1 = Math.min(ul - 1, k0 + 1), f = b - k0;
        let a = ring[ua + (((tick - k0) % ul) + ul) % ul]!;
        const free = f > 0 ? a + (ring[ua + (((tick - k1) % ul) + ul) % ul]! - a) * f : a;
        this.sending[s] = Math.max(0, Math.min(free - down0, cdt, up0 - down0));
        b = Math.min(dl - 1, Math.max(0, Math.max(0, L / WAVE_SPEED / dt - 1)));
        k0 = Math.floor(b); k1 = Math.min(dl - 1, k0 + 1); f = b - k0;
        a = ring[da + (((tick - k0) % dl) + dl) % dl]!;
        const back = f > 0 ? a + (ring[da + (((tick - k1) % dl) + dl) % dl]! - a) * f : a;
        this.room[s] = Math.max(0, Math.min(back + storage - up0, cdt));
      }
      // The origin: what wants to start, up to its queue; the rest is lost.
      const arrive = this.genOf[s]! * dt;
      if (arrive > 0) {
        generated += arrive;
        const most = ORIGIN_QUEUE * lanes;
        const next = this.origin[s]! + arrive;
        if (next > most) { lost += next - most; this.origin[s] = most; } else this.origin[s] = next;
      }
    }
    this.generated = generated;
    this.lost = lost;
  }

  /** Starting from the street (a driveway, the map's edge) gives way to the through traffic: what room is left, for the links in [`from`, `to`). */
  private originsIn(from: number, to: number): void {
    for (let s = from; s < to; s++) {
      if (!this.present[s] || this.origin[s]! <= 0) continue;
      const go = Math.min(this.origin[s]!, this.room[s]!);
      if (go <= 0) continue;
      this.origin[s] = this.origin[s]! - go;
      this.room[s] = this.room[s]! - go;
      this.inflow[s] = this.inflow[s]! + go;
    }
  }

  /** The cumulative counts of the links in [`from`, `to`) moved on by the step's flows; the window's links handed what came in. */
  private moveCounts(from: number, to: number): void {
    const d = this.rings.data;
    for (let s = from; s < to; s++) {
      if (!this.present[s]) continue;
      if (this.insideOf[s]) {
        this.pendingOf[s] = this.pendingOf[s]! + this.inflow[s]!;
        if (this.inflow[s]! > 0 && this.pendingOf[s]! >= 1) this.handed.push(s);
        continue;
      }
      const ua = this.upAt[s]!, ul = this.upLen[s]!, da = this.downAt[s]!, dl = this.downLen[s]!, tick = this.tick;
      // `cum` at no run back, written out (as above).
      const up0 = d[ua + ((tick % ul) + ul) % ul]!, down0 = d[da + ((tick % dl) + dl) % dl]!;
      d[ua + this.ringAt(ul, -1)] = up0 + this.inflow[s]!;
      d[da + this.ringAt(dl, -1)] = down0 + this.outflow[s]!;
    }
  }

  /** One node (its group of links in): the approaches' sending flows to their turns, by equal-priority movements, up to each exit's room. */
  private node(g: number): void {
    const ins = this.into, T = this.turns.data, turnAt = this.turnAt, turnLen = this.turnLen;
    let anyLive = false;
    for (let i = ins.head(g); i >= 0; i = ins.after(i)) {
      this.live[i] = 0;
      const sink = this.exitOf[i] || !turnLen[i] ? 1 : this.sinkOf[i]!;
      this.wanted[i] = this.sending[i]! * (1 - sink);
      this.left[i] = this.wanted[i]!;
      if (this.left[i]! > EPS) { this.live[i] = 1; anyLive = true; }
    }
    // Each round ends an approach or fills an exit: at most as many rounds as both.
    const approaches = ins.count(g);
    for (let round = 0; anyLive && round <= 2 * approaches + 1; round++) {
      // The exits' demand this round: each live approach at its capacity, split by its turns.
      let theta = Infinity;
      for (let i = ins.head(g); i >= 0; i = ins.after(i)) {
        if (!this.live[i]) continue;
        // An approach's priority (its capacity over a step; a closed one still served in proportion), and an exit's room (none for a link gone), written out here: no number handed back by a call (`cumInto`).
        const c = Math.max(EPS, this.capOf[i]! * this.dt), at = turnAt[i]!, n = turnLen[i]!;
        theta = Math.min(theta, this.left[i]! / c);
        for (let k = 0; k < n; k++) { const j = T[at + k]!; this.exitDemand[j] = this.exitDemand[j]! + c * T[at + n + k]!; }
      }
      for (let i = ins.head(g); i >= 0; i = ins.after(i)) {
        if (!this.live[i]) continue;
        const at = turnAt[i]!, n = turnLen[i]!;
        for (let k = 0; k < n; k++) {
          const j = T[at + k]!, a = this.exitDemand[j]!;
          if (a > EPS) theta = Math.min(theta, (j < this.size && this.present[j] === 1 ? this.room[j]! : 0) / a);
        }
      }
      theta = Number.isFinite(theta) ? Math.max(0, theta) : 0;
      for (let i = ins.head(g); i >= 0; i = ins.after(i)) {
        if (!this.live[i]) continue;
        const c = Math.max(EPS, this.capOf[i]! * this.dt), at = turnAt[i]!, n = turnLen[i]!;
        for (let k = 0; k < n; k++) {
          const j = T[at + k]!;
          if (this.has(j)) this.inflow[j] = this.inflow[j]! + c * T[at + n + k]! * theta;
        }
        this.left[i] = this.left[i]! - c * theta;
      }
      // Each exit's room taken once, by its whole demand of the round, and its demand cleared for the next.
      for (let i = ins.head(g); i >= 0; i = ins.after(i)) {
        if (!this.live[i]) continue;
        const at = turnAt[i]!, n = turnLen[i]!;
        for (let k = 0; k < n; k++) {
          const j = T[at + k]!, a = this.exitDemand[j]!;
          if (a <= 0) continue;
          if (this.has(j)) this.room[j] = Math.max(0, this.room[j]! - a * theta);
          this.exitDemand[j] = 0;
        }
      }
      anyLive = false;
      for (let i = ins.head(g); i >= 0; i = ins.after(i)) {
        if (!this.live[i]) continue;
        if (this.left[i]! <= EPS * Math.max(EPS, this.capOf[i]! * this.dt)) { this.live[i] = 0; continue; }
        // FIFO: an approach with a full exit among its turns waits whole.
        const at = turnAt[i]!, n = turnLen[i]!;
        for (let k = 0; k < n; k++) { const j = T[at + k]!; if ((j < this.size && this.present[j] === 1 ? this.room[j]! : 0) <= EPS) { this.live[i] = 0; break; } }
        if (this.live[i]) anyLive = true;
      }
    }
    // What left each approach: its share served at the node, and its trips ending in the same proportion (FIFO).
    for (let i = ins.head(g); i >= 0; i = ins.after(i)) {
      const S = this.sending[i]!, want = this.wanted[i]!;
      const served = Math.min(want, Math.max(0, want - this.left[i]!));
      const total = want > EPS ? S * (served / want) : S;
      this.outflow[i] = total;
      this.tally[0] = this.tally[0]! + (total - served);
    }
  }

  /** The link's `n` vehicles laid along it as in free flow: entered evenly over the last free run, none left yet. */
  private spread(slot: number, n: number): void {
    const L = this.lengthOf[slot]!, v = this.vFreeOf[slot]!, dt = this.dt;
    const hu = Math.ceil(L / (v * dt)) + 2, hd = Math.ceil(L / (WAVE_SPEED * dt)) + 2;
    this.dropRings(slot);
    const ua = this.rings.alloc(hu), da = this.rings.alloc(hd), d = this.rings.data;
    this.upAt[slot] = ua; this.upLen[slot] = hu;
    this.downAt[slot] = da; this.downLen[slot] = hd;
    d.fill(0, da, da + hd);
    for (let k = 0; k < hu; k++) d[ua + this.ringAt(hu, k)] = n * Math.max(0, 1 - (k * dt * v) / L);
  }

  private dropRings(slot: number): void {
    if (this.upAt[slot]! >= 0) this.rings.release(this.upAt[slot]!, this.upLen[slot]!);
    if (this.downAt[slot]! >= 0) this.rings.release(this.downAt[slot]!, this.downLen[slot]!);
    this.upAt[slot] = -1; this.upLen[slot] = 0;
    this.downAt[slot] = -1; this.downLen[slot] = 0;
  }

  private dropTurns(slot: number): void {
    if (this.turnLen[slot]! > 0) this.turns.release(this.turnAt[slot]!, 2 * this.turnLen[slot]!);
    this.turnAt[slot] = -1;
    this.turnLen[slot] = 0;
  }

  /** The cumulative count `back` steps ago in the ring at `at` of `h` (fractional: between the two steps either side). */
  private cum(at: number, h: number, back: number): number {
    const ring = this.rings.data;
    const b = Math.min(h - 1, Math.max(0, back));
    const k0 = Math.floor(b), k1 = Math.min(h - 1, k0 + 1), f = b - k0;
    const a = ring[at + this.ringAt(h, k0)]!;
    return f > 0 ? a + (ring[at + this.ringAt(h, k1)]! - a) * f : a;
  }
  /** What a step's nodes sink, summed in place (`step`). */
  private readonly tally = new Float64Array(1);


  /** A ring of `h`'s cell for `back` steps ago (-1: the next step). */
  private ringAt(h: number, back: number): number {
    return (((this.tick - back) % h) + h) % h;
  }

  /** Room for slots below `n`, doubling. */
  private reserve(n: number): void {
    if (n <= this.size) return;
    if (n > this.cap) {
      const next = Math.max(n, this.cap * 2, 64);
      this.present = grown(this.present, next); this.exitOf = grown(this.exitOf, next);
      this.insideOf = grown(this.insideOf, next); this.toOf = grown(this.toOf, next); this.lanesOf = grown(this.lanesOf, next);
      this.lengthOf = grown(this.lengthOf, next); this.vFreeOf = grown(this.vFreeOf, next); this.capOf = grown(this.capOf, next);
      this.sinkOf = grown(this.sinkOf, next); this.genOf = grown(this.genOf, next); this.origin = grown(this.origin, next);
      this.pendingOf = grown(this.pendingOf, next); this.microOf = grown(this.microOf, next); this.sending = grown(this.sending, next);
      this.room = grown(this.room, next); this.inflow = grown(this.inflow, next); this.outflow = grown(this.outflow, next);
      this.left = grown(this.left, next); this.wanted = grown(this.wanted, next); this.exitDemand = grown(this.exitDemand, next);
      this.live = grown(this.live, next);
      this.upAt = grown(this.upAt, next, -1); this.upLen = grown(this.upLen, next);
      this.downAt = grown(this.downAt, next, -1); this.downLen = grown(this.downLen, next);
      this.turnAt = grown(this.turnAt, next, -1); this.turnLen = grown(this.turnLen, next);
      this.into.reserve(next);
      this.cap = next;
    }
    this.size = n;
  }
}

const NONE: readonly number[] = [];

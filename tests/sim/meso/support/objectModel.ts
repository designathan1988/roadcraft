import { m } from '@world/units';
import { JAM_SPACING, WAVE_SPEED, linkCapacity, type MesoLinkSpec } from '@sim/meso/model';

/** THE MESO MODEL AS IT WAS BEFORE ITS TABLES BY SLOT (bf7f5e4, `src/sim/meso/model.ts`): an object, rings and turn arrays a link; the oracle `model.spec.ts` holds the typed-array model to, number for number */

const ORIGIN_QUEUE = 6;
const EPS = 1e-9;

export class ObjectModel {
  private size = 0;
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
  /** Cumulative counts at each end, back in time a step a cell (rings): entries upstream, exits downstream. */
  private up: (Float64Array | null)[] = [];
  private down: (Float64Array | null)[] = [];
  /** Each link's turns: the links it feeds and the share going to each (summing to 1). */
  private outs: (Int32Array | null)[] = [];
  private betas: (Float64Array | null)[] = [];
  /** The links into each node. */
  private readonly into = new Map<number, number[]>();
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

  has(slot: number): boolean {
    return slot < this.size && this.present[slot] === 1;
  }

  isInside(slot: number): boolean {
    return this.has(slot) && this.insideOf[slot] === 1;
  }

  /** The links into `node`. */
  inLinks(node: number): readonly number[] {
    return this.into.get(node) ?? NONE;
  }

  /** A link made or changed: its vehicles kept (spread along it again when its length or speed changed). */
  setLink(slot: number, spec: MesoLinkSpec): void {
    this.reserve(slot + 1);
    const had = this.has(slot);
    const keep = had ? this.count(slot) : 0;
    if (had && this.toOf[slot] !== spec.to) this.unfileNode(slot);
    if (!had || this.toOf[slot] !== spec.to) {
      const list = this.into.get(spec.to);
      if (list) list.push(slot); else this.into.set(spec.to, [slot]);
    }
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

  /** A link gone: what was on it and waiting for it leaves the model (counted as arrived). */
  dropLink(slot: number): void {
    if (!this.has(slot)) return;
    this.sunk += this.count(slot) + this.origin[slot]!;
    if (this.insideOf[slot]) this.sunk -= this.microOf[slot]!;
    this.unfileNode(slot);
    this.present[slot] = 0;
    this.insideOf[slot] = 0;
    this.pendingOf[slot] = 0;
    this.microOf[slot] = 0;
    this.origin[slot] = 0;
    this.up[slot] = null;
    this.down[slot] = null;
    this.outs[slot] = null;
    this.betas[slot] = null;
  }

  /** The links `slot` feeds, each with its weight (normalised here); none: everything reaching its end leaves the network. */
  setTurns(slot: number, to: readonly number[], weights: readonly number[]): void {
    if (!this.has(slot)) return;
    let sum = 0;
    for (const w of weights) sum += Math.max(0, w);
    if (!to.length || sum <= 0) { this.outs[slot] = null; this.betas[slot] = null; return; }
    this.outs[slot] = Int32Array.from(to);
    this.betas[slot] = Float64Array.from(weights, (w) => Math.max(0, w) / sum);
  }

  setGeneration(slot: number, perSecond: number): void {
    if (this.has(slot)) this.genOf[slot] = Math.max(0, perSecond);
  }

  setSinkShare(slot: number, share: number): void {
    if (this.has(slot)) this.sinkOf[slot] = Math.min(1, Math.max(0, share));
  }

  /** Vehicles on the link: on the road (outside the window), or the micro simulation's and those waiting to be made there (inside). */
  count(slot: number): number {
    if (!this.has(slot)) return 0;
    if (this.insideOf[slot]) return this.microOf[slot]! + this.pendingOf[slot]!;
    return Math.max(0, this.cum(this.up[slot]!, 0) - this.cum(this.down[slot]!, 0));
  }

  /** Vehicles standing in the link's queue: those that have had the time to reach its end and not left. */
  queued(slot: number): number {
    if (!this.has(slot) || this.insideOf[slot]) return 0;
    const L = this.lengthOf[slot]!, v = this.vFreeOf[slot]!;
    const reached = this.cum(this.up[slot]!, L / v / this.dt) - this.cum(this.down[slot]!, 0);
    return Math.min(this.count(slot), Math.max(0, reached));
  }

  /** The link's mean speed: its length over the free run plus the wait in its queue at the discharge rate. */
  speed(slot: number): number {
    if (!this.has(slot)) return 0;
    const L = this.lengthOf[slot]!, v = this.vFreeOf[slot]!, q = this.queued(slot), c = this.capOf[slot]!;
    if (q <= EPS) return v;
    return c > EPS ? L / (L / v + q / c) : 0;
  }

  /** `n` vehicles put on a link outside the window, spread along it in free flow (counted as generated). */
  seed(slot: number, n: number): void {
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
    const outs = this.has(slot) ? this.outs[slot] : null;
    return outs ? [...outs] : NONE;
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
    if (!this.has(slot) || this.insideOf[slot]) return 0;
    const n = this.count(slot);
    this.insideOf[slot] = 1;
    this.pendingOf[slot] = n;
    this.microOf[slot] = 0;
    this.up[slot] = null;
    this.down[slot] = null;
    return n;
  }

  /** The link leaves the micro window with `micro` vehicles of the micro simulation on it (taken off there): they and the pending are the model's again. */
  leaveWindow(slot: number, micro: number): void {
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
    if (!this.has(slot) || this.insideOf[slot]) return;
    const up = this.up[slot]!;
    up[this.ringAt(up, 0)] = up[this.ringAt(up, 0)]! + 1;
    this.handedIn++;
  }

  /** The links of the micro window handed a whole vehicle or more by the last step (`pending`): the micro simulation is to make them (`meso.ts` admit). */
  readonly handed: number[] = [];

  /** One step of `dt`: origins fed, sending and receiving flows, each node's transfers, the cumulative counts moved on. */
  step(): void {
    const dt = this.dt;
    this.handed.length = 0;
    for (let s = 0; s < this.size; s++) {
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
        const up = this.up[s]!, down = this.down[s]!;
        const up0 = this.cum(up, 0), down0 = this.cum(down, 0);
        const free = this.cum(up, Math.max(0, L / this.vFreeOf[s]! / dt - 1));
        this.sending[s] = Math.max(0, Math.min(free - down0, cdt, up0 - down0));
        const back = this.cum(down, Math.max(0, L / WAVE_SPEED / dt - 1));
        this.room[s] = Math.max(0, Math.min(back + storage - up0, cdt));
      }
      // The origin: what wants to start, up to its queue; the rest is lost.
      const arrive = this.genOf[s]! * dt;
      if (arrive > 0) {
        this.generated += arrive;
        const most = ORIGIN_QUEUE * lanes;
        const next = this.origin[s]! + arrive;
        if (next > most) { this.lost += next - most; this.origin[s] = most; } else this.origin[s] = next;
      }
    }
    for (const ins of this.into.values()) this.node(ins);
    // Starting from the street (a driveway, the map's edge) gives way to the through traffic: what room is left.
    for (let s = 0; s < this.size; s++) {
      if (!this.present[s] || this.origin[s]! <= 0) continue;
      const go = Math.min(this.origin[s]!, this.room[s]!);
      if (go <= 0) continue;
      this.origin[s] = this.origin[s]! - go;
      this.room[s] = this.room[s]! - go;
      this.inflow[s] = this.inflow[s]! + go;
    }
    for (let s = 0; s < this.size; s++) {
      if (!this.present[s]) continue;
      if (this.insideOf[s]) {
        this.pendingOf[s] = this.pendingOf[s]! + this.inflow[s]!;
        if (this.inflow[s]! > 0 && this.pendingOf[s]! >= 1) this.handed.push(s);
        continue;
      }
      const up = this.up[s]!, down = this.down[s]!;
      const up0 = this.cum(up, 0), down0 = this.cum(down, 0);
      up[this.ringAt(up, -1)] = up0 + this.inflow[s]!;
      down[this.ringAt(down, -1)] = down0 + this.outflow[s]!;
    }
    this.tick++;
  }

  /** One node: the approaches' sending flows to their turns, by equal-priority movements, up to each exit's room. */
  private node(ins: readonly number[]): void {
    let anyLive = false;
    for (const i of ins) {
      this.live[i] = 0;
      const sink = this.exitOf[i] || !this.outs[i] ? 1 : this.sinkOf[i]!;
      this.wanted[i] = this.sending[i]! * (1 - sink);
      this.left[i] = this.wanted[i]!;
      if (this.left[i]! > EPS) { this.live[i] = 1; anyLive = true; }
    }
    // Each round ends an approach or fills an exit: at most as many rounds as both.
    for (let round = 0; anyLive && round <= 2 * ins.length + 1; round++) {
      // The exits' demand this round: each live approach at its capacity, split by its turns.
      let theta = Infinity;
      for (const i of ins) {
        if (!this.live[i]) continue;
        const c = this.priority(i), outs = this.outs[i]!, betas = this.betas[i]!;
        theta = Math.min(theta, this.left[i]! / c);
        for (let k = 0; k < outs.length; k++) this.exitDemand[outs[k]!] = this.exitDemand[outs[k]!]! + c * betas[k]!;
      }
      for (const i of ins) {
        if (!this.live[i]) continue;
        for (const j of this.outs[i]!) {
          const a = this.exitDemand[j]!;
          if (a > EPS) theta = Math.min(theta, this.roomOf(j) / a);
        }
      }
      theta = Number.isFinite(theta) ? Math.max(0, theta) : 0;
      for (const i of ins) {
        if (!this.live[i]) continue;
        const c = this.priority(i), outs = this.outs[i]!, betas = this.betas[i]!;
        for (let k = 0; k < outs.length; k++) {
          const j = outs[k]!;
          if (this.has(j)) this.inflow[j] = this.inflow[j]! + c * betas[k]! * theta;
        }
        this.left[i] = this.left[i]! - c * theta;
      }
      // Each exit's room taken once, by its whole demand of the round, and its demand cleared for the next.
      for (const i of ins) {
        if (!this.live[i]) continue;
        for (const j of this.outs[i]!) {
          const a = this.exitDemand[j]!;
          if (a <= 0) continue;
          if (this.has(j)) this.room[j] = Math.max(0, this.room[j]! - a * theta);
          this.exitDemand[j] = 0;
        }
      }
      anyLive = false;
      for (const i of ins) {
        if (!this.live[i]) continue;
        if (this.left[i]! <= EPS * this.priority(i)) { this.live[i] = 0; continue; }
        // FIFO: an approach with a full exit among its turns waits whole.
        for (const j of this.outs[i]!) if (this.roomOf(j) <= EPS) { this.live[i] = 0; break; }
        if (this.live[i]) anyLive = true;
      }
    }
    // What left each approach: its share served at the node, and its trips ending in the same proportion (FIFO).
    for (const i of ins) {
      const S = this.sending[i]!, want = this.wanted[i]!;
      const served = Math.min(want, Math.max(0, want - this.left[i]!));
      const total = want > EPS ? S * (served / want) : S;
      this.outflow[i] = total;
      this.sunk += total - served;
    }
  }

  /** An approach's priority (its capacity over a step); a closed one still served in proportion. */
  private priority(i: number): number {
    return Math.max(EPS, this.capOf[i]! * this.dt);
  }

  /** An exit's room: none for a link gone. */
  private roomOf(j: number): number {
    return this.has(j) ? this.room[j]! : 0;
  }

  /** The link's `n` vehicles laid along it as in free flow: entered evenly over the last free run, none left yet. */
  private spread(slot: number, n: number): void {
    const L = this.lengthOf[slot]!, v = this.vFreeOf[slot]!, dt = this.dt;
    const hu = Math.ceil(L / (v * dt)) + 2, hd = Math.ceil(L / (WAVE_SPEED * dt)) + 2;
    const up = new Float64Array(hu), down = new Float64Array(hd);
    this.up[slot] = up;
    this.down[slot] = down;
    for (let k = 0; k < hu; k++) up[this.ringAt(up, k)] = n * Math.max(0, 1 - (k * dt * v) / L);
  }

  /** The cumulative count `back` steps ago (fractional: between the two steps either side). */
  private cum(ring: Float64Array, back: number): number {
    const b = Math.min(ring.length - 1, Math.max(0, back));
    const k0 = Math.floor(b), k1 = Math.min(ring.length - 1, k0 + 1), f = b - k0;
    const a = ring[this.ringAt(ring, k0)]!;
    return f > 0 ? a + (ring[this.ringAt(ring, k1)]! - a) * f : a;
  }

  /** The ring's cell for `back` steps ago (-1: the next step). */
  private ringAt(ring: Float64Array, back: number): number {
    const h = ring.length;
    return (((this.tick - back) % h) + h) % h;
  }

  private unfileNode(slot: number): void {
    const list = this.into.get(this.toOf[slot]!);
    if (!list) return;
    const at = list.indexOf(slot);
    if (at >= 0) list.splice(at, 1);
    if (!list.length) this.into.delete(this.toOf[slot]!);
  }

  /** Room for slots below `n`, doubling. */
  private reserve(n: number): void {
    if (n <= this.size) return;
    const cap = this.present.length;
    if (n > cap) {
      const next = Math.max(n, cap * 2, 64);
      const grow = <T extends Float64Array | Uint8Array | Int32Array>(a: T): T => {
        const b = new (a.constructor as unknown as new (n: number) => T)(next);
        b.set(a);
        return b;
      };
      this.present = grow(this.present); this.exitOf = grow(this.exitOf);
      this.insideOf = grow(this.insideOf); this.toOf = grow(this.toOf); this.lanesOf = grow(this.lanesOf);
      this.lengthOf = grow(this.lengthOf); this.vFreeOf = grow(this.vFreeOf); this.capOf = grow(this.capOf);
      this.sinkOf = grow(this.sinkOf); this.genOf = grow(this.genOf); this.origin = grow(this.origin);
      this.pendingOf = grow(this.pendingOf); this.microOf = grow(this.microOf); this.sending = grow(this.sending);
      this.room = grow(this.room); this.inflow = grow(this.inflow); this.outflow = grow(this.outflow);
      this.left = grow(this.left); this.wanted = grow(this.wanted); this.exitDemand = grow(this.exitDemand); this.live = grow(this.live);
    }
    while (this.up.length < n) { this.up.push(null); this.down.push(null); this.outs.push(null); this.betas.push(null); }
    this.size = n;
  }
}

const NONE: readonly number[] = [];

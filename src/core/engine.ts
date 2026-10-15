/**
 * THE ONE ENGINE THAT KNOWS WHAT CHANGED AND HAS IT COMPUTED AGAIN
 * (docs/PLANO-ESPINHA-2026-10-14.md, "O controlador global").
 *
 * Every product derived from the game's inputs - the document's diary, the
 * view, the simulation's clock, the quality - is registered here and brought
 * up to date by `refresh`, once a frame (or a step), in the order of what it
 * reads. A product computes only the keys a change reached; a value computed
 * equal to the old one is not passed on (Salsa, "algorithm": "we can backdate
 * the result ... even though the inputs changed, the output didn't";
 * salsa-rs.github.io/salsa/reference/algorithm.html).
 *
 * The ledger counts what each product computed in each refresh. A refresh
 * with no input changed computes nothing; a product that computes then is
 * named (`idle`), as is one whose work grows with the town and not with the
 * change (the scale tests: one item more in a town of N and of 4N computes
 * the same).
 *
 * DO NOT let a product schedule its own rebuild, read a global revision or
 * walk the map outside its `@rebuild` start: it is told what changed here.
 * DO NOT slice, defer or space out work here: the engine makes needless work
 * not exist; needed heavy work goes to a worker.
 */

/** An input of the engine that is not the diary (the view, the clock, the quality): a serial moved when it changes. */
export class EngineInput {
  /** Moved by every input's `touch`: part of the engine's stamp (`Engine.watch`). */
  static epoch = 0;
  private serialNow = 0;

  constructor(readonly name: string) {}

  /** The serial of its latest change. */
  get serial(): number {
    return this.serialNow;
  }

  /** It changed. */
  touch(): void {
    this.serialNow++;
    EngineInput.epoch++;
  }
}

/** Reads an input's changes since its last read: true once per change, then false until the next. */
export class InputCursor {
  private seen = -1;

  constructor(readonly input: EngineInput) {}

  /** Whether the input changed since the last read (the first read: yes). */
  moved(): boolean {
    const now = this.input.serial;
    if (now === this.seen) return false;
    this.seen = now;
    return true;
  }
}

/** A product brought up to date by the engine. */
export interface Product {
  /** For the ledger, the console and the health panel. */
  readonly name: string;
  /** The products it reads, refreshed before it. */
  readonly after?: readonly Product[];
  /** Brings itself up to date with what changed since its last refresh; returns how many keys it computed. */
  refresh(): number;
}

/** What one product did. */
export interface ProductWork {
  /** Keys computed in the last refresh. */
  last: number;
  /** Keys computed since it was registered. */
  total: number;
  /** Refreshes in which it computed anything. */
  busy: number;
  /** Milliseconds its last refresh took. */
  ms: number;
  /** Refreshes in which it computed with no input moved since the phase's last refresh (`watch`): work for nothing. */
  idle: number;
}

/**
 * Where in the frame a product is brought up to date: `frame` by the frame
 * loop between the simulation and the drawing (`main.ts`), `draw` inside
 * the drawing once the world it stands on is settled (`render/renderer.ts`),
 * `step` at the start of each step of the simulation.
 */
export type Phase = 'frame' | 'draw' | 'step';

export class Engine {
  private readonly products: Product[] = [];
  /** What says an input moved (the diary's serial, the inputs' serials); none: every computing product is taken as needed. */
  private stamp: (() => number) | null = null;
  /** Each phase's stamp at its last refresh. */
  private readonly stampAt = new Map<Phase, number>();
  /** Told each product's refresh: its time, keys and whether it computed for nothing (the profiler). */
  onRefresh: ((name: string, phase: Phase, ms: number, keys: number, idle: boolean) => void) | null = null;

  /** Watches the serial of every input the products are told of: a product computing while it stands still is named. */
  watch(stamp: () => number): void {
    this.stamp = stamp;
  }

  private readonly phaseOf = new Map<Product, Phase>();
  private readonly orders = new Map<Phase, Product[]>();
  /** Each product's work, by name: the ledger. */
  readonly ledger = new Map<string, ProductWork>();
  /** The names of the products that computed in each phase's last refresh. */
  private readonly lastBusy = new Map<Phase, readonly string[]>();

  /** Registers a product (once); it is refreshed after those it reads. */
  register<P extends Product>(product: P, phase: Phase = 'frame'): P {
    if (this.products.includes(product)) return product;
    if (this.ledger.has(product.name)) throw new Error(`engine: two products named ${product.name}`);
    this.products.push(product);
    this.phaseOf.set(product, phase);
    this.ledger.set(product.name, { last: 0, total: 0, busy: 0, ms: 0, idle: 0 });
    this.orders.clear();
    return product;
  }

  /** Takes a product out (its owner disposed of). */
  unregister(product: Product): void {
    const at = this.products.indexOf(product);
    if (at < 0) return;
    this.products.splice(at, 1);
    this.phaseOf.delete(product);
    this.ledger.delete(product.name);
    this.orders.clear();
  }

  /** Every product of a phase brought up to date, in the order of what each reads; the names of those that computed. */
  refresh(phase: Phase = 'frame'): readonly string[] {
    let order = this.orders.get(phase);
    if (!order) this.orders.set(phase, order = this.sorted().filter((p) => this.phaseOf.get(p) === phase));
    const busy: string[] = [];
    const stamp = this.stamp ? this.stamp() + EngineInput.epoch : -1;
    const still = stamp >= 0 && this.stampAt.get(phase) === stamp;
    this.stampAt.set(phase, stamp);
    for (const product of order) {
      const at = performance.now();
      const n = product.refresh();
      const ms = performance.now() - at;
      const work = this.ledger.get(product.name)!;
      work.last = n;
      work.total += n;
      work.ms = ms;
      if (n > 0) { work.busy++; busy.push(product.name); }
      if (n > 0 && still) work.idle++;
      this.onRefresh?.(product.name, phase, ms, n, n > 0 && still);
    }
    this.lastBusy.set(phase, busy);
    return busy;
  }

  /** The products of a phase that computed in its last refresh: with no input changed, each is a product computing for nothing. */
  idle(phase: Phase = 'frame'): readonly string[] {
    return this.lastBusy.get(phase) ?? [];
  }

  /** The products in an order where each comes after those it reads (a depth-first walk); a cycle is an error. */
  private sorted(): Product[] {
    const out: Product[] = [];
    const state = new Map<Product, 'visiting' | 'done'>();
    const visit = (p: Product): void => {
      const s = state.get(p);
      if (s === 'done') return;
      if (s === 'visiting') throw new Error(`engine: products read each other round ${p.name}`);
      state.set(p, 'visiting');
      for (const q of p.after ?? []) if (this.products.includes(q)) visit(q);
      state.set(p, 'done');
      out.push(p);
    };
    for (const p of this.products) visit(p);
    return out;
  }
}

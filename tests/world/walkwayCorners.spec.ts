import { describe, expect, it } from 'vitest';
import { Digest } from '@core/digest';
import { Walkways, type WalkGraph } from '@world/walkways';
import { type CornerAsk, type CornerMeasurer, roundCorners } from '@world/walkingLines';
import { WAITING } from '@world/waiting';
import { Network } from '@world/network';
import { planCity, DEFAULT_CITY } from '@world/cityGen/plan';
import { layCity } from '@editor/cityGenerator';
import { m } from '@world/units';
import { applyOp, freshState } from '../fuzz/support/ops';
import { generate } from '../fuzz/support/runner';

/**
 * THE WALKWAYS' CORNERS ROUNDED OFF THE PAGE (`Walkways.updateSteps`, `roundCorners` in the conflict
 * workers): the asks and answers through `structuredClone`, as `postMessage` copies them, must give the
 * walkways `Walkways.update` builds on the page - every walkway, its id, its ends and every point of its
 * line - and an update given up while the workers work must leave the walkways as they were.
 */
const lines = (g: WalkGraph): string[] => g.walkways().map((w) => `${w.id} ${w.kind} ${w.a} ${w.b} ${w.segment ?? '-'} ${w.node ?? '-'} `
  + `${w.structure} ${w.kerb} ${w.lo} ${w.hi} ${w.width} ${w.unmarked ?? '-'} ${new Digest().addAll(w.path.xy).value()}`);

/** Corners rounded as a worker rounds them; `held`: the answer kept back until released. */
function workers(): CornerMeasurer & { asked: number; held: boolean; release(): void } {
  let waiting: (() => void)[] = [];
  const self = {
    asked: 0,
    held: false,
    release(): void { const go = waiting; waiting = []; for (const f of go) f(); },
    roundCorners(asks: readonly CornerAsk[]): Promise<readonly (readonly (Float64Array | null)[])[]> {
      self.asked += asks.length;
      const answer = structuredClone(structuredClone(asks).map((a) => roundCorners(a)));
      return self.held ? new Promise((resolve) => { waiting.push(() => resolve(answer)); }) : Promise.resolve(answer);
    },
  };
  return self;
}

/** The ops the editor refused (a fuzz op may be one it would not do): the sequence stops there. */
const rejected: unknown[] = [];
const recordRejected = (error: unknown): void => { rejected.push(error); };

async function stepped(w: Walkways, net: Network, measurer: CornerMeasurer): Promise<WalkGraph> {
  const steps = w.updateSteps(net, measurer);
  for (let step = steps.next(); ; step = steps.next()) {
    if (step.done) return step.value;
    if (step.value === WAITING) await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('the walkways rounded off the page', () => {
  it('builds a generated city as the page does', async () => {
    const doc = layCity(planCity({ ...DEFAULT_CITY, seed: 3, size: 'small', radius: m(260) }));
    const net = new Network(doc);
    net.rebuild();
    const measurer = workers();
    const off = await stepped(new Walkways(), net, measurer);
    expect(measurer.asked).toBeGreaterThan(20);
    expect(lines(off)).toEqual(lines(new Walkways().update(net)));
  });

  for (let seed = 1; seed <= 3; seed++) it(`keeps what the page keeps after every op of fuzz sequence ${seed}`, async () => {
    const state = freshState();
    const off = new Walkways(), page = new Walkways();
    const measurer = workers();
    let edits = 0;
    for (const op of generate(seed, 24)) {
      let changed: boolean;
      try { changed = applyOp(state, op); } catch (error) { recordRejected(error); break; }
      if (!changed) continue;
      edits++;
      expect(lines(await stepped(off, state.net, measurer)), `seed ${seed} ${op.op}`).toEqual(lines(page.update(state.net)));
    }
    expect(edits).toBeGreaterThan(0);
  });

  it('leaves the walkways as they were when an update is given up, and catches up after', async () => {
    const state = freshState();
    const off = new Walkways(), page = new Walkways();
    const measurer = workers();
    let givenUp = 0;
    for (const op of generate(2, 24)) {
      let changed: boolean;
      try { changed = applyOp(state, op); } catch (error) { recordRejected(error); break; }
      if (!changed) continue;
      const before = off.graph.state, kept = lines(off.graph);
      measurer.held = true;
      const steps = off.updateSteps(state.net, measurer);
      let step = steps.next();
      if (!step.done && step.value === WAITING) {
        // Given up: nothing of the walkways changed while the workers worked.
        givenUp++;
        expect(off.graph.state).toBe(before);
        expect(lines(off.graph)).toEqual(kept);
        measurer.release();
      } else {
        page.update(state.net);
      }
      measurer.held = false;
      // The network edited again meanwhile, half the time: an update waited on goes on with what is now.
      if (givenUp % 2 === 1 && !step.done) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        step = steps.next();
        expect(step.done).toBe(true);
        page.update(state.net);
        expect(lines(off.graph)).toEqual(lines(page.graph));
      }
    }
    expect(givenUp).toBeGreaterThan(1);
    expect(lines(await stepped(off, state.net, measurer))).toEqual(lines(page.update(state.net)));
  });
});

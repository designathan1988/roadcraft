import { writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { SimWorld } from '@sim/world';
import { step, tickWork } from '@sim/pipeline';
import { DT } from '@sim/params';
import { createAgentWalkEngine } from '@sim/agents/walk';

/**
 * THE SCALE OF THE SIMULATION (docs/relatorio-desempenho-mapas-enormes-2026-10-11.md,
 * annex B2; BENCH=1, `node scripts/run-limited.mjs npx vitest run tests/bench/scale.spec.ts`):
 * the same population (400 cars, 400 people) on closed grids of local
 * streets of 120 m blocks, 6 x 6 (0.72 km) and 36 x 36 (4.32 km), ms per
 * stage of a tick (`StepOptions.timings`). Phase 1 asks the stages that do
 * nothing for the map's size (1 signals, 7 cleanup) to cost the same on both,
 * and the whole tick on the large one at most 1.3 x the small one's.
 *
 * Two worlds per grid, doing less (`SimWorld.doLess`) on and off, stepped
 * in turn, tick by tick: the comparison is taken under the same load of the
 * machine (docs 9.5, interleaved runs), and the two run the same ticks
 * (`tests/sim/doLess.spec.ts`). Results to the console and to BENCH_OUT
 * (JSON) when set; BENCH_PROFILE=1 adds the functions with the most self
 * time, of both worlds together.
 */
const BLOCK = 120;
const TICKS = Number(process.env['BENCH_TICKS'] ?? 600);
const GRIDS = (process.env['BENCH_GRIDS'] ?? '6,36').split(',').map(Number);
/** Doing less on (1) and off (0), the worlds stepped in turn per grid. */
const MODES = (process.env['BENCH_MODES'] ?? '1,0').split(',').map((x) => x === '1');

/** The closed grid of `population.spec.ts`, without lots. */
function closedGrid(n: number): RoadDoc {
  const doc = new RoadDoc();
  const ids: number[][] = [];
  for (let i = 0; i <= n; i++) {
    ids.push([]);
    for (let j = 0; j <= n; j++) ids[i]!.push(doc.addNode({ x: m(BLOCK) * (i - n / 2), y: m(BLOCK) * (j - n / 2) }).id);
  }
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      if (i < n) doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, 1);
      if (j < n) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, 1);
    }
  }
  return doc;
}

function world(n: number, doLess: boolean): SimWorld {
  const doc = closedGrid(n);
  const net = new Network(doc);
  net.rebuild();
  const w = new SimWorld(doc, net, 0x0be9);
  w.doLess = doLess;
  w.rebuildTopology();
  w.usePedestrianEngine(createAgentWalkEngine());
  w.trafficCount = 400;
  w.pedestrianCount = 400;
  w.ambient.enabled = true;
  w.ambient.source = 'edges';
  w.clock.paused = false;
  for (let i = 0; i < 200 + Math.round(20 / DT); i++) step(w, { traffic: true, pedestrians: true });
  return w;
}

interface Run { readonly w: SimWorld; readonly timings: Map<string, number>; readonly ticks: number[]; stepped: number }

function summary(n: number, run: Run, top: readonly string[]): Record<string, unknown> {
  const { w, timings } = run;
  const ticks = [...run.ticks].sort((a, b) => a - b);
  const r3 = (x: number): number => Math.round(x * 1000) / 1000;
  const stages: Record<string, number> = {};
  for (const [k, v] of timings) stages[k] = r3(v / TICKS);
  return {
    grid: `${n}x${n}`, doLess: w.doLess, segments: w.doc.segments.size, junctions: w.graph.junctions.size, lanelets: w.graph.lanelets.size,
    vehicles: w.vehicles.size, peds: w.pedViews.length, signals: w.signalisedControllers().length,
    signalsStepped: Math.round((run.stepped / TICKS) * 10) / 10, msPerTick: r3(ticks.reduce((a, b) => a + b, 0) / TICKS),
    p50: r3(ticks[Math.floor(TICKS / 2)]!), p95: r3(ticks[Math.floor(TICKS * 0.95)]!), stages,
    ...(top.length ? { top } : {}),
  };
}

describe.runIf(process.env['BENCH'] === '1')('the simulation\'s scale (annex B2)', () => {
  it('measures each stage on a small and a large map with the same population', async () => {
    const rows: unknown[] = [];
    for (const n of GRIDS) {
      const runs: Run[] = MODES.map((doLess) => ({ w: world(n, doLess), timings: new Map(), ticks: [], stepped: 0 }));
      const profiling = process.env['BENCH_PROFILE'] === '1' ? new Session() : null;
      if (profiling) {
        profiling.connect();
        await profiling.post('Profiler.enable');
        await profiling.post('Profiler.setSamplingInterval', { interval: 100 });
        await profiling.post('Profiler.start');
      }
      for (let i = 0; i < TICKS; i++) {
        for (const run of runs) {
          const c = tickWork.controllers;
          const t = performance.now();
          step(run.w, { traffic: true, pedestrians: true, timings: run.timings });
          run.ticks.push(performance.now() - t);
          run.stepped += tickWork.controllers - c;
        }
      }
      let top: string[] = [];
      if (profiling) {
        const { profile } = await profiling.post('Profiler.stop');
        const byId = new Map(profile.nodes.map((x) => [x.id, x]));
        const self = new Map<string, number>();
        for (let i = 0; i < profile.samples!.length; i++) {
          const f = byId.get(profile.samples![i]!)!.callFrame;
          const key = `${f.functionName || '(anon)'} ${f.url.replace(/^.*\/src\//, 'src/')}:${f.lineNumber + 1}`;
          self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas![i] ?? 0) / 1000);
        }
        top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${(v / TICKS).toFixed(3)} ms/tick ${k}`);
        profiling.disconnect();
      }
      for (const [k, run] of runs.entries()) {
        const row = summary(n, run, k === 0 ? top : []);
        console.log(JSON.stringify(row));
        rows.push(row);
      }
    }
    if (process.env['BENCH_OUT']) writeFileSync(process.env['BENCH_OUT'], JSON.stringify(rows, null, 1));
    expect(rows.length).toBe(GRIDS.length * MODES.length);
  }, 0);
});

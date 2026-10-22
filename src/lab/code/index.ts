import type { LabContext, LabTab } from '../labTypes';
import { recursionRows, reportOf, suspects } from './analysis';
import { createCodeTab } from './codeTab';
import { createCoverageTab } from './coverageTab';
import type { SampleView } from './sampler';
import { createCodeState } from './state';
import './code.css';

/** THE LAB'S CODE TABS: "Código" (the page's JavaScript sampled live, mapped to its TypeScript) and "Cobertura" (the functions declared against the ones seen). Their numbers go into every report (`code`) and to the probes (`window.__labCode`). */
export function createCodeTabs(ctx: LabContext): LabTab[] {
  const state = createCodeState(ctx);
  const code = createCodeTab(state);
  const coverage = createCoverageTab(state);
  const analysed = (view: SampleView) => {
    const agg = state.sampler.aggregate(view);
    const rows = state.rows(agg);
    return { agg, rows, found: suspects(agg, rows, state.products) };
  };
  ctx.reportSection('code', () => {
    const view: SampleView = state.sampler.aggregate('recording').windows ? 'recording' : 'session';
    const { agg, rows, found } = analysed(view);
    const cov = coverage.result();
    return {
      view, ...(reportOf(agg, rows, found) as object),
      coverage: cov ? { modules: cov.modules, declared: cov.declared, seen: cov.seen } : null,
    };
  });
  // For the probes and an AI reading the game.
  (window as unknown as { __labCode: unknown }).__labCode = {
    state,
    start: (live = true) => { state.live = live; state.sampler.setLive(live); },
    record: (on: boolean) => state.sampler.setRecording(on),
    status: () => ({ supported: state.sampler.supported, problem: state.sampler.problem, running: state.sampler.running, recording: state.sampler.recording, intervalMs: state.sampler.actualIntervalMs, windowMs: state.sampler.windowMs, sources: state.store.stats() }),
    functions: (view: SampleView = 'session') => analysed(view).rows.map((r) => ({ name: r.stat.id.name, where: r.where, category: r.category, selfMs: r.stat.selfMs, totalMs: r.stat.totalMs, selfPct: r.selfPct, samples: r.stat.totalSamples, recursion: r.stat.recursionDepth })),
    recursion: (view: SampleView = 'session') => recursionRows(analysed(view).rows).map((r) => ({ name: r.stat.id.name, where: r.where, depth: r.stat.recursionDepth, direct: r.stat.direct, ms: r.stat.recursionMs })),
    suspects: (view: SampleView = 'session') => analysed(view).found,
    report: (view: SampleView = 'session') => { const a = analysed(view); return reportOf(a.agg, a.rows, a.found); },
    locate: (url: string, line: number, column: number) => state.store.load(url).then(() => state.store.locate(url, line, column)),
    coverage: () => coverage.analyse(),
  };
  return [code, coverage];
}

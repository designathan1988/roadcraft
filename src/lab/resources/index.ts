import type { LabContext, LabTab } from '../labTypes';
import { createCollector, type Collector } from './collector';
import { createConsumersTab, type ConsumersView } from './consumers';
import { createDiagnosticsTab, runChecks } from './diagnostics';
import type { ResourceWindow } from './meter';
import { createOverviewTab, settingsSummary, summarize } from './overview';
import './resources.css';

/** THE LAB'S RESOURCES: the overview (the lab's first tab), every consumer in one table, and the diagnostics - one collector behind them (`collector.ts`), begun the first time the lab opens (nothing is observed before: a game never debugged pays nothing), and `window.__labResources` for the probes */

export function createResourceTabs(ctx: LabContext): LabTab[] {
  let collector: Collector | null = null;
  /** The collector, begun now if it was not (the lab opened, a tab shown, a report or a probe asked). */
  const collect = (): Collector => (collector ??= createCollector(ctx));
  // DO NOT unsubscribe inside the listener: the lab walks its listeners with `for...of` and one spliced out skips the next.
  ctx.onEvent((event) => { if (event.kind === 'lab.open' && !collector) collect(); });

  const view: ConsumersView = {
    window: '30s',
    rows: (window?: ResourceWindow) => collect().book.read(window ?? view.window, performance.now()),
  };
  /** A tab whose collector begins when it is first shown. */
  const lazy = (make: (c: Collector) => LabTab, id: string, title: string): LabTab => {
    let tab: LabTab | null = null;
    const get = (): LabTab => (tab ??= make(collect()));
    return { id, title, mount: (host) => get().mount(host), refresh: () => get().refresh?.(), unmount: () => tab?.unmount?.(), focus: (params) => get().focus?.(params) };
  };

  const overview = (): unknown => {
    const s = summarize(ctx, collect());
    return { ...s, settings: settingsSummary(ctx), effects: ctx.effects.snapshot() };
  };
  const resources = (window: ResourceWindow = view.window): unknown => {
    const c = collect();
    return {
      window,
      collectingS: Math.round((performance.now() - c.resetAt) / 1000),
      rows: c.book.read(window, performance.now()),
      longFrames: c.longFrames.slice(-30),
      platform: c.platform,
    };
  };
  const diagnostics = (): unknown => runChecks(ctx, collect());

  ctx.reportSection('resources', () => ({ overview: overview(), ...(resources() as object) }));
  ctx.reportSection('diagnostics', diagnostics);
  (window as unknown as { __labResources: unknown }).__labResources = {
    /** Begins collecting (the lab need not be open). */
    start: () => { collect(); return true; },
    overview,
    /** Every consumer read over a window: '5s', '30s' or 'session'. */
    rows: (window: ResourceWindow = '30s') => collect().book.read(window, performance.now()),
    resources,
    diagnostics,
    reset: () => collect().reset(),
    measureMemory: () => collect().measureMemory().then(() => collect().platform.uaMemory),
    readStorage: () => collect().readStorage().then(() => collect().platform.storage),
  };

  return [
    lazy((c) => createOverviewTab(ctx, c), 'overview', 'Overview'),
    lazy((c) => createConsumersTab(ctx, c, view), 'consumers', 'Consumers'),
    lazy((c) => createDiagnosticsTab(ctx, c), 'diagnostics', 'Checks'),
  ];
}

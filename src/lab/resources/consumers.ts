import { icon } from '../icons';
import { createLabTable, type LabColumn } from '../table';
import type { LabContext, LabTab } from '../labTypes';
import type { Collector } from './collector';
import { WINDOW_MS, type MeterReading, type ResourceWindow } from './meter';

/** THE LAB'S CONSUMERS ("Consumers"): one table of everything that costs - main thread, workers, GPU, video memory, the page's memory, disk, network - each row a meter (`meter.ts`) read over 5 s, 30 s or the whole session */

const WINDOW_LABEL: Readonly<Record<ResourceWindow, string>> = { '5s': '5 s', '30s': '30 s', session: 'whole session' };

const num = (v: number, row: MeterReading): string => {
  const digits = row.unit === 'ms' || row.unit === 'MB' ? 2 : Math.abs(v) < 10 && !Number.isInteger(v) ? 2 : 0;
  return v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
};

/** The columns; `perSecond` the window's seconds (the time a cost in ms takes of each second: the one figure comparable across rows of time). */
const columns = (seconds: () => number): readonly LabColumn<MeterReading>[] => [
  { key: 'name', label: 'Name', value: (r) => r.name },
  { key: 'category', label: 'Category', value: (r) => r.category },
  { key: 'source', label: 'Source', value: (r) => r.source },
  { key: 'share', label: 'ms/s', value: (r) => (r.unit === 'ms' && r.kind === 'event' && r.total !== null && r.category !== 'Network' ? r.total / seconds() : null), format: (v) => v.toLocaleString('en-US', { maximumFractionDigits: 2 }), title: 'Milliseconds spent per second of window (events in ms, network excluded): 1000 = one whole thread busy; overlapping rows (a LoAF contains the frame systems) do not add up', bar: true },
  { key: 'avg', label: 'Average', value: (r) => r.avg, format: num, bar: true },
  { key: 'p95', label: 'p95', value: (r) => r.p95, format: num },
  { key: 'max', label: 'Max', value: (r) => r.max, format: num },
  { key: 'total', label: 'Total', value: (r) => r.total, format: num, title: 'Sum of the events in the window (empty for measured levels: memory, queues)', bar: true },
  { key: 'last', label: 'Last', value: (r) => r.last, format: num, title: 'The most recent sample (for levels: what stands now)' },
  { key: 'count', label: 'Samples', value: (r) => r.count },
  { key: 'unit', label: 'Unit', value: (r) => r.unit },
  { key: 'kind', label: 'Kind', value: (r) => (r.kind === 'event' ? 'event' : 'level'), title: 'event: each sample a cost that happened; level: a reading of what is held' },
  { key: 'note', label: 'Note', value: (r) => r.note },
];

export interface ConsumersView {
  window: ResourceWindow;
  rows(window?: ResourceWindow): MeterReading[];
}

export function createConsumersTab(_ctx: LabContext, collector: Collector, view: ConsumersView): LabTab {
  const table = createLabTable<MeterReading>({
    columns: columns(() => Math.max(0.001, Math.min(WINDOW_MS[view.window], performance.now() - collector.resetAt) / 1000)),
    rows: () => view.rows(),
    sort: { key: 'share', desc: true },
    categoryKey: 'category',
    limit: 300,
    from: 'Consumers',
  });
  let info: HTMLElement | null = null;

  const mount = (host: HTMLElement): void => {
    const bar = document.createElement('div');
    bar.className = 'lab-row';
    const label = document.createElement('span');
    label.className = 'lab-muted';
    label.textContent = 'Window:';
    bar.appendChild(label);
    for (const w of Object.keys(WINDOW_MS) as ResourceWindow[]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = WINDOW_LABEL[w];
      b.classList.toggle('on', w === view.window);
      b.onclick = () => {
        view.window = w;
        for (const x of bar.querySelectorAll('button[data-window]')) x.classList.toggle('on', x === b);
        table.refresh();
      };
      b.dataset['window'] = w;
      bar.appendChild(b);
    }
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = 'Reset';
    reset.prepend(icon('refresh'));
    reset.title = 'Empties every measure (the levels come back at the next reading, in 1 s)';
    reset.onclick = () => { collector.reset(); table.refresh(); };
    const memory = document.createElement('button');
    memory.type = 'button';
    memory.textContent = 'Measure memory now';
    memory.prepend(icon('memory'));
    memory.title = 'performance.measureUserAgentSpecificMemory(): the page and its workers; the browser may take seconds (it waits for its next collection)';
    memory.onclick = () => { memory.disabled = true; void collector.measureMemory().finally(() => { memory.disabled = false; table.refresh(); }); };
    const storage = document.createElement('button');
    storage.type = 'button';
    storage.textContent = 'Read storage';
    storage.prepend(icon('download'));
    storage.onclick = () => { void collector.readStorage().then(() => table.refresh()); };
    bar.append(reset, memory, storage);
    info = document.createElement('div');
    info.className = 'lab-muted';
    host.append(bar, info, table.element);
    refresh(true);
  };

  let drawnAt = -Infinity;
  /** Hundreds of rows remade: once a second, not at every tick of the lab (each remake a forced layout in the next frame, seen in the LoAF scripts). */
  function refresh(force = false): void {
    const now = performance.now();
    if (!force && now - drawnAt < 1000) return;
    drawnAt = now;
    table.refresh();
    if (!info) return;
    const p = collector.platform;
    const ua = p.uaMemoryRunning ? 'measuring user agent memory…' : p.uaMemory ? `user agent memory ${(p.uaMemory.bytes / 1048576).toFixed(0)} MB, ${((performance.now() - p.uaMemory.at) / 1000).toFixed(0)} s ago` : `user agent memory: ${p.uaMemoryError ?? 'not measured yet'}`;
    const since = ((performance.now() - collector.resetAt) / 1000).toFixed(0);
    info.textContent = `Collecting for ${since} s · ${ua} · click a column to sort, filter by category · levels read every 1 s, storage every 15 s`;
  }

  /** Asked from elsewhere (the lab's meters, a diagnostic): a category and a text filter shown. */
  const focus = (params: Readonly<Record<string, string>>): void => {
    table.setFilter({ ...(params['category'] !== undefined ? { category: params['category'] } : {}), text: params['filter'] ?? '' });
  };

  return { id: 'consumers', title: 'Consumers', mount, focus, refresh: () => refresh(), unmount: () => { info = null; } };
}

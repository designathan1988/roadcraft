import { icon } from '../icons';
import { createLabTable, type LabColumn } from '../table';
import type { LabContext, LabTab } from '../labTypes';
import type { Collector } from './collector';
import { WINDOW_MS, type MeterReading, type ResourceWindow } from './meter';

/** THE LAB'S CONSUMERS ("Consumo"): one table of everything that costs - main thread, workers, GPU, video memory, the page's memory, disk, network - each row a meter (`meter.ts`) read over 5 s, 30 s or the whole session */

const WINDOW_LABEL: Readonly<Record<ResourceWindow, string>> = { '5s': '5 s', '30s': '30 s', session: 'sessão inteira' };

const num = (v: number, row: MeterReading): string => {
  const digits = row.unit === 'ms' || row.unit === 'MB' ? 2 : Math.abs(v) < 10 && !Number.isInteger(v) ? 2 : 0;
  return v.toLocaleString('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
};

/** The columns; `perSecond` the window's seconds (the time a cost in ms takes of each second: the one figure comparable across rows of time). */
const columns = (seconds: () => number): readonly LabColumn<MeterReading>[] => [
  { key: 'name', label: 'Nome', value: (r) => r.name },
  { key: 'category', label: 'Categoria', value: (r) => r.category },
  { key: 'source', label: 'Origem', value: (r) => r.source },
  { key: 'share', label: 'ms/s', value: (r) => (r.unit === 'ms' && r.kind === 'event' && r.total !== null && r.category !== 'Rede' ? r.total / seconds() : null), format: (v) => v.toLocaleString('pt-BR', { maximumFractionDigits: 2 }), title: 'Milissegundos gastos por segundo de janela (eventos em ms, fora a rede): 1000 = um thread inteiro ocupado; linhas sobrepostas (LoAF contém os sistemas do quadro) não se somam', bar: true },
  { key: 'avg', label: 'Média', value: (r) => r.avg, format: num, bar: true },
  { key: 'p95', label: 'p95', value: (r) => r.p95, format: num },
  { key: 'max', label: 'Máx', value: (r) => r.max, format: num },
  { key: 'total', label: 'Total', value: (r) => r.total, format: num, title: 'Soma dos eventos na janela (vazio para níveis medidos: memória, filas)', bar: true },
  { key: 'last', label: 'Último', value: (r) => r.last, format: num, title: 'A amostra mais recente (para níveis: o que está agora)' },
  { key: 'count', label: 'Amostras', value: (r) => r.count },
  { key: 'unit', label: 'Unidade', value: (r) => r.unit },
  { key: 'kind', label: 'Tipo', value: (r) => (r.kind === 'event' ? 'evento' : 'nível'), title: 'evento: cada amostra um custo que aconteceu; nível: uma leitura do que está ocupado' },
  { key: 'note', label: 'Nota', value: (r) => r.note },
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
    from: 'Consumo',
  });
  let info: HTMLElement | null = null;

  const mount = (host: HTMLElement): void => {
    const bar = document.createElement('div');
    bar.className = 'lab-row';
    const label = document.createElement('span');
    label.className = 'lab-muted';
    label.textContent = 'Janela:';
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
    reset.textContent = 'Zerar';
    reset.prepend(icon('refresh'));
    reset.title = 'Esvazia todas as medidas (os níveis voltam na próxima leitura, em 1 s)';
    reset.onclick = () => { collector.reset(); table.refresh(); };
    const memory = document.createElement('button');
    memory.type = 'button';
    memory.textContent = 'Medir memória agora';
    memory.prepend(icon('memory'));
    memory.title = 'performance.measureUserAgentSpecificMemory(): página e workers; o navegador pode levar segundos (espera a próxima coleta)';
    memory.onclick = () => { memory.disabled = true; void collector.measureMemory().finally(() => { memory.disabled = false; table.refresh(); }); };
    const storage = document.createElement('button');
    storage.type = 'button';
    storage.textContent = 'Ler armazenamento';
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
    const ua = p.uaMemoryRunning ? 'medindo memória do agente…' : p.uaMemory ? `memória do agente ${(p.uaMemory.bytes / 1048576).toFixed(0)} MB há ${((performance.now() - p.uaMemory.at) / 1000).toFixed(0)} s` : `memória do agente: ${p.uaMemoryError ?? 'ainda não medida'}`;
    const since = ((performance.now() - collector.resetAt) / 1000).toFixed(0);
    info.textContent = `Coletando há ${since} s · ${ua} · clique numa coluna para ordenar, filtre por categoria · níveis lidos a cada 1 s, armazenamento a cada 15 s`;
  }

  /** Asked from elsewhere (the lab's meters, a diagnostic): a category and a text filter shown. */
  const focus = (params: Readonly<Record<string, string>>): void => {
    table.setFilter({ ...(params['category'] !== undefined ? { category: params['category'] } : {}), text: params['filter'] ?? '' });
  };

  return { id: 'consumers', title: 'Consumo', mount, focus, refresh: () => refresh(), unmount: () => { info = null; } };
}

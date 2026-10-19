/** THE LAB'S TABLE: rows sorted by any column (a click on its head, again to reverse), filtered by text and by category, copied as CSV or JSON. Every tab lists what it measures with it. */

export interface LabColumn<R> {
  readonly key: string;
  readonly label: string;
  /** The cell's value: numbers sort as numbers. */
  value(row: R): string | number | null;
  /** How a number is shown (default: up to two decimals). */
  format?(value: number, row: R): string;
  /** A tooltip for the head. */
  readonly title?: string;
}

export interface LabTableOptions<R> {
  readonly columns: readonly LabColumn<R>[];
  rows(): readonly R[];
  /** The column sorted by at first, and whether descending (default: the first, descending). */
  readonly sort?: { readonly key: string; readonly desc: boolean };
  /** A column whose values are offered as a filter (a select). */
  readonly categoryKey?: string;
  /** A row clicked. */
  onRow?(row: R): void;
  /** At most this many rows drawn (default 400): the rest counted. */
  readonly limit?: number;
}

export interface LabTable {
  readonly element: HTMLElement;
  /** The rows read again and drawn (sorted and filtered as set). */
  refresh(): void;
}

const fmt = (v: number): string => (Number.isInteger(v) ? v.toLocaleString('pt-BR') : v.toLocaleString('pt-BR', { maximumFractionDigits: 2 }));

export function createLabTable<R>(options: LabTableOptions<R>): LabTable {
  const root = document.createElement('div');
  root.className = 'lab-table';
  const bar = document.createElement('div');
  bar.className = 'lab-table-bar';
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Filtrar…';
  const category = document.createElement('select');
  const count = document.createElement('span');
  count.className = 'lab-muted';
  const copyCsv = document.createElement('button');
  copyCsv.type = 'button';
  copyCsv.textContent = 'CSV';
  copyCsv.title = 'Copiar as linhas filtradas como CSV';
  const copyJson = document.createElement('button');
  copyJson.type = 'button';
  copyJson.textContent = 'JSON';
  copyJson.title = 'Copiar as linhas filtradas como JSON';
  bar.append(search, ...(options.categoryKey ? [category] : []), count, copyCsv, copyJson);
  const scroller = document.createElement('div');
  scroller.className = 'lab-table-scroll';
  const table = document.createElement('table');
  const head = document.createElement('thead');
  const body = document.createElement('tbody');
  table.append(head, body);
  scroller.appendChild(table);
  root.append(bar, scroller);

  let sortKey = options.sort?.key ?? options.columns[0]!.key;
  let desc = options.sort?.desc ?? true;
  let shown: R[] = [];
  const column = (key: string): LabColumn<R> => options.columns.find((c) => c.key === key) ?? options.columns[0]!;

  const drawHead = (): void => {
    const tr = document.createElement('tr');
    for (const c of options.columns) {
      const th = document.createElement('th');
      th.textContent = c.label + (c.key === sortKey ? (desc ? ' ▼' : ' ▲') : '');
      if (c.title) th.title = c.title;
      th.onclick = () => {
        if (sortKey === c.key) desc = !desc;
        else { sortKey = c.key; desc = true; }
        drawHead();
        refresh();
      };
      tr.appendChild(th);
    }
    head.replaceChildren(tr);
  };

  const filtered = (): R[] => {
    const text = search.value.trim().toLowerCase();
    const cat = options.categoryKey ? category.value : '';
    const catColumn = options.categoryKey ? column(options.categoryKey) : null;
    const rows = options.rows().filter((row) => {
      if (cat && catColumn && String(catColumn.value(row)) !== cat) return false;
      if (!text) return true;
      return options.columns.some((c) => String(c.value(row) ?? '').toLowerCase().includes(text));
    });
    const c = column(sortKey);
    rows.sort((a, b) => {
      const va = c.value(a), vb = c.value(b);
      const order = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va ?? '').localeCompare(String(vb ?? ''), 'pt-BR');
      return desc ? -order : order;
    });
    return rows;
  };

  const drawCategories = (): void => {
    if (!options.categoryKey) return;
    const c = column(options.categoryKey);
    const values = [...new Set(options.rows().map((r) => String(c.value(r) ?? '')))].sort();
    const now = category.value;
    const known = [...category.options].map((o) => o.value).slice(1);
    if (known.length === values.length && known.every((v, i) => v === values[i])) return;
    const all = new Option(`Todas (${c.label})`, '');
    category.replaceChildren(all, ...values.map((v) => new Option(v, v)));
    category.value = values.includes(now) ? now : '';
  };

  function refresh(): void {
    drawCategories();
    shown = filtered();
    const limit = options.limit ?? 400;
    const rows: HTMLElement[] = [];
    for (const row of shown.slice(0, limit)) {
      const tr = document.createElement('tr');
      for (const c of options.columns) {
        const td = document.createElement('td');
        const v = c.value(row);
        if (typeof v === 'number') {
          td.className = 'num';
          td.textContent = c.format ? c.format(v, row) : fmt(v);
        } else td.textContent = v ?? '';
        tr.appendChild(td);
      }
      if (options.onRow) tr.onclick = () => options.onRow!(row);
      rows.push(tr);
    }
    body.replaceChildren(...rows);
    count.textContent = shown.length > limit ? `${limit} de ${shown.length}` : `${shown.length} linhas`;
  }

  const copy = (text: string): void => {
    void navigator.clipboard.writeText(text).catch((error: unknown) => console.warn('lab: not copied', error));
  };
  copyCsv.onclick = () => {
    const quote = (s: string): string => (/[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = [options.columns.map((c) => quote(c.label)).join(','), ...shown.map((r) => options.columns.map((c) => quote(String(c.value(r) ?? ''))).join(','))];
    copy(lines.join('\n'));
  };
  copyJson.onclick = () => copy(JSON.stringify(shown.map((r) => Object.fromEntries(options.columns.map((c) => [c.key, c.value(r)]))), null, 1));
  search.oninput = refresh;
  category.onchange = refresh;
  drawHead();
  return { element: root, refresh };
}

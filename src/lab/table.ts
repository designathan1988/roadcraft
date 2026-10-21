import { icon } from './icons';
import { sendInvestigate } from './investigate';

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
  /** A bar behind each number, its length its share of the column's largest shown: the biggest consumers seen at a glance. */
  readonly bar?: boolean;
}

export interface LabTableOptions<R> {
  readonly columns: readonly LabColumn<R>[];
  rows(): readonly R[];
  /** The column sorted by at first, and whether descending (default: the first, descending). */
  readonly sort?: { readonly key: string; readonly desc: boolean };
  /** A column whose values are offered as a filter (a select). */
  readonly categoryKey?: string;
  /** A row clicked (its own detail); without it, a click investigates the row (`investigate.ts`), as the magnifier at its end always does. */
  onRow?(row: R): void;
  /** The tab the table is in, told to the investigation. */
  readonly from?: string;
  /** At most this many rows drawn (default 400): the rest counted. */
  readonly limit?: number;
}

export interface LabTable {
  readonly element: HTMLElement;
  /** The rows read again and drawn (sorted and filtered as set). */
  refresh(): void;
  /** The filter set from outside (a usage meter clicked, `LabTab.focus`): the text searched and/or the category shown. */
  setFilter(filter: { readonly text?: string; readonly category?: string }): void;
}

const fmt = (v: number): string => (Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 2 }));

export function createLabTable<R>(options: LabTableOptions<R>): LabTable {
  const root = document.createElement('div');
  root.className = 'lab-table';
  const bar = document.createElement('div');
  bar.className = 'lab-table-bar';
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Filter…';
  const category = document.createElement('select');
  const count = document.createElement('span');
  count.className = 'lab-muted';
  const copyCsv = document.createElement('button');
  copyCsv.type = 'button';
  copyCsv.textContent = 'CSV';
  copyCsv.title = 'Copy the filtered rows as CSV';
  const copyJson = document.createElement('button');
  copyJson.type = 'button';
  copyJson.textContent = 'JSON';
  copyJson.title = 'Copy the filtered rows as JSON';
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
    tr.appendChild(document.createElement('th'));
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
      const order = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va ?? '').localeCompare(String(vb ?? ''), 'en-US');
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
    const all = new Option(`All (${c.label})`, '');
    category.replaceChildren(all, ...values.map((v) => new Option(v, v)));
    category.value = values.includes(now) ? now : '';
  };

  function refresh(): void {
    drawCategories();
    shown = filtered();
    const limit = options.limit ?? 400;
    const page = shown.slice(0, limit);
    const largest = new Map<string, number>();
    for (const c of options.columns) {
      if (!c.bar) continue;
      let most = 0;
      for (const row of page) { const v = c.value(row); if (typeof v === 'number' && Math.abs(v) > most) most = Math.abs(v); }
      largest.set(c.key, most);
    }
    const rows: HTMLElement[] = [];
    for (const row of page) {
      const tr = document.createElement('tr');
      for (const c of options.columns) {
        const td = document.createElement('td');
        const v = c.value(row);
        if (typeof v === 'number') {
          td.className = 'num';
          td.textContent = c.format ? c.format(v, row) : fmt(v);
          const most = largest.get(c.key);
          if (most) td.style.setProperty('--bar', `${Math.min(100, (Math.abs(v) / most) * 100).toFixed(1)}%`);
          if (most) td.classList.add('bar');
        } else {
          td.textContent = v ?? '';
          td.title = v ?? '';
        }
        tr.appendChild(td);
      }
      const look = document.createElement('td');
      look.className = 'lab-look';
      const lookButton = document.createElement('button');
      lookButton.type = 'button';
      lookButton.title = 'Investigate: what it is, where it is in the code, what is tied to it';
      lookButton.appendChild(icon('search', 13));
      lookButton.onclick = (e) => { e.stopPropagation(); investigate(row, tr); };
      look.appendChild(lookButton);
      tr.prepend(look);
      tr.onclick = () => {
        for (const other of body.querySelectorAll('tr[data-selected]')) other.removeAttribute('data-selected');
        tr.dataset['selected'] = 'true';
        if (options.onRow) options.onRow(row); else investigate(row, tr);
      };
      rows.push(tr);
    }
    body.replaceChildren(...rows);
    count.textContent = shown.length > limit ? `${limit} of ${shown.length}` : `${shown.length} rows`;
  }

  /** The row as a subject: its first text its name, its category and origin columns, every column as a field. */
  function investigate(row: R, from: Element): void {
    const fields: [string, string][] = [];
    let name = '', category: string | undefined, origin: string | undefined;
    for (const c of options.columns) {
      const v = c.value(row);
      const text = v === null || v === undefined ? '' : typeof v === 'number' ? (c.format ? c.format(v, row) : fmt(v)) : v;
      fields.push([c.label, text]);
      if (!name && typeof v === 'string' && v) name = v;
      if (/^(category|cat)$/i.test(c.key) || /^category$/i.test(c.label)) category = text;
      if (/^(origin|source)$/i.test(c.key) || /^(origin|source)$/i.test(c.label)) origin = text;
    }
    sendInvestigate(from, { name: name || fields[0]?.[1] || '(unnamed)', ...(category ? { category } : {}), ...(origin ? { origin } : {}), ...(options.from ? { from: options.from } : {}), fields });
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
  return {
    element: root,
    refresh,
    setFilter(filter) {
      if (filter.text !== undefined) search.value = filter.text;
      if (filter.category !== undefined) {
        drawCategories();
        if (![...category.options].some((o) => o.value === filter.category)) category.appendChild(new Option(filter.category, filter.category));
        category.value = filter.category;
      }
      refresh();
    },
  };
}

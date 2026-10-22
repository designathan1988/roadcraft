import { icon } from './icons';
import { el } from './widgets';

/** A GRID OF CHOICES THAT NEVER SCROLLS, as CharacterStudio and Create-a-Sim lay their catalogues out: the pictures fill the height the panel has left,
 *  a page at a time (arrows, the wheel over the grid), the current choice's page opened first, and a search box once there is more than a page.
 *  Only the page shown asks for its pictures. */

export interface PickerEntry { readonly id: string; readonly label: string }

/** Where each catalogue was left (page, search), kept across the panel's redraws. */
export class PickerMemory {
  private readonly state = new Map<string, { page: number; query: string; current: string | null | undefined }>();
  of(key: string, current: string | null | undefined): { page: number; query: string; current: string | null | undefined } {
    let s = this.state.get(key);
    // A new choice made elsewhere: open on its page again.
    if (!s || s.current !== current) { s = { page: -1, query: s?.query ?? '', current }; this.state.set(key, s); }
    return s;
  }
}

const COLUMNS = 3;
const GAP = 6;
/** The bar under the grid (arrows and the page). */
const BAR = 30;

/** `picture(entry)` makes one tile's picture; `all` draws every entry (baking the pictures). */
export function picker(memory: PickerMemory, key: string, entries: readonly PickerEntry[], current: string | null | undefined,
  picture: (e: PickerEntry) => HTMLElement, pick: (id: string) => void, all = false): HTMLElement {
  const box = el('div', { cls: 'picker' });
  const grid = el('div', { cls: 'pics' });
  if (all) {
    for (const e of entries) grid.append(tile(e));
    box.append(grid);
    return box;
  }
  const s = memory.of(key, current);
  const input = el('input', { type: 'search', title: 'Buscar', value: s.query });
  const search = el('label', { cls: 'picker-search' }, icon('search', 14), input);
  const prev = el('button', { cls: 'picker-arrow', title: 'Página anterior' }, icon('left', 14));
  const next = el('button', { cls: 'picker-arrow', title: 'Próxima página' }, icon('right', 14));
  const where = el('span', { cls: 'picker-page' });
  const bar = el('div', { cls: 'picker-bar' }, prev, where, next);
  box.append(search, grid, bar);
  let perPage = COLUMNS * 3;

  function tile(e: PickerEntry): HTMLElement {
    const t = el('button', { cls: `pic${e.id === current ? ' on' : ''}`, title: e.label }, picture(e));
    t.onclick = () => pick(e.id);
    return t;
  }
  const shown = (): readonly PickerEntry[] => {
    const q = s.query.trim().toLowerCase();
    return q ? entries.filter((e) => e.label.toLowerCase().includes(q) || e.id.toLowerCase().includes(q)) : entries;
  };
  function draw(): void {
    const list = shown();
    const pages = Math.max(1, Math.ceil(list.length / perPage));
    if (s.page < 0) s.page = Math.max(0, Math.floor(list.findIndex((e) => e.id === current) / perPage));
    s.page = Math.min(pages - 1, Math.max(0, s.page));
    grid.replaceChildren(...list.slice(s.page * perPage, (s.page + 1) * perPage).map(tile));
    where.textContent = list.length ? `${s.page + 1} / ${pages}` : '0';
    prev.disabled = s.page === 0;
    next.disabled = s.page >= pages - 1;
    bar.classList.toggle('one', pages === 1);
    search.classList.toggle('on', entries.length > perPage || !!s.query);
  }
  /** As many rows as the height left holds (tiles are square), at least one. */
  function fit(): void {
    const width = grid.clientWidth || box.clientWidth;
    if (!width) return;
    const tileSide = (width - GAP * (COLUMNS - 1)) / COLUMNS;
    const height = box.clientHeight - BAR - (search.classList.contains('on') ? search.offsetHeight + GAP : 0);
    const rows = Math.max(1, Math.floor((height + GAP) / (tileSide + GAP)));
    const next = rows * COLUMNS;
    if (next !== perPage) { perPage = next; if (s.page >= 0) s.page = Math.floor((s.page * perPage) / next); draw(); }
  }
  prev.onclick = () => { s.page--; draw(); };
  next.onclick = () => { s.page++; draw(); };
  input.addEventListener('input', () => { s.query = input.value; s.page = 0; draw(); fit(); });
  box.addEventListener('wheel', (e) => {
    e.preventDefault();
    const step = Math.sign(e.deltaY);
    if (!step) return;
    s.page += step;
    draw();
  }, { passive: false });
  draw();
  new ResizeObserver(fit).observe(box);
  return box;
}

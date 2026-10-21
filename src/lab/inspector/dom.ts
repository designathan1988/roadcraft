import { icon } from '../icons';

/** Small DOM helpers of the inspector's tabs: elements, buttons, key-value grids and an expandable JSON view. */

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

/** A button: an icon (from `icons.ts`, '' none) and/or its text; `title` its tooltip and accessible name. */
export function button(glyph: string, text: string, title: string, onClick: () => void, className = ''): HTMLButtonElement {
  const b = el('button', className);
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  if (glyph) b.appendChild(icon(glyph));
  if (text) b.appendChild(el('span', '', text));
  b.onclick = onClick;
  return b;
}

export function bytes(n: number): string {
  if (n >= 1048576) return `${(n / 1048576).toLocaleString('en-US', { maximumFractionDigits: 2 })} MB`;
  if (n >= 1024) return `${(n / 1024).toLocaleString('en-US', { maximumFractionDigits: 1 })} KB`;
  return `${n} B`;
}

export const num = (v: number, digits = 3): string =>
  Number.isInteger(v) ? v.toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: digits });

/** A section heading. */
export function heading(text: string, glyph = ''): HTMLElement {
  const h = el('h3');
  if (glyph) h.appendChild(icon(glyph, 13));
  h.appendChild(document.createTextNode(text));
  return h;
}

/** A two-column grid of names and values (a value may be an element). */
export function kv(rows: readonly (readonly [string, string | number | boolean | null | undefined | Node])[]): HTMLElement {
  const grid = el('div', 'insp-kv');
  for (const [name, value] of rows) {
    grid.appendChild(el('span', 'insp-k', name));
    const v = el('span', 'insp-v');
    if (value instanceof Node) v.appendChild(value);
    else v.textContent = value === null || value === undefined ? '—' : typeof value === 'number' ? num(value) : String(value);
    grid.appendChild(v);
  }
  return grid;
}

/** A collapsible block (`<details>`), open or not. */
export function fold(title: string, open: boolean, ...content: Node[]): HTMLDetailsElement {
  const d = el('details', 'insp-fold');
  d.open = open;
  d.appendChild(el('summary', '', title));
  d.append(...content);
  return d;
}

/** A value's one-line preview, as a console shows it. */
export function preview(value: unknown, depth = 0): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return depth ? JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}…` : value) : value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof value === 'function') return `ƒ ${(value as { name?: string }).name || 'anonymous'}()`;
  if (typeof value === 'symbol') return value.toString();
  if (Array.isArray(value)) return depth > 1 ? `Array(${value.length})` : `[${value.slice(0, 6).map((v) => preview(v, depth + 1)).join(', ')}${value.length > 6 ? ', …' : ''}] (${value.length})`;
  if (ArrayBuffer.isView(value)) return `${value.constructor.name}(${(value as unknown as { length?: number }).length ?? value.byteLength})`;
  if (value instanceof Map) return `Map(${value.size})`;
  if (value instanceof Set) return `Set(${value.size})`;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  const o = value as Record<string, unknown> & { isObject3D?: boolean; isMaterial?: boolean; type?: string; name?: string };
  const ctor = (value as object).constructor?.name ?? 'Object';
  if (o.isObject3D || o.isMaterial) return `${o.type ?? ctor} "${o.name ?? ''}"`;
  if (depth > 1) return ctor === 'Object' ? '{…}' : ctor;
  const keys = Object.keys(o).slice(0, 5);
  return `${ctor === 'Object' ? '' : `${ctor} `}{${keys.map((k) => `${k}: ${preview(o[k], depth + 1)}`).join(', ')}${Object.keys(o).length > 5 ? ', …' : ''}}`;
}

/** The entries of a value a tree shows when it is opened (at most `limit`). */
function entriesOf(value: unknown, limit: number): [string, unknown][] {
  if (value instanceof Map) return [...value.entries()].slice(0, limit).map(([k, v]) => [preview(k, 2), v]);
  if (value instanceof Set) return [...value.values()].slice(0, limit).map((v, i) => [String(i), v]);
  if (ArrayBuffer.isView(value)) {
    const list = value as unknown as ArrayLike<number>;
    const out: [string, unknown][] = [];
    for (let i = 0; i < Math.min(limit, list.length ?? 0); i++) out.push([String(i), list[i]]);
    return out;
  }
  const out: [string, unknown][] = [];
  for (const key of Object.keys(value as object)) {
    if (out.length >= limit) break;
    out.push([key, (value as Record<string, unknown>)[key]]);
  }
  return out;
}

const expandable = (value: unknown): boolean => value !== null && (typeof value === 'object' || (typeof value === 'function' && Object.keys(value).length > 0));

/** A value as an expandable tree (each level made when it is opened, at most 300 entries). */
export function valueTree(value: unknown, label = ''): HTMLElement {
  if (!expandable(value)) {
    const line = el('div', 'insp-tree-leaf');
    if (label) line.appendChild(el('span', 'insp-tree-key', `${label}: `));
    line.appendChild(el('span', `insp-tree-val t-${value === null ? 'null' : typeof value}`, preview(value, label ? 1 : 0)));
    return line;
  }
  const d = el('details', 'insp-tree');
  const summary = el('summary');
  if (label) summary.appendChild(el('span', 'insp-tree-key', `${label}: `));
  summary.appendChild(el('span', 'insp-tree-val', preview(value, 1)));
  d.appendChild(summary);
  d.addEventListener('toggle', () => {
    if (!d.open || d.dataset['filled']) return;
    d.dataset['filled'] = '1';
    const body = el('div', 'insp-tree-body');
    const entries = entriesOf(value, 300);
    for (const [k, v] of entries) body.appendChild(valueTree(v, k));
    const total = value instanceof Map || value instanceof Set ? value.size : ArrayBuffer.isView(value) ? (value as unknown as { length: number }).length : Object.keys(value as object).length;
    if (total > entries.length) body.appendChild(el('div', 'lab-muted', `… ${total - entries.length} more`));
    if (typeof value === 'object' && value && !Array.isArray(value)) {
      const proto = Object.getPrototypeOf(value) as object | null;
      if (proto && proto !== Object.prototype) body.appendChild(el('div', 'lab-muted', `[[Prototype]] ${proto.constructor?.name ?? ''}`));
    }
    d.appendChild(body);
  });
  return d;
}

/** JSON of anything the game holds: Maps and Sets as arrays, typed arrays summarised, cycles cut. */
export function safeJson(value: unknown, space = 1): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint') return String(v);
    if (typeof v === 'function') return undefined;
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[cycle]';
      seen.add(v);
      if (v instanceof Map) return Object.fromEntries([...v.entries()].map(([k, x]) => [String(k), x]));
      if (v instanceof Set) return [...v];
      if (ArrayBuffer.isView(v)) return `${v.constructor.name}(${(v as unknown as { length?: number }).length ?? v.byteLength})`;
      if ((v as { isObject3D?: boolean }).isObject3D) return `${(v as { type: string }).type} "${(v as { name: string }).name}"`;
    }
    return v;
  }, space) ?? 'undefined';
}

/** Text to the clipboard, a failure logged. */
export function copyText(text: string): void {
  void navigator.clipboard.writeText(text).catch((error: unknown) => console.warn('lab inspector: not copied', error));
}

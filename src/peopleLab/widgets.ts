import { proxyUrl } from '@people/body/proxy';
import PROXY_FILES from 'virtual:model-urls/people/proxies?ext=json,bin,webp';
import { communityItem } from '@people/wardrobe';
import { icon } from './icons';

/** THE LAB'S CONTROLS: a slider, colour swatches, a segmented choice, a grid of items with their thumbnails */

export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { cls?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  const { cls, ...rest } = props;
  if (cls) e.className = cls;
  Object.assign(e, rest);
  e.append(...kids);
  return e;
};

/** The controls, redrawing the panel (`render`) after a pick. */
export function widgets(render: () => void) {
  function slider(label: string, min: number, max: number, step: number, value: number, set: (v: number) => void, show: (v: number) => string = (v) => v.toFixed(2)): HTMLElement {
    const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
    const out = el('output', { textContent: show(value) });
    input.addEventListener('input', () => { out.textContent = show(+input.value); set(+input.value); });
    return el('label', { cls: 'row' }, el('span', { textContent: label }), input, out);
  }

  function swatches(colours: readonly number[], current: number, set: (c: number) => void): HTMLElement {
    const box = el('div', { cls: 'swatches' });
    for (const c of colours) {
      const b = el('button', { title: `#${c.toString(16).padStart(6, '0')}` });
      b.style.background = `#${c.toString(16).padStart(6, '0')}`;
      if (c === current) b.classList.add('on');
      b.onclick = () => { set(c); render(); };
      box.append(b);
    }
    const free = el('input', { type: 'color', value: `#${current.toString(16).padStart(6, '0')}`, title: 'Qualquer cor' });
    free.addEventListener('change', () => { set(parseInt(free.value.slice(1), 16)); render(); });
    box.append(free);
    return box;
  }

  function seg<T extends string>(options: readonly (readonly [T, string])[], current: T, set: (v: T) => void): HTMLElement {
    const box = el('div', { cls: 'seg' });
    for (const [v, label] of options) {
      const b = el('button', { textContent: label });
      if (v === current) b.classList.add('on');
      b.onclick = () => { set(v); render(); };
      box.append(b);
    }
    return box;
  }

  const hasThumb = (name: string): boolean => `${name}-thumb.webp` in PROXY_FILES;
  function thumbOf(name: string): string | null {
    // Not every item ships a thumbnail: drawn as a glyph instead.
    return hasThumb(name) ? proxyUrl(`${name}-thumb.webp`) : null;
  }

  const pretty = (name: string): string => name.replace(/^(female|male)_/, '').replace(/^[a-z0-9]+_(?=[a-z])/i, (m) => (communityItem(name) ? '' : m))
    .replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 26);

  function tiles(names: readonly string[], current: string | undefined, set: (name: string) => void, none?: string): HTMLElement {
    const grid = el('div', { cls: 'grid' });
    const add = (name: string, label: string, glyph?: string): void => {
      const t = el('button', { cls: `tile${name === current ? ' on' : ''}`, title: name });
      const src = glyph ? null : thumbOf(name);
      t.append(src ? el('img', { src, loading: 'lazy', alt: '' }) : el('span', { cls: 'glyph', textContent: glyph ?? '•' }), label);
      t.onclick = () => { set(name); render(); };
      grid.append(t);
    };
    if (none) add('none', none, '∅');
    for (const n of names) add(n, pretty(n));
    return grid;
  }
  /** A segmented choice drawn as icons, each named by its tooltip. */
  function iconSeg<T extends string>(options: readonly (readonly [T, string, string])[], current: T, set: (v: T) => void): HTMLElement {
    const box = el('div', { cls: 'seg icons' });
    for (const [v, name, title] of options) {
      const b = el('button', { title }, icon(name, 16));
      if (v === current) b.classList.add('on');
      b.onclick = () => { set(v); render(); };
      box.append(b);
    }
    return box;
  }

  /** An on/off icon button. */
  function toggle(name: string, title: string, on: boolean, set: (v: boolean) => void): HTMLElement {
    const b = el('button', { cls: `toggle${on ? ' on' : ''}`, title }, icon(name, 16));
    b.onclick = () => { set(!on); render(); };
    return b;
  }
  return { slider, swatches, seg, iconSeg, toggle, tiles };
}

import type { BrushName, HairSculptor } from './sculpt';
import { el, type widgets } from './widgets';
import { icon } from './icons';

/** THE HAIR SCULPTOR'S PANEL: the whole piece longer, shorter, looser or closer, its brushes, their size and strength, undo, finishing - icons, named by their tooltips */

const BRUSHES: readonly (readonly [BrushName, string, string])[] = [
  ['grab', 'grab', 'Puxar'], ['inflate', 'inflate', 'Inflar'], ['smooth', 'smooth', 'Suavizar'],
  ['flatten', 'flatten', 'Achatar'], ['pinch', 'pinch', 'Apertar'], ['shorten', 'scissors', 'Recolher'],
];

export interface SculptPanelHooks {
  readonly slider: ReturnType<typeof widgets>['slider'];
  readonly render: () => void;
  /** Closes the sculptor, keeping the sculpt or not. */
  readonly close: (keep: boolean) => void;
}

export function sculptPanel(s: HairSculptor, { slider, render, close }: SculptPanelHooks): Node[] {
  const button = (ico: string, title: string, run: () => void, on = false): HTMLButtonElement => {
    const b = el('button', { cls: `toggle${on ? ' on' : ''}`, title }, icon(ico, 16));
    b.onclick = () => { run(); render(); };
    return b;
  };
  return [
    el('div', { cls: 'bar' },
      button('grow', 'Peça mais longa', () => s.lengthen(1.12)), button('gravity', 'Peça mais curta', () => s.lengthen(0.9)),
      button('inflate', 'Peça mais larga', () => s.loosen(0.08)), button('pinch', 'Peça mais justa', () => s.loosen(-0.06))),
    el('div', { cls: 'seg icons' }, ...BRUSHES.map(([b, glyph, label]) => {
      const t = el('button', { cls: s.brush === b ? 'on' : '', title: label }, icon(glyph, 16));
      t.onclick = () => { s.brush = b; render(); };
      return t;
    })),
    slider('Tamanho', 1, 20, 0.5, s.radius * 10, (v) => { s.radius = v / 10; }, (v) => `${v} cm`),
    slider('Força', 0.05, 1, 0.01, s.strength, (v) => { s.strength = v; }),
    el('div', { cls: 'bar' },
      button('mirror', 'Simetria', () => { s.mirror = !s.mirror; }, s.mirror),
      button('undo', 'Desfazer (Ctrl+Z)', () => s.undoStep()),
      button('redo', 'Refazer (Ctrl+Y)', () => s.redoStep()),
      button('trash', 'Voltar ao original', () => s.reset()),
      el('span', { cls: 'bar-gap' }),
      button('close', 'Cancelar', () => close(false)),
      button('check', 'Concluir', () => close(true), true)),
  ];
}

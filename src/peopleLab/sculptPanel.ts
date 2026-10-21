import type { BrushName, HairSculptor } from './sculpt';
import { el, type widgets } from './widgets';
import { icon } from './icons';

/** THE HAIR SCULPTOR'S PANEL: its brushes, their size and strength, undo, and finishing */

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
  const undo = el('button', { cls: 'big alt' }, icon('undo', 15), 'Desfazer');
  undo.onclick = () => s.undoStep();
  const redo = el('button', { cls: 'big alt' }, icon('redo', 15), 'Refazer');
  redo.onclick = () => s.redoStep();
  const reset = el('button', { cls: 'big alt', textContent: 'Original' });
  reset.onclick = () => s.reset();
  const done = el('button', { cls: 'big save' }, icon('check', 16), 'Concluir');
  done.onclick = () => close(true);
  const cancel = el('button', { cls: 'big alt', textContent: 'Cancelar' });
  cancel.onclick = () => close(false);
  const mirror = el('label', { cls: 'check' }, el('input', { type: 'checkbox', checked: s.mirror }), 'Simetria');
  mirror.querySelector('input')!.addEventListener('change', (e) => { s.mirror = (e.target as HTMLInputElement).checked; });
  const step = (label: string, run: () => void): HTMLButtonElement => { const b = el('button', { cls: 'big alt', textContent: label }); b.onclick = run; return b; };
  return [
    el('h3', { textContent: 'Peça inteira' }),
    el('div', { cls: 'pair' }, step('Mais longa', () => s.lengthen(1.12)), step('Mais curta', () => s.lengthen(0.9))),
    el('div', { cls: 'pair' }, step('Mais larga', () => s.loosen(0.08)), step('Mais justa', () => s.loosen(-0.06))),
    el('h3', { textContent: 'Pincel' }),
    el('div', { cls: 'tools' }, ...BRUSHES.map(([b, glyph, label]) => {
      const t = el('button', { cls: `tool${s.brush === b ? ' on' : ''}` }, icon(glyph, 18), label);
      t.onclick = () => { s.brush = b; render(); };
      return t;
    })),
    el('h3', { textContent: 'Ajuste' }),
    slider('Tamanho', 1, 20, 0.5, s.radius * 10, (v) => { s.radius = v / 10; }, (v) => `${v} cm`),
    slider('Força', 0.05, 1, 0.01, s.strength, (v) => { s.strength = v; }),
    mirror,
    el('div', { cls: 'pair' }, undo, redo), reset,
    el('div', { cls: 'pair' }, cancel, done),
  ];
}

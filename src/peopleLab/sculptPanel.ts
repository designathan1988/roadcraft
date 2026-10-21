import type { BrushName, HairSculptor } from './sculpt';
import { el, type widgets } from './widgets';

/** THE HAIR SCULPTOR'S PANEL: its brushes, their size and strength, undo, and finishing */

const BRUSHES: readonly (readonly [BrushName, string, string])[] = [
  ['grab', '✋', 'Puxar'], ['inflate', '🎈', 'Volume'], ['smooth', '🪮', 'Alisar'],
  ['flatten', '🧱', 'Achatar'], ['pinch', '🤏', 'Apertar'], ['shorten', '✂️', 'Encurtar'],
];

export interface SculptPanelHooks {
  readonly slider: ReturnType<typeof widgets>['slider'];
  readonly render: () => void;
  /** Closes the sculptor, keeping the sculpt or not. */
  readonly close: (keep: boolean) => void;
}

export function sculptPanel(s: HairSculptor, { slider, render, close }: SculptPanelHooks): Node[] {
  const undo = el('button', { cls: 'big alt', textContent: '↶ Desfazer' });
  undo.onclick = () => s.undoStep();
  const redo = el('button', { cls: 'big alt', textContent: '↷ Refazer' });
  redo.onclick = () => s.redoStep();
  const reset = el('button', { cls: 'big alt', textContent: 'Voltar ao original' });
  reset.onclick = () => s.reset();
  const done = el('button', { cls: 'big save', textContent: '✔ Concluir' });
  done.onclick = () => close(true);
  const cancel = el('button', { cls: 'big alt', textContent: 'Cancelar' });
  cancel.onclick = () => close(false);
  const mirror = el('label', { cls: 'check' }, el('input', { type: 'checkbox', checked: s.mirror }), 'Espelhar nos dois lados');
  mirror.querySelector('input')!.addEventListener('change', (e) => { s.mirror = (e.target as HTMLInputElement).checked; });
  const step = (label: string, run: () => void): HTMLButtonElement => { const b = el('button', { cls: 'big alt', textContent: label }); b.onclick = run; return b; };
  return [
    el('h3', { textContent: 'Peça inteira' }),
    el('div', { cls: 'pair' }, step('⬇ Mais longa', () => s.lengthen(1.12)), step('⬆ Mais curta', () => s.lengthen(0.9))),
    el('div', { cls: 'pair' }, step('↔ Mais larga', () => s.loosen(0.08)), step('→← Mais justa', () => s.loosen(-0.06))),
    el('h3', { textContent: 'Pincel' }),
    el('div', { cls: 'grid' }, ...BRUSHES.map(([b, glyph, label]) => {
      const t = el('button', { cls: `tile${s.brush === b ? ' on' : ''}` }, el('span', { cls: 'glyph', textContent: glyph }), label);
      t.onclick = () => { s.brush = b; render(); };
      return t;
    })),
    el('h3', { textContent: 'Ajuste' }),
    slider('Tamanho', 1, 20, 0.5, s.radius * 10, (v) => { s.radius = v / 10; }, (v) => `${v} cm`),
    slider('Força', 0.05, 1, 0.01, s.strength, (v) => { s.strength = v; }),
    mirror,
    el('div', { cls: 'pair' }, undo, redo), reset,
    el('h3', { textContent: 'Pronto?' }), done, cancel,
  ];
}

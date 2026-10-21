import type { BodyBrush, BodySculptor } from './bodySculpt';
import { icon } from './icons';
import { el, type widgets } from './widgets';

/** THE BODY SCULPTOR'S PANEL: brushes as icons, size and strength, symmetry, undo */

const BRUSHES: readonly (readonly [BodyBrush, string, string])[] = [
  ['draw', 'sculpt', 'Desenhar'], ['inflate', 'inflate', 'Inflar'], ['grab', 'grab', 'Puxar'], ['smooth', 'smooth', 'Suavizar'],
  ['flatten', 'flatten', 'Achatar'], ['pinch', 'pinch', 'Apertar'], ['crease', 'part', 'Vinco'],
];

export interface BodySculptHooks {
  readonly slider: ReturnType<typeof widgets>['slider'];
  readonly render: () => void;
  readonly close: (keep: boolean) => void;
}

export function bodySculptPanel(s: BodySculptor, { slider, render, close }: BodySculptHooks): Node[] {
  const button = (label: string, run: () => void, ico?: string, cls = 'big alt'): HTMLButtonElement => {
    const b = ico ? el('button', { cls }, icon(ico, 15), label) : el('button', { cls, textContent: label });
    b.onclick = () => { run(); render(); };
    return b;
  };
  const mirror = el('label', { cls: 'check' }, el('input', { type: 'checkbox', checked: s.mirror }), 'Simetria');
  mirror.querySelector('input')!.addEventListener('change', (e) => { s.mirror = (e.target as HTMLInputElement).checked; });
  return [
    el('div', { cls: 'tools' }, ...BRUSHES.map(([b, ico, label]) => {
      const t = el('button', { cls: `tool${s.brush === b ? ' on' : ''}`, title: label }, icon(ico, 18), label);
      t.onclick = () => { s.brush = b; render(); };
      return t;
    })),
    el('div', { cls: 'gap' }),
    slider('Tamanho', 0.5, 15, 0.5, s.radius * 10, (v) => { s.radius = v / 10; }, (v) => `${v} cm`),
    slider('Força', 0.05, 1, 0.01, s.strength, (v) => { s.strength = v; }),
    mirror,
    el('div', { cls: 'pair' }, button('Desfazer', () => s.undoStep(), 'undo'), button('Refazer', () => s.redoStep(), 'redo')),
    button('Original', () => s.reset()),
    el('div', { cls: 'pair' }, button('Cancelar', () => close(false)), button('Concluir', () => close(true), 'check', 'big save')),
  ];
}

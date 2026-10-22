import type { BodyBrush, BodySculptor } from './bodySculpt';
import { icon } from './icons';
import { el, type widgets } from './widgets';

/** THE BODY SCULPTOR'S PANEL: brushes as icons, size and strength, symmetry, undo - each named by its tooltip */

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
  const button = (ico: string, title: string, run: () => void, on = false): HTMLButtonElement => {
    const b = el('button', { cls: `toggle${on ? ' on' : ''}`, title }, icon(ico, 16));
    b.onclick = () => { run(); render(); };
    return b;
  };
  return [
    el('div', { cls: 'seg icons' }, ...BRUSHES.map(([b, ico, label]) => {
      const t = el('button', { cls: s.brush === b ? 'on' : '', title: label }, icon(ico, 16));
      t.onclick = () => { s.brush = b; render(); };
      return t;
    })),
    slider('Tamanho', 0.5, 15, 0.5, s.radius * 10, (v) => { s.radius = v / 10; }, (v) => `${v} cm`),
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

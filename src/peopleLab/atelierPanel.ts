import type { Atelier } from './atelier';
import { icon } from './icons';
import { el, type widgets } from './widgets';

/** THE ATELIER'S PANEL: the pattern, its cut, the fabric, the drape running or held */

const PATTERNS: readonly (readonly [string, string])[] = [['vestido', 'Vestido'], ['saia', 'Saia'], ['camiseta', 'Camiseta'], ['top', 'Top']];

export interface AtelierHooks {
  readonly ui: ReturnType<typeof widgets>;
  readonly render: () => void;
  readonly close: (keep: boolean) => void;
  readonly colours: readonly number[];
}

export function atelierPanel(a: Atelier, { ui, render, close, colours }: AtelierHooks): Node[] {
  const { slider, swatches } = ui;
  const button = (label: string, run: () => void, ico?: string, cls = 'big alt'): HTMLButtonElement => {
    const b = ico ? el('button', { cls }, icon(ico, 15), label) : el('button', { cls, textContent: label });
    b.onclick = () => { run(); render(); };
    return b;
  };
  return [
    el('div', { cls: 'seg' }, ...PATTERNS.map(([id, label]) => {
      const b = el('button', { textContent: label, cls: a.pattern === id ? 'on' : '' });
      b.onclick = () => { a.draft(id); render(); };
      return b;
    })),
    el('h3', { textContent: 'Molde' }),
    slider('Comprimento', -10, 20, 0.5, a.cut.length * 10, (v) => a.draft(a.pattern, { length: v / 10 }), (v) => `${v} cm`),
    slider('Folga', 1.0, 1.6, 0.01, a.cut.ease, (v) => a.draft(a.pattern, { ease: v })),
    slider('Rodado', 0, 3, 0.05, a.cut.flare, (v) => a.draft(a.pattern, { flare: v })),
    el('h3', { textContent: 'Tecido' }),
    slider('Caimento', 0, 2, 0.01, a.stiffness, (v) => a.setStiffness(v)),
    swatches(colours, a.colour, (c) => a.setColour(c)),
    el('h3', { textContent: 'Simulação' }),
    el('div', { cls: 'pair' }, button(a.running ? 'Pausar' : 'Simular', () => { a.running = !a.running; }, a.running ? 'stop' : 'sim'), button('Refazer molde', () => a.draft(), 'redo')),
    el('div', { cls: 'pair' }, button('Cancelar', () => close(false)), button('Concluir', () => close(true), 'check', 'big save')),
  ];
}

import type { Atelier } from './atelier';
import { icon } from './icons';
import { el, type widgets } from './widgets';

/** THE ATELIER'S PANEL: the pattern, its cut (length, ease, flare, sleeve, neckline), the fabric, the drape running or held - icons, no words */

const PATTERNS: readonly (readonly [string, string, string])[] = [['vestido', 'dress', 'Vestido'], ['saia', 'skirt', 'Saia'], ['camiseta', 'tshirt', 'Camiseta'], ['top', 'tube', 'Top']];

export interface AtelierHooks {
  readonly ui: ReturnType<typeof widgets>;
  readonly render: () => void;
  readonly close: (keep: boolean) => void;
  readonly colours: readonly number[];
}

export function atelierPanel(a: Atelier, { ui, render, close, colours }: AtelierHooks): Node[] {
  const { slider, swatches, iconSeg } = ui;
  const button = (ico: string, title: string, run: () => void, cls = 'toggle'): HTMLButtonElement => {
    const b = el('button', { cls, title }, icon(ico, 16));
    b.onclick = () => { run(); render(); };
    return b;
  };
  const sleeved = a.pattern === 'camiseta', necked = a.pattern === 'camiseta' || a.pattern === 'vestido';
  return [
    iconSeg(PATTERNS, a.pattern, (id) => a.draft(id)),
    slider('Comprimento', -10, 20, 0.5, a.cut.length * 10, (v) => a.draft(a.pattern, { length: v / 10 }), (v) => `${v} cm`),
    slider('Folga', 1.0, 1.6, 0.01, a.cut.ease, (v) => a.draft(a.pattern, { ease: v })),
    slider('Rodado', 0, 3, 0.05, a.cut.flare, (v) => a.draft(a.pattern, { flare: v })),
    ...(sleeved ? [slider('Manga', 0, 2, 0.1, a.cut.sleeve ?? 1.6, (v) => a.draft(a.pattern, { sleeve: v }), (v) => `${Math.round(v * 10)} cm`)] : []),
    ...(necked ? [slider('Decote', 0, a.pattern === 'camiseta' ? 0.6 : 2.5, 0.05, a.cut.neck ?? 0.1, (v) => a.draft(a.pattern, { neck: v }), (v) => `${Math.round(v * 10)} cm`)] : []),
    slider('Caimento', 0, 2, 0.01, a.stiffness, (v) => a.setStiffness(v)),
    swatches(colours, a.colour, (c) => a.setColour(c)),
    el('div', { cls: 'bar' },
      button(a.running ? 'stop' : 'sim', a.running ? 'Pausar simulação' : 'Simular', () => { a.running = !a.running; }),
      button('redo', 'Refazer molde', () => a.draft()),
      el('span', { cls: 'bar-gap' }),
      button('close', 'Cancelar', () => close(false)),
      button('check', 'Concluir', () => close(true), 'toggle on')),
  ];
}

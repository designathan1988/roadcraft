import type { HairStudio, HairTool } from './hairStudio';
import type { ShellPreset } from './hairShell';
import { icon } from './icons';
import { el, type widgets } from './widgets';

/** THE HAIR STUDIO'S PANEL: tools as icons, styles to start from, the brush, the strands' settings */

const TOOLS: readonly (readonly [HairTool, string, string])[] = [
  ['comb', 'comb', 'Pentear'], ['grab', 'grab', 'Puxar'], ['cut', 'scissors', 'Cortar'], ['grow', 'grow', 'Crescer'],
  ['puff', 'inflate', 'Volume'], ['smooth', 'smooth', 'Alisar'], ['curl', 'wave', 'Ondular'], ['part', 'part', 'Risca'], ['tie', 'tie', 'Prender'],
];

const STYLES: readonly (readonly [ShellPreset, string])[] = [
  ['short', 'Curto'], ['bob', 'Chanel'], ['long', 'Longo'], ['ponytail', 'Rabo'], ['bun', 'Coque'], ['pigtails', 'Marias'],
];

export interface HairPanelHooks {
  readonly ui: ReturnType<typeof widgets>;
  readonly render: () => void;
  readonly close: (keep: boolean) => void;
  readonly colours: readonly number[];
}

export function hairPanel(s: HairStudio, { ui, render, close, colours }: HairPanelHooks): Node[] {
  const { slider, swatches } = ui;
  const button = (label: string, run: () => void, ico?: string, cls = 'big alt'): HTMLButtonElement => {
    const b = ico ? el('button', { cls }, icon(ico, 15), label) : el('button', { cls, textContent: label });
    b.onclick = () => { run(); render(); };
    return b;
  };
  const toggle = (label: string, on: boolean, set: (v: boolean) => void): HTMLElement => {
    const t = el('label', { cls: 'check' }, el('input', { type: 'checkbox', checked: on }), label);
    t.querySelector('input')!.addEventListener('change', (e) => { set((e.target as HTMLInputElement).checked); render(); });
    return t;
  };
  return [
    el('div', { cls: 'tools' }, ...TOOLS.map(([tool, ico, label]) => {
      const t = el('button', { cls: `tool${s.tool === tool ? ' on' : ''}`, title: label }, icon(ico, 18), label);
      t.onclick = () => { s.tool = tool; render(); };
      return t;
    })),
    el('h3', { textContent: 'Início' }),
    el('div', { cls: 'chips' }, ...STYLES.map(([id, label]) => {
      const b = el('button', { textContent: label });
      b.onclick = () => { s.preset(id); render(); };
      return b;
    })),
    el('h3', { textContent: 'Pincel' }),
    slider('Tamanho', 2, 30, 0.5, s.radius * 10, (v) => { s.radius = v / 10; }, (v) => `${v} cm`),
    slider('Força', 0.05, 1, 0.01, s.strength, (v) => { s.strength = v; }),
    toggle('Simetria', s.mirror, (v) => { s.mirror = v; }),
    el('h3', { textContent: 'Cabelo' }),
    slider('Comprimento', 5, 60, 1, Math.round(s.length * 10), (v) => s.setLength(v / 10), (v) => `${v} cm`),
    slider('Volume', 0.2, 2.5, 0.1, s.volume * 10, (v) => s.setVolume(v / 10), (v) => `${v.toFixed(1)} cm`),
    slider('Mechas', 12, 60, 1, s.strands, (v) => s.setStrands(v), (v) => String(v)),
    slider('Largura', 1, 2.6, 0.05, s.overlap, (v) => s.setOverlap(v)),
    toggle('Pontas retas', s.blunt, (v) => s.setBlunt(v)),
    swatches(colours, -1, (c) => s.setColour(c)),
    button('Soltar prendedores', () => s.clearTies(), 'tie'),
    el('div', { cls: 'pair' }, button('Desfazer', () => s.undoStep(), 'undo'), button('Refazer', () => s.redoStep(), 'redo')),
    el('div', { cls: 'pair' }, button('Cancelar', () => close(false)), button('Concluir', () => close(true), 'check', 'big save')),
  ];
}

import { HAIR_STYLES, type HairStyle } from '@people/hair/procedural';
import type { widgets } from './widgets';

/** HAIR MADE HERE, as the groom tools make it (guide curves grown from the scalp, cards along them, pinned to the head as an item:
 *  `procedural.ts`): a starting style, then cut by region, combed, given texture, a fringe, and tied - each a few sliders, one tool at a time. */

type Tool = 'cut' | 'comb' | 'texture' | 'fringe' | 'tie';

/** The tool shown. */
const view: { tool: Tool } = { tool: 'cut' };

/** Ways of tying: none, a ponytail, a bun, a braid, two tails. */
type Tie = 'none' | 'tail' | 'bun' | 'braid' | 'twin';
const tieOf = (h: HairStyle): Tie => (!h.gather ? 'none' : h.gather.twin ? 'twin' : h.gather.braid ? 'braid' : h.gather.bun ? 'bun' : 'tail');
const TIES: Readonly<Record<Exclude<Tie, 'none'>, NonNullable<HairStyle['gather']>>> = {
  tail: { at: [0, 7.75, -0.55], tail: 3.2 },
  bun: { at: [0, 8.05, -0.45], tail: 0, bun: 0.42 },
  braid: { at: [0, 7.45, -0.6], tail: 3.6, braid: true },
  twin: { at: [0.62, 7.55, -0.2], tail: 2.4, twin: true },
};

/** The starting styles, in the order shown. */
export const HAIR_BASES: readonly string[] = Object.keys(HAIR_STYLES);

export function hairToolNodes(ui: ReturnType<typeof widgets>, hair: HairStyle, set: (h: HairStyle) => void): Node[] {
  const { slider, iconSeg } = ui;
  const named = (h: HairStyle): HairStyle => ({ ...h, name: 'custom' });
  const put = (patch: Partial<HairStyle>): void => set(named({ ...hair, ...patch }));
  const region = (k: keyof NonNullable<HairStyle['regions']>): number => hair.regions?.[k] ?? 1;
  const putRegion = (k: keyof NonNullable<HairStyle['regions']>, v: number): void => put({ regions: { ...(hair.regions ?? {}), [k]: v } });
  const tools = iconSeg<Tool>([['cut', 'scissors', 'Cortar'], ['comb', 'comb', 'Pentear'], ['texture', 'wave', 'Textura'], ['fringe', 'fringe', 'Franja'], ['tie', 'tie', 'Prender']],
    view.tool, (t) => { view.tool = t; });
  const cm = (v: number): string => `${Math.round(v * 10)} cm`;
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  const body: Record<Tool, () => Node[]> = {
    cut: () => [
      slider('Comprimento', 0.2, 6, 0.05, hair.length, (v) => put({ length: v }), cm),
      slider('Frente', 0.2, 1.6, 0.01, region('front'), (v) => putRegion('front', v), pct),
      slider('Topo', 0.2, 1.6, 0.01, region('crown'), (v) => putRegion('crown', v), pct),
      slider('Laterais', 0.2, 1.6, 0.01, region('temple'), (v) => putRegion('temple', v), pct),
      slider('Atrás', 0.2, 1.6, 0.01, region('occipital'), (v) => putRegion('occipital', v), pct),
      slider('Nuca', 0.2, 1.6, 0.01, region('nape'), (v) => putRegion('nape', v), pct),
    ],
    comb: () => [
      ui.toggle('slick', 'Penteado para trás', !!hair.back, (v) => put({ back: v })),
      slider('Risca', -1, 1, 0.01, hair.part, (v) => put({ part: v })),
      slider('Para o lado', -1, 1, 0.01, hair.sweep ?? 0, (v) => put({ sweep: v })),
      slider('Topete', 0, 0.8, 0.01, hair.quiff ?? 0, (v) => put({ quiff: v }), cm),
      slider('Volume', 0, 1, 0.01, hair.volume, (v) => put({ volume: v }), cm),
      slider('Caimento', 0, 1, 0.01, hair.gravity, (v) => put({ gravity: v }), pct),
    ],
    texture: () => [
      slider('Ondas', 0, 0.2, 0.005, hair.wave?.amplitude ?? 0, (v) => put({ wave: v > 0 ? { amplitude: v, wavelength: hair.wave?.wavelength ?? 1.3 } : undefined, strands: v > 0 || hair.curl ? 'wavy' : 'straight' } as Partial<HairStyle>), cm),
      slider('Largura da onda', 0.5, 3, 0.05, hair.wave?.wavelength ?? 1.3, (v) => { if (hair.wave) put({ wave: { ...hair.wave, wavelength: v } }); }, cm),
      slider('Cachos', 0, 0.25, 0.005, hair.curl?.radius ?? 0, (v) => put({ curl: v > 0 ? { radius: v, pitch: hair.curl?.pitch ?? Math.max(0.2, v * 2.8) } : undefined, strands: v > 0 || hair.wave ? 'wavy' : 'straight' } as Partial<HairStyle>), cm),
      slider('Densidade', 120, 320, 10, hair.clumps, (v) => put({ clumps: v }), (v) => String(v)),
    ],
    fringe: () => [
      slider('Comprimento', 0, 2, 0.05, hair.fringe?.length ?? 0, (v) => put({ fringe: v > 0 ? { length: v, width: hair.fringe?.width ?? 0.55 } : undefined } as Partial<HairStyle>), cm),
      slider('Largura', 0.2, 1, 0.01, hair.fringe?.width ?? 0.55, (v) => { if (hair.fringe) put({ fringe: { ...hair.fringe, width: v } }); }, pct),
    ],
    tie: () => {
      const tie = tieOf(hair);
      const g = hair.gather;
      return [
        iconSeg<Tie>([['none', 'loose', 'Solto'], ['tail', 'tied', 'Rabo de cavalo'], ['bun', 'inflate', 'Coque'], ['braid', 'sew', 'Trança'], ['twin', 'part', 'Dois rabos']], tie,
          (t) => put({ gather: t === 'none' ? undefined : TIES[t] } as Partial<HairStyle>)),
        ...(g ? [
          slider('Altura', 7, 8.7, 0.01, g.at[1], (v) => put({ gather: { ...g, at: [g.at[0], v, g.at[2]] } }), (v) => (v - 7).toFixed(2)),
          slider('Para trás', -0.8, 0.3, 0.01, -g.at[2], (v) => put({ gather: { ...g, at: [g.at[0], g.at[1], -v] } }), (v) => v.toFixed(2)),
          ...(g.bun ? [slider('Coque', 0.2, 0.7, 0.01, g.bun, (v) => put({ gather: { ...g, bun: v } }), cm)]
            : [slider('Rabo', 0.5, 5, 0.05, g.tail, (v) => put({ gather: { ...g, tail: v } }), cm)]),
        ] : []),
      ];
    },
  };
  return [tools, ...body[view.tool]()];
}

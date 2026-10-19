import { gpuLedger } from '@render/gpuLedger';
import type { Draw, Snapshot } from './measure';

/** THE DIAGNOSIS'S FINDINGS: the snapshot read as causes - the bottleneck, the passes and layers the GPU spends on, the objects that weigh most, the shadows, the draw calls, the CPU's systems and functions, the hitches, the memory - each with its figures, why it matters, the switch that tests it and where to look. */

export type Severity = 'alta' | 'média' | 'baixa' | 'info';

export interface Finding {
  readonly id: string;
  readonly area: 'GPU' | 'CPU' | 'Memória' | 'Engasgos';
  readonly severity: Severity;
  readonly title: string;
  readonly evidence: readonly string[];
  readonly why: string;
  /** Its estimated cost, ms a frame (sorts the list). */
  readonly ms: number;
  /** What to switch to test it (`EffectsWiring.setMany` values) and how it reads. */
  readonly test?: { readonly label: string; readonly values: Readonly<Record<string, boolean | string>>; readonly back: Readonly<Record<string, boolean | string>> };
  /** A layer of the scene (the frame tab's filter, the inspector's object). */
  readonly layer?: string;
  readonly object?: unknown;
  /** A function of the profile (file:line). */
  readonly where?: string;
  readonly pass?: string;
}

/** A layer of the scene (the capture's `layer`) and the switch that hides it (`effectSwitches.ts`). */
const LAYER_SWITCH: readonly (readonly [RegExp, string, string])[] = [
  [/building-part-cells/, 'bParts', 'peças das células dos prédios (janelas, grades, toldos, objetos)'],
  [/buildings-far-levels|buildings-far/, 'bMasses', 'massas e níveis distantes dos prédios'],
  [/buildings-layer \/ buildings$|buildings-layer$/, 'bDetail', 'células de prédios em detalhe (paredes)'],
  [/facade/, 'bFacadeLevel', 'nível de fachada dos prédios'],
  [/signature/, 'bSignatures', 'prédios assinatura'],
  [/flags/, 'bFlags', 'bandeiras'],
  [/far-tiles|farTiles/, 'bFarTiles', 'prédios dos tiles distantes'],
  [/agent-parts|rigged-citizens|procedural-people/, 'people', 'pessoas e veículos'],
  [/road-network|road-stand-in|structure/, 'roads', 'ruas, viadutos e pinturas'],
  [/far-roads/, 'farRoads', 'ruas distantes'],
  [/street-furniture|grass/, 'furniture', 'mobiliário urbano e capim'],
  [/traffic-signals/, 'signals', 'semáforos'],
  [/flat-world-ground|terrain/, 'terrain', 'terreno'],
  [/water/, 'water', 'água'],
  [/utilities|signs|barriers|element/, 'props', 'placas, barreiras, postes e elementos'],
  [/forest|nature|cover|garden|plant/, 'vegetation', 'árvores, florestas e jardins'],
  [/exhaust/, 'particles', 'partículas'],
  [/rain|lightning/, 'weather', 'chuva e raios'],
  [/transit|train|metro/, 'transit', 'trens e metrô'],
  [/density/, 'farTraffic', 'trânsito distante'],
];
const PASS_SWITCH: Readonly<Record<string, string>> = {
  shadows: 'shadows', gtao: 'ambientOcclusion', canyon: 'canyonLight', bloom: 'bloom', clouds: 'clouds', smaa: 'smaa', output: 'sharpen',
};

export const layerSwitch = (layer: string): { key: string; label: string } | null => {
  const hit = LAYER_SWITCH.find(([re]) => re.test(layer));
  return hit ? { key: hit[1], label: hit[2] } : null;
};

const BUDGET_MS = 1000 / 60;
const fmtN = (n: number): string => n.toLocaleString('pt-BR', { maximumFractionDigits: n >= 100 ? 0 : 1 });
const big = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} M` : n >= 1e3 ? `${(n / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : fmtN(n));
const pct = (x: number): string => `${(x * 100).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%`;
const severityOf = (ms: number): Severity => (ms >= 4 ? 'alta' : ms >= 1.5 ? 'média' : ms >= 0.4 ? 'baixa' : 'info');
const isShadow = (d: Draw): boolean => /shadow|sombra|sun|cascade/i.test(`${d.target} ${d.pass}`);
const isQuad = (d: Draw): boolean => /^quad:/.test(d.layer) || d.triangles <= 2;

export interface Verdict { readonly bound: 'GPU' | 'CPU' | 'folga' | 'sem medida'; readonly text: string }

export function verdictOf(s: Snapshot): Verdict {
  const g = s.gpuMs, c = s.cpuMs;
  if (!Number.isFinite(c) && g === null) return { bound: 'sem medida', text: 'Nenhum quadro desenhado na medida: mova a câmera ou deixe a simulação rodar e meça de novo.' };
  const fr = Number.isFinite(s.frameMs) ? `${fmtN(s.frameMs)} ms por quadro (${fmtN(1000 / s.frameMs)} q/s)` : '';
  if (g !== null && g >= c && g > BUDGET_MS * 0.85) return { bound: 'GPU', text: `Limitado pela GPU: ela leva ${fmtN(g)} ms por quadro contra ${fmtN(c)} ms da CPU (orçamento ${fmtN(BUDGET_MS)} ms para 60 q/s). ${fr}. O que reduz o trabalho da GPU (abaixo, em ordem de peso) aumenta os quadros; mexer na CPU não.` };
  if (c > (g ?? 0) && c > BUDGET_MS * 0.85) return { bound: 'CPU', text: `Limitado pela CPU: a thread principal leva ${fmtN(c)} ms por quadro${g !== null ? ` contra ${fmtN(g)} ms da GPU` : ''}. ${fr}. O que reduz o trabalho da CPU (abaixo) aumenta os quadros.` };
  return { bound: 'folga', text: `Com folga: GPU ${g === null ? '—' : `${fmtN(g)} ms`}, CPU ${fmtN(c)} ms, dentro do orçamento de ${fmtN(BUDGET_MS)} ms. ${fr}.` };
}

/** Each layer's share of the frame's draws (the composer's own quads left out). */
export interface LayerShare { readonly layer: string; readonly triangles: number; readonly calls: number; readonly instances: number; readonly shadowTriangles: number; readonly heaviest: Draw | null; readonly programs: number }

export function layersOf(draws: readonly Draw[]): LayerShare[] {
  const rows = new Map<string, { triangles: number; calls: number; instances: number; shadowTriangles: number; heaviest: Draw | null; programs: Set<string> }>();
  for (const d of draws) {
    if (isQuad(d)) continue;
    const r = rows.get(d.layer) ?? { triangles: 0, calls: 0, instances: 0, shadowTriangles: 0, heaviest: null, programs: new Set<string>() };
    r.triangles += d.triangles;
    r.calls += d.calls;
    r.instances += d.instances;
    if (isShadow(d)) r.shadowTriangles += d.triangles;
    else if (!r.heaviest || d.triangles > r.heaviest.triangles) r.heaviest = d;
    r.programs.add(d.program);
    rows.set(d.layer, r);
  }
  return [...rows].map(([layer, r]) => ({ layer, triangles: r.triangles, calls: r.calls, instances: r.instances, shadowTriangles: r.shadowTriangles, heaviest: r.heaviest, programs: r.programs.size }))
    .sort((a, b) => b.triangles - a.triangles);
}

export function findingsOf(s: Snapshot): Finding[] {
  const out: Finding[] = [];
  const v = verdictOf(s);
  const gpuMs = s.gpuMs ?? 0;
  const layers = layersOf(s.draws);
  const totalTris = layers.reduce((a, l) => a + l.triangles, 0) || 1;
  const totalCalls = layers.reduce((a, l) => a + l.calls, 0) || 1;
  const scenePass = s.passes.find((p) => p.pass === 'scene');
  const shadowPass = s.passes.find((p) => p.pass === 'shadows');

  // The passes the GPU spends on.
  for (const p of s.passes) {
    if (p.avg < 0.3 || p.pass === 'scene') continue;
    const key = PASS_SWITCH[p.pass];
    out.push({
      id: `pass.${p.pass}`, area: 'GPU', severity: severityOf(p.avg), pass: p.pass, ms: p.avg,
      title: `Passe "${p.label}": ${fmtN(p.avg)} ms da GPU (${pct(p.share / 100)})`,
      evidence: [`média ${fmtN(p.avg)} ms, p95 ${fmtN(p.p95)} ms por quadro`, `${pct(p.avg / Math.max(gpuMs, 1e-6))} do tempo da GPU no quadro`],
      why: p.pass === 'shadows' ? 'Redesenhar os mapas de sombra desenha a cena de novo do ponto de vista do sol, uma vez por cascata.' : 'Um passe de pós-processamento roda sobre cada pixel da tela: custa com a resolução, não com a cena.',
      ...(key ? { test: { label: `desligar ${p.label}`, values: { [key]: false }, back: { [key]: true } } } : {}),
    });
  }
  // The scene pass: by layer.
  for (const l of layers) {
    const share = l.triangles / totalTris;
    const callShare = l.calls / totalCalls;
    if (share < 0.08 && callShare < 0.12) continue;
    const est = scenePass ? scenePass.avg * Math.max(share, callShare * 0.5) : gpuMs * share * 0.7;
    const sw = layerSwitch(l.layer);
    out.push({
      id: `layer.${l.layer}`, area: 'GPU', severity: severityOf(est), layer: l.layer, ms: est,
      ...(l.heaviest ? { object: l.heaviest.object } : {}),
      title: `${sw ? sw.label[0]!.toUpperCase() + sw.label.slice(1) : l.layer}: ${pct(share)} dos triângulos, ${pct(callShare)} dos desenhos`,
      evidence: [
        `camada ${l.layer}`,
        `${big(l.triangles)} triângulos em ${fmtN(l.calls)} desenhos, ${big(l.instances)} instâncias, ${l.programs} programas de shader`,
        ...(l.shadowTriangles ? [`${big(l.shadowTriangles)} desses triângulos são das sombras (desenhados de novo para cada cascata)`] : []),
        ...(l.heaviest ? [`objeto mais pesado: ${l.heaviest.name || '(sem nome)'} — ${big(l.heaviest.triangles)} triângulos, ${big(l.heaviest.instances)} instâncias, material ${l.heaviest.material}`] : []),
        `custo estimado ~${fmtN(est)} ms da GPU (parte do passe da cena pela parte dos triângulos e desenhos)`,
      ],
      why: share >= callShare ? 'Muitos triângulos: o processamento de vértices e a rasterização crescem com eles; LOD mais grosso ou menos instâncias reduzem.' : 'Muitas chamadas de desenho: cada uma custa troca de estado na GPU e trabalho na CPU; juntar malhas ou instanciar reduz.',
      ...(sw ? { test: { label: `ocultar ${sw.label}`, values: { [sw.key]: false }, back: { [sw.key]: true } } } : {}),
    });
  }
  // The shadows, drawn again per cascade.
  const shadowTris = layers.reduce((a, l) => a + l.shadowTriangles, 0);
  if (shadowTris / totalTris > 0.2 || (shadowPass && shadowPass.avg > 1)) {
    out.push({
      id: 'shadows.redraw', area: 'GPU', severity: severityOf(shadowPass?.avg ?? gpuMs * (shadowTris / totalTris) * 0.5), ms: shadowPass?.avg ?? gpuMs * (shadowTris / totalTris) * 0.5,
      title: `Sombras redesenham ${pct(shadowTris / totalTris)} dos triângulos do quadro`,
      evidence: [`${big(shadowTris)} triângulos nos mapas de sombra`, ...(shadowPass ? [`passe de sombras ${fmtN(shadowPass.avg)} ms`] : []), ...layers.filter((l) => l.shadowTriangles).slice(0, 3).map((l) => `${l.layer}: ${big(l.shadowTriangles)}`)],
      why: 'Cada objeto que projeta sombra é desenhado de novo para cada cascata do sol que o vê.',
      test: { label: 'prédios sem sombra', values: { bShadows: false }, back: { bShadows: true } },
    });
  }
  // Draw calls over the view's budget.
  if (s.drawCalls > 1000) {
    const top = [...layers].sort((a, b) => b.calls - a.calls).slice(0, 3);
    out.push({
      id: 'draws.many', area: 'GPU', severity: s.drawCalls > 1500 ? 'média' : 'baixa', ms: (s.drawCalls - 1000) * 0.004,
      title: `${fmtN(s.drawCalls)} chamadas de desenho por quadro (orçamento da vista: 1000)`,
      evidence: top.map((l) => `${l.layer}: ${fmtN(l.calls)} desenhos`),
      why: 'Cada chamada de desenho custa CPU (no thread principal e no driver) e troca de estado na GPU.',
    });
  }
  // The CPU.
  if (s.cpuMs > 6) {
    const [first] = s.systems;
    const systemsMs = s.systems.reduce((a, [, ms]) => a + ms, 0) || 1;
    out.push({
      id: 'cpu.frame', area: 'CPU', severity: severityOf(s.cpuMs - 6), ms: s.cpuMs,
      title: `A CPU leva ${fmtN(s.cpuMs)} ms por quadro${first ? `, ${pct(first[1] / systemsMs)} em "${first[0]}"` : ''}`,
      evidence: [
        ...s.systems.slice(0, 3).map(([k, ms]) => `sistema ${k}: ${fmtN(ms)} ms`),
        ...s.functions.slice(0, 5).map((f) => `função ${f.name || '(anônima)'} — ${f.where}: ${fmtN(f.selfMs)} ms próprios, ${fmtN(f.totalMs)} ms com o que chama`),
      ],
      why: 'O trabalho do quadro na thread principal: preparar a cena, escolher níveis, sincronizar pessoas e veículos, enviar à GPU. As funções listadas são onde a CPU mais ficou durante a medida (perfil por amostragem).',
      ...(s.functions[0] ? { where: s.functions[0].where } : {}),
    });
  }
  for (const f of s.functions.slice(0, 5)) {
    if (f.selfMs < 20) continue;
    out.push({
      id: `fn.${f.where}`, area: 'CPU', severity: 'baixa', ms: f.selfMs / Math.max(1, s.frames), where: f.where,
      title: `Função ${f.name || '(anônima)'} em ${f.where}`,
      evidence: [`${fmtN(f.selfMs)} ms próprios e ${fmtN(f.totalMs)} ms com o que chama, em ${fmtN(f.samples)} amostras`],
      why: 'Uma das funções do jogo em que a CPU mais ficou durante a medida (perfil por amostragem).',
    });
  }
  if (s.hitches > 0) {
    out.push({
      id: 'hitches', area: 'Engasgos', severity: s.hitches > 3 ? 'média' : 'baixa', ms: s.hitches,
      title: `${s.hitches} engasgos (quadros acima de 50 ms) na medida`,
      evidence: ['veja Consumo › LoAF e tarefas longas para o script culpado'],
      why: 'Um quadro longo é um tranco visível, mesmo com a média boa.',
    });
  }
  const vram = gpuLedger.bytes();
  if (Number.isFinite(gpuLedger.cap) && vram > gpuLedger.cap * 0.8) {
    out.push({
      id: 'vram', area: 'Memória', severity: 'média', ms: 0,
      title: `Memória de vídeo em ${pct(vram / gpuLedger.cap)} do teto`,
      evidence: [`${big(vram / 1048576)} MB de ${big(gpuLedger.cap / 1048576)} MB`],
      why: 'Perto do teto o jogo descarta detalhe dos prédios; acima dele o driver troca memória e engasga.',
    });
  }
  const rank: Record<Severity, number> = { alta: 0, 'média': 1, baixa: 2, info: 3 };
  out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.ms - a.ms);
  // The bottleneck's side first: GPU causes count only when the GPU sets the pace, CPU ones when the CPU does.
  if (v.bound === 'GPU' || v.bound === 'CPU') {
    const side = v.bound;
    out.sort((a, b) => Number(b.area === side) - Number(a.area === side));
  }
  return out;
}

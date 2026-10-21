import { gpuLedger } from '@render/gpuLedger';
import type { Draw, Snapshot } from './measure';

/** THE DIAGNOSIS'S FINDINGS: the snapshot read as causes - the bottleneck, the passes and layers the GPU spends on, the objects that weigh most, the shadows, the draw calls, the CPU's systems and functions, the hitches, the memory - each with its figures, why it matters, the switch that tests it and where to look. */

export type Severity = 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  readonly id: string;
  readonly area: 'GPU' | 'CPU' | 'Memory' | 'Hitches';
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
  [/building-part-cells/, 'bParts', 'building cell parts (windows, railings, awnings, objects)'],
  [/buildings-far-levels|buildings-far/, 'bMasses', 'distant building masses and levels'],
  [/buildings-layer \/ buildings$|buildings-layer$/, 'bDetail', 'detailed building cells (walls)'],
  [/facade/, 'bFacadeLevel', 'building facade level'],
  [/signature/, 'bSignatures', 'signature buildings'],
  [/flags/, 'bFlags', 'flags'],
  [/agent-parts|rigged-citizens|procedural-people/, 'people', 'people and vehicles'],
  [/road-network|road-stand-in|structure/, 'roads', 'roads, overpasses and markings'],
  [/street-furniture|grass/, 'furniture', 'street furniture and grass'],
  [/traffic-signals/, 'signals', 'traffic lights'],
  [/flat-world-ground|terrain/, 'terrain', 'terrain'],
  [/water/, 'water', 'water'],
  [/utilities|signs|barriers|element/, 'props', 'signs, barriers, poles and elements'],
  [/forest|nature|cover|garden|plant/, 'vegetation', 'trees, forests and gardens'],
  [/exhaust/, 'particles', 'particles'],
  [/rain|lightning/, 'weather', 'rain and lightning'],
  [/transit|train|metro/, 'transit', 'trains and metro'],
  [/density/, 'farTraffic', 'distant traffic'],
];
const PASS_SWITCH: Readonly<Record<string, string>> = {
  shadows: 'shadows', gtao: 'ambientOcclusion', canyon: 'canyonLight', bloom: 'bloom', clouds: 'clouds', smaa: 'smaa', output: 'sharpen',
};

export const layerSwitch = (layer: string): { key: string; label: string } | null => {
  const hit = LAYER_SWITCH.find(([re]) => re.test(layer));
  return hit ? { key: hit[1], label: hit[2] } : null;
};

const BUDGET_MS = 1000 / 60;
const fmtN = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : 1 });
const big = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })} M` : n >= 1e3 ? `${(n / 1e3).toLocaleString('en-US', { maximumFractionDigits: 1 })} k` : fmtN(n));
const pct = (x: number): string => `${(x * 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}%`;
const severityOf = (ms: number): Severity => (ms >= 4 ? 'high' : ms >= 1.5 ? 'medium' : ms >= 0.4 ? 'low' : 'info');
const isShadow = (d: Draw): boolean => /shadow|sun|cascade/i.test(`${d.target} ${d.pass}`);
const isQuad = (d: Draw): boolean => /^quad:/.test(d.layer) || d.triangles <= 2;

export interface Verdict { readonly bound: 'GPU' | 'CPU' | 'headroom' | 'no measure'; readonly text: string }

export function verdictOf(s: Snapshot): Verdict {
  const g = s.gpuMs, c = s.cpuMs;
  if (!Number.isFinite(c) && g === null) return { bound: 'no measure', text: 'No frame drawn during the measure: move the camera or let the simulation run and measure again.' };
  const fr = Number.isFinite(s.frameMs) ? `${fmtN(s.frameMs)} ms per frame (${fmtN(1000 / s.frameMs)} fps)` : '';
  if (g !== null && g >= c && g > BUDGET_MS * 0.85) return { bound: 'GPU', text: `GPU-bound: it takes ${fmtN(g)} ms per frame against ${fmtN(c)} ms for the CPU (budget ${fmtN(BUDGET_MS)} ms for 60 fps). ${fr}. What cuts the GPU's work (below, by weight) raises the frame rate; touching the CPU does not.` };
  if (c > (g ?? 0) && c > BUDGET_MS * 0.85) return { bound: 'CPU', text: `CPU-bound: the main thread takes ${fmtN(c)} ms per frame${g !== null ? ` against ${fmtN(g)} ms for the GPU` : ''}. ${fr}. What cuts the CPU's work (below) raises the frame rate.` };
  return { bound: 'headroom', text: `Headroom: GPU ${g === null ? '—' : `${fmtN(g)} ms`}, CPU ${fmtN(c)} ms, within the ${fmtN(BUDGET_MS)} ms budget. ${fr}.` };
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
      title: `Pass "${p.label}": ${fmtN(p.avg)} ms of GPU (${pct(p.share / 100)})`,
      evidence: [`mean ${fmtN(p.avg)} ms, p95 ${fmtN(p.p95)} ms per frame`, `${pct(p.avg / Math.max(gpuMs, 1e-6))} of the frame's GPU time`],
      why: p.pass === 'shadows' ? 'Redrawing the shadow maps draws the scene again from the sun\'s point of view, once per cascade.' : 'A post-processing pass runs over every pixel of the screen: it costs with the resolution, not with the scene.',
      ...(key ? { test: { label: `turn off ${p.label}`, values: { [key]: false }, back: { [key]: true } } } : {}),
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
      title: `${sw ? sw.label[0]!.toUpperCase() + sw.label.slice(1) : l.layer}: ${pct(share)} of triangles, ${pct(callShare)} of draws`,
      evidence: [
        `layer ${l.layer}`,
        `${big(l.triangles)} triangles in ${fmtN(l.calls)} draws, ${big(l.instances)} instances, ${l.programs} shader programs`,
        ...(l.shadowTriangles ? [`${big(l.shadowTriangles)} of these triangles are shadows (drawn again for each cascade)`] : []),
        ...(l.heaviest ? [`heaviest object: ${l.heaviest.name || '(unnamed)'} — ${big(l.heaviest.triangles)} triangles, ${big(l.heaviest.instances)} instances, material ${l.heaviest.material}`] : []),
        `estimated cost ~${fmtN(est)} ms of GPU (the scene pass's share by the share of triangles and draws)`,
      ],
      why: share >= callShare ? 'Many triangles: vertex processing and rasterization grow with them; a coarser LOD or fewer instances cut them.' : 'Many draw calls: each costs a GPU state change and CPU work; merging meshes or instancing cuts them.',
      ...(sw ? { test: { label: `hide ${sw.label}`, values: { [sw.key]: false }, back: { [sw.key]: true } } } : {}),
    });
  }
  // The shadows, drawn again per cascade.
  const shadowTris = layers.reduce((a, l) => a + l.shadowTriangles, 0);
  if (shadowTris / totalTris > 0.2 || (shadowPass && shadowPass.avg > 1)) {
    out.push({
      id: 'shadows.redraw', area: 'GPU', severity: severityOf(shadowPass?.avg ?? gpuMs * (shadowTris / totalTris) * 0.5), ms: shadowPass?.avg ?? gpuMs * (shadowTris / totalTris) * 0.5,
      title: `Shadows redraw ${pct(shadowTris / totalTris)} of the frame's triangles`,
      evidence: [`${big(shadowTris)} triangles in the shadow maps`, ...(shadowPass ? [`shadow pass ${fmtN(shadowPass.avg)} ms`] : []), ...layers.filter((l) => l.shadowTriangles).slice(0, 3).map((l) => `${l.layer}: ${big(l.shadowTriangles)}`)],
      why: 'Every shadow-casting object is drawn again for each sun cascade that sees it.',
      test: { label: 'buildings without shadows', values: { bShadows: false }, back: { bShadows: true } },
    });
  }
  // Draw calls over the view's budget.
  if (s.drawCalls > 1000) {
    const top = [...layers].sort((a, b) => b.calls - a.calls).slice(0, 3);
    out.push({
      id: 'draws.many', area: 'GPU', severity: s.drawCalls > 1500 ? 'medium' : 'low', ms: (s.drawCalls - 1000) * 0.004,
      title: `${fmtN(s.drawCalls)} draw calls per frame (view budget: 1000)`,
      evidence: top.map((l) => `${l.layer}: ${fmtN(l.calls)} draws`),
      why: 'Every draw call costs CPU (on the main thread and in the driver) and a GPU state change.',
    });
  }
  // The CPU.
  if (s.cpuMs > 6) {
    const [first] = s.systems;
    const systemsMs = s.systems.reduce((a, [, ms]) => a + ms, 0) || 1;
    out.push({
      id: 'cpu.frame', area: 'CPU', severity: severityOf(s.cpuMs - 6), ms: s.cpuMs,
      title: `The CPU takes ${fmtN(s.cpuMs)} ms per frame${first ? `, ${pct(first[1] / systemsMs)} in "${first[0]}"` : ''}`,
      evidence: [
        ...s.systems.slice(0, 3).map(([k, ms]) => `system ${k}: ${fmtN(ms)} ms`),
        ...s.functions.slice(0, 5).map((f) => `function ${f.name || '(anonymous)'} — ${f.where}: ${fmtN(f.selfMs)} ms self, ${fmtN(f.totalMs)} ms with its callees`),
      ],
      why: 'The frame\'s work on the main thread: preparing the scene, choosing levels, syncing people and vehicles, submitting to the GPU. The functions listed are where the CPU spent most time during the measure (sampling profile).',
      ...(s.functions[0] ? { where: s.functions[0].where } : {}),
    });
  }
  for (const f of s.functions.slice(0, 5)) {
    if (f.selfMs < 20) continue;
    out.push({
      id: `fn.${f.where}`, area: 'CPU', severity: 'low', ms: f.selfMs / Math.max(1, s.frames), where: f.where,
      title: `Function ${f.name || '(anonymous)'} in ${f.where}`,
      evidence: [`${fmtN(f.selfMs)} ms self and ${fmtN(f.totalMs)} ms with its callees, in ${fmtN(f.samples)} samples`],
      why: 'One of the game\'s functions where the CPU spent most time during the measure (sampling profile).',
    });
  }
  if (s.hitches > 0) {
    out.push({
      id: 'hitches', area: 'Hitches', severity: s.hitches > 3 ? 'medium' : 'low', ms: s.hitches,
      title: `${s.hitches} hitches (frames over 50 ms) in the measure`,
      evidence: ['see Usage › LoAF and long tasks for the script to blame'],
      why: 'A long frame is a visible stutter, even with a good average.',
    });
  }
  const vram = gpuLedger.bytes();
  if (Number.isFinite(gpuLedger.cap) && vram > gpuLedger.cap * 0.8) {
    out.push({
      id: 'vram', area: 'Memory', severity: 'medium', ms: 0,
      title: `Video memory at ${pct(vram / gpuLedger.cap)} of the cap`,
      evidence: [`${big(vram / 1048576)} MB of ${big(gpuLedger.cap / 1048576)} MB`],
      why: 'Near the cap the game drops building detail; above it the driver swaps memory and hitches.',
    });
  }
  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };
  out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.ms - a.ms);
  // The bottleneck's side first: GPU causes count only when the GPU sets the pace, CPU ones when the CPU does.
  if (v.bound === 'GPU' || v.bound === 'CPU') {
    const side = v.bound;
    out.sort((a, b) => Number(b.area === side) - Number(a.area === side));
  }
  return out;
}

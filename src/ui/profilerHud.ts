import { type Profiler, type ProfilerView } from '@core/profiler';

/**
 * The profiler's HUD (`core/profiler.ts`): shown when the game starts,
 * Shift+F9 hides and shows it. Redrawn four times a second from the last
 * closed window of a second - DO NOT redraw it every frame: writing the DOM
 * at 60 Hz is a cost of its own, measured by the profiler it shows.
 *
 * Diagnostic text for the developer, not the player's interface: not in
 * the dictionaries.
 */
export function mountProfilerHud(profiler: Profiler, options: { readonly visible?: boolean } = {}): { toggle(): void } {
  const box = document.createElement('div');
  box.className = 'profiler-hud';
  box.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:9999;max-width:560px;max-height:calc(100vh - 16px);overflow:auto;'
    + 'background:rgba(8,12,14,.86);color:#d8e4e8;font:11px/1.35 ui-monospace,Consolas,monospace;padding:8px 10px;border-radius:8px;'
    + 'white-space:pre-wrap;pointer-events:none;box-shadow:0 2px 10px rgba(0,0,0,.4)';
  const text = document.createElement('div');
  const copy = document.createElement('button');
  copy.textContent = 'copiar snapshot JSON';
  copy.style.cssText = 'pointer-events:auto;margin-top:6px;font:11px ui-monospace,Consolas,monospace;background:#1d2c33;color:#d8e4e8;border:1px solid #3b5560;border-radius:4px;padding:2px 8px;cursor:pointer';
  copy.addEventListener('click', () => {
    const json = JSON.stringify(profiler.view(), null, 1);
    void navigator.clipboard?.writeText(json).then(() => { copy.textContent = 'copiado'; setTimeout(() => { copy.textContent = 'copiar snapshot JSON'; }, 1200); },
      () => { console.log(json); copy.textContent = 'no console (sem área de transferência)'; });
  });
  box.append(text, copy);
  document.body.appendChild(box);
  let visible = options.visible ?? true;
  box.style.display = visible ? 'block' : 'none';
  profiler.enabled = visible;

  const toggle = (): void => {
    visible = !visible;
    box.style.display = visible ? 'block' : 'none';
    profiler.enabled = visible;
  };
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F9' && e.shiftKey) { e.preventDefault(); e.stopPropagation(); toggle(); }
  }, { capture: true });

  setInterval(() => {
    if (!visible) return;
    const v = profiler.closed;
    if (v) text.innerHTML = render(v);
  }, 250);
  return { toggle };
}

const esc = (s: string): string => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
const red = (s: string): string => `<span style="color:#ff6b6b;font-weight:700">${s}</span>`;
const amber = (s: string): string => `<span style="color:#ffc857">${s}</span>`;
const head = (s: string): string => `<span style="color:#7fd1ff;font-weight:700">${s}</span>`;

function render(v: ProfilerView): string {
  const out: string[] = [];
  const e = (name: string) => v.events[name];
  const n = (name: string): number => e(name)?.perSecond ?? 0;
  const peak = (name: string): number => e(name)?.peakPerFrame ?? 0;
  const g = v.gauges;
  out.push(`${head('PROFILER')}  ${v.fps} fps · quadro p50 ${v.frameP50} ms · pior ${v.frameMax > 50 ? red(`${v.frameMax} ms`) : `${v.frameMax} ms`}`
    + `${g.drawCalls !== undefined ? ` · ${g.drawCalls} chamadas` : ''}${g.gpuGeometries !== undefined ? ` · GPU ${g.gpuGeometries} geom / ${g.gpuTextures} tex` : ''}`);

  // Where the time goes: the frame's systems and the code's measured steps, ms per second.
  if (v.steps.length) {
    out.push('', head('0. ONDE VAI O TEMPO') + '  ms por segundo (1000 = a thread inteira):');
    for (const [name, ms] of v.steps.slice(0, 8)) out.push(`  ${(ms > 300 ? red : ms > 100 ? amber : String)(ms.toFixed(0).padStart(6))}  ${esc(name)}`);
  }

  // 1. Disposes.
  const disposes = n('dispose.geometry') + n('dispose.material') + n('dispose.texture') + n('dispose.target');
  const disposePeak = Math.max(peak('dispose.geometry'), peak('dispose.material'), peak('dispose.texture'));
  out.push('', head('1. DISPOSES') + `  no último segundo: ${disposes ? red(String(disposes)) : '0'} (pico ${disposePeak}/quadro) — geom ${n('dispose.geometry')} · mat ${n('dispose.material')} · tex ${n('dispose.texture')} · alvo ${n('dispose.target')}`);
  const disposeSites = merge(['dispose.geometry', 'dispose.material', 'dispose.texture', 'dispose.target'].map((k) => e(k)?.sites ?? []));
  for (const [site, c] of disposeSites.slice(0, 5)) out.push(`  ${amber(String(c).padStart(6))}  ${esc(site)}`);
  const last = ['dispose.geometry', 'dispose.material', 'dispose.texture'].map((k) => e(k)?.last).filter((l) => l).sort((a, b) => b!.at - a!.at)[0];
  if (last) out.push(`  último: ${esc(last.site)}`, ...last.stack.split('\n').slice(1, 5).map((l) => `    ← ${esc(l)}`));

  // 2. Rebuilds: geometries built, bytes sent, and what changed.
  out.push('', head('2. RECONSTRUÇÕES') + `  geometrias feitas: ${n('build.geometry') ? red(String(n('build.geometry'))) : '0'}/s (pico ${peak('build.geometry')}/quadro)`
    + ` · envio GPU ${e('upload.buffer')?.mbPerSecond ?? 0} MB/s buffers, ${e('upload.texture')?.mbPerSecond ?? 0} MB/s texturas`);
  for (const [site, c] of (e('build.geometry')?.sites ?? []).slice(0, 5)) out.push(`  ${amber(String(c).padStart(6))}  ${esc(site)}`);
  if (v.changes.length) {
    out.push('  disparado por (diário: tipo ← causa, itens):');
    for (const [what, c] of v.changes.slice(0, 5)) out.push(`  ${String(c).padStart(6)}  ${esc(what)}`);
  }

  // 3. The engine's ledger.
  out.push('', head('3. MOTOR (core/engine.ts)') + '  último refresh, por tempo:');
  for (const p of v.products.slice(0, 10)) {
    const line = `  ${p.ms.toFixed(2).padStart(7)} ms  ${String(p.keys).padStart(5)} chaves  ${p.phase.padEnd(5)} ${esc(p.name)}`;
    out.push(p.idle ? red(`${line}  ← CALCULOU SEM MUDANÇA`) : line);
  }
  if (v.idleProducts.length) out.push(red(`  calcularam sem mudança no diário: ${v.idleProducts.map(([k, c]) => `${k} ×${c}`).join(', ')}`));

  // 4. Memory.
  out.push('', head('4. MEMÓRIA') + (v.heapMB === null ? '  performance.memory indisponível'
    : `  heap ${v.heapMB} MB · ${v.heapRate > 20 ? red(`${v.heapRate > 0 ? '+' : ''}${v.heapRate} MB/s`) : `${v.heapRate > 0 ? '+' : ''}${v.heapRate} MB/s`}${v.gcDropMB > 1 ? ` · coleta −${v.gcDropMB} MB` : ''}`));
  if (v.longTasks.length) out.push(`  tarefas longas: ${v.longTasks.slice(0, 6).map((l) => (l.ms > 200 ? red(`${l.ms} ms`) : `${l.ms} ms`) + ` (${l.agoS}s)`).join(' · ')}`);
  out.push('', 'Shift+F9 esconde · __roadcraft.profiler() no console');
  return out.join('\n');
}

function merge(lists: readonly (readonly [string, number][])[]): [string, number][] {
  const sum = new Map<string, number>();
  for (const list of lists) for (const [k, c] of list) sum.set(k, (sum.get(k) ?? 0) + c);
  return [...sum].sort((a, b) => b[1] - a[1]);
}

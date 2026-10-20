import { integratedGpu } from '@render/gpuLedger';
import { jobPoolStats } from '@/jobs/jobPool';
import { createLabTable } from '../table';
import type { LabContext, LabTab } from '../labTypes';
import type { Collector, GlPoint } from './collector';
import { slope } from './meter';
import { summarize } from './overview';

/** THE LAB'S DIAGNOSTICS ("Diagnóstico"): the machine, the browser and the game's resources checked one by one, each with its verdict (ok, aviso, problema), what it read and why it matters, and the tab where to look further */

export type Verdict = 'ok' | 'aviso' | 'problema' | 'info';

export interface Check {
  readonly id: string;
  readonly title: string;
  readonly verdict: Verdict;
  readonly value: string;
  readonly why: string;
  /** The title of the lab's tab to look at next (clicked: shown). */
  readonly tab: string;
  /** What that tab is asked to show (`LabTab.focus`): the consumers' category, a filter. */
  readonly focus?: Readonly<Record<string, string>>;
}

/** The lab's tabs the checks lead to, by title. */
const TAB_IDS: Readonly<Record<string, string>> = { 'Visão geral': 'overview', Consumo: 'consumers', Interruptores: 'switches' };

const RANK: Readonly<Record<Verdict, number>> = { problema: 3, aviso: 2, info: 1, ok: 0 };

/** A GPU named by software (no hardware drawing): every frame on the CPU. */
const SOFTWARE = /SwiftShader|llvmpipe|Software|Microsoft Basic Render/i;

/** A count of the GPU's objects (`renderer.info`) growing over the readings of the last `ms` while the world stood: the slope a minute and the rise. */
function growth(points: readonly GlPoint[], pick: (p: GlPoint) => number | null, ms: number): { perMin: number; rise: number } {
  const now = performance.now();
  const within = points.filter((p) => p.t >= now - ms && pick(p) !== null);
  const pts = within.map((p): [number, number] => [p.t / 60_000, pick(p)!]);
  return { perMin: slope(pts), rise: pts.length ? pts[pts.length - 1]![1] - pts[0]![1] : 0 };
}

/** Every check, now (the storage, the battery and the user agent's memory as last read: `collector.platform`). */
export function runChecks(ctx: LabContext, collector: Collector): Check[] {
  const out: Check[] = [];
  const add = (c: Check): void => { out.push(c); };
  const gl = ctx.scene.gl;
  const raw = gl.getContext() as WebGL2RenderingContext;

  // Cross-origin isolation: SharedArrayBuffer and the user agent's memory need it (MDN crossOriginIsolated).
  add({
    id: 'coi', title: 'Isolamento de origem (crossOriginIsolated)', tab: 'Consumo', focus: { category: 'RAM' },
    verdict: globalThis.crossOriginIsolated ? 'ok' : 'problema',
    value: String(globalThis.crossOriginIsolated),
    why: globalThis.crossOriginIsolated ? 'SharedArrayBuffer e measureUserAgentSpecificMemory disponíveis' : 'sem COOP/COEP: sem SharedArrayBuffer (memória partilhada dos workers) nem medida de memória do agente',
  });

  // The GPU and the tier.
  const label = ctx.scene.gpu.label;
  const software = SOFTWARE.test(label);
  add({
    id: 'gpu', title: 'GPU e nível de qualidade', tab: 'Visão geral',
    verdict: software ? 'problema' : 'ok',
    value: `${label} · ${integratedGpu(label) ? 'integrada' : 'dedicada/desconhecida'} · qualidade ${ctx.scene.stats.quality}`,
    why: software ? 'renderizador por software: todo quadro desenhado pela CPU, tempos sem valor' : 'GPU de hardware; o nível de qualidade é o escolhido no menu gráfico',
  });

  // The context alive.
  add({
    id: 'context', title: 'Contexto WebGL', tab: 'Visão geral',
    verdict: raw.isContextLost() ? 'problema' : 'ok',
    value: `${raw.isContextLost() ? 'PERDIDO' : 'vivo'} · ${raw.getParameter(raw.VERSION) as string}`,
    why: 'um contexto perdido apaga todo recurso da GPU até ser restaurado',
  });

  // The limits that matter to the game's targets and arrays.
  const p = (name: number): number => Number(raw.getParameter(name));
  const maxTex = p(raw.MAX_TEXTURE_SIZE), maxSamples = p(raw.MAX_SAMPLES), layers = p(raw.MAX_ARRAY_TEXTURE_LAYERS), units = p(raw.MAX_COMBINED_TEXTURE_IMAGE_UNITS), ubo = p(raw.MAX_UNIFORM_BLOCK_SIZE), draws = p(raw.MAX_DRAW_BUFFERS), rb = p(raw.MAX_RENDERBUFFER_SIZE);
  const aniso = raw.getExtension('EXT_texture_filter_anisotropic') as { MAX_TEXTURE_MAX_ANISOTROPY_EXT: number } | null;
  const small = maxTex < 8192 || maxSamples < 4 || layers < 256;
  add({
    id: 'limits', title: 'Limites WebGL relevantes', tab: 'Visão geral',
    verdict: small ? 'aviso' : 'ok',
    value: `textura ${maxTex} · renderbuffer ${rb} · MSAA ${maxSamples} · camadas ${layers} · unidades ${units} · UBO ${(ubo / 1024).toFixed(0)} KB · draw buffers ${draws} · anisotropia ${aniso ? raw.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number : 'não'}`,
    why: small ? 'limites abaixo do esperado em desktop (textura 8192, MSAA 4, 256 camadas): qualidade alta pode falhar' : 'limites de desktop: os alvos e as texturas em array cabem',
  });

  // The GPU timer.
  const gpu = ctx.scene.gpu;
  add({
    id: 'timer', title: 'Medidor de tempo da GPU', tab: 'Visão geral',
    verdict: gpu.supported ? (gpu.disjoint > 10 ? 'aviso' : 'ok') : 'aviso',
    value: gpu.supported ? `EXT_disjoint_timer_query_webgl2 · ${gpu.samples.pushed} quadros medidos · ${gpu.skipped} pulados · ${gpu.disjoint} descartados${gpu.paused ? ' · PAUSADO' : ''}` : 'ausente',
    why: gpu.supported ? 'tempos de GPU reais por quadro; descartes vêm de mudança de clock ou perda de contexto' : 'sem a extensão (desligada no Chrome por padrão fora de desktop): sem tempo de GPU, veredito só pela CPU',
  });

  // The pixel ratio drawn against the screen's.
  const drawn = gl.getPixelRatio(), screen = window.devicePixelRatio;
  add({
    id: 'dpr', title: 'Pixel ratio desenhado × da tela', tab: 'Interruptores',
    verdict: drawn < screen * 0.99 ? 'info' : drawn > screen * 1.01 ? 'aviso' : 'ok',
    value: `${drawn.toFixed(2)} desenhado · ${screen.toFixed(2)} da tela · buffer ${gl.domElement.width}×${gl.domElement.height}`,
    why: drawn < screen * 0.99 ? 'desenhando abaixo da tela (resolução reduzida ou dinâmica): menos pixels, imagem mais suave' : drawn > screen * 1.01 ? 'desenhando acima da tela: pixels pagos e não vistos' : 'um pixel desenhado por pixel da tela',
  });

  // The pace: vsync or a cap, as the frames show it.
  const s = summarize(ctx, collector, 30_000);
  const hz = s.interval.p50 ? 1000 / s.interval.p50 : null;
  add({
    id: 'vsync', title: 'Ritmo dos quadros (vsync / limite)', tab: 'Visão geral',
    verdict: ctx.effects.onDemand ? 'info' : hz !== null && hz < 50 ? 'aviso' : 'ok',
    value: ctx.effects.onDemand ? `sob demanda · ${s.frames} quadros em 30 s` : hz === null ? 'sem quadros' : `~${hz.toFixed(0)} Hz (intervalo mediano ${s.interval.p50!.toFixed(1)} ms) · ${s.bound}`,
    why: ctx.effects.onDemand ? 'o jogo desenha só quando algo muda: intervalo não mede capacidade (desligue "sob demanda" para medir)' : 'requestAnimationFrame segue o vsync da tela; abaixo de 50 Hz contínuo o jogo não acompanha',
  });

  // A hidden page: rAF stops, timers are throttled (Chrome 88: checked once a second while hidden, chained ones once a minute after 5 min hidden and silent).
  const hiddenNow = document.hidden;
  const hides = collector.visibility.filter((v) => v.hidden).length;
  add({
    id: 'visibility', title: 'Visibilidade da página / estrangulamento em segundo plano', tab: 'Consumo', focus: { category: '' },
    verdict: hiddenNow ? 'aviso' : hides > 0 ? 'info' : 'ok',
    value: `${document.visibilityState} · ocultada ${hides}× desde que o laboratório começou`,
    why: hiddenNow ? 'oculta: requestAnimationFrame parado e temporizadores estrangulados (1×/s; 1×/min após 5 min oculta): medidas paradas ou falsas' : hides ? 'houve trechos ocultos: medidas da sessão incluem quadros parados' : 'visível o tempo todo',
  });

  // Shader programs growing: compiles after the opening (each a hitch).
  const prog = growth(collector.glPoints, (p) => p.programs, 60_000);
  const progNow = collector.glPoints[collector.glPoints.length - 1]?.programs ?? 0;
  add({
    id: 'programs', title: 'Programas de shader (recompilações)', tab: 'Consumo', focus: { category: 'GPU', filter: 'programas' },
    verdict: prog.rise > 5 ? 'aviso' : 'ok',
    value: `${progNow} programas · +${prog.rise} no último minuto`,
    why: prog.rise > 5 ? 'programas novos sendo compilados durante o jogo: cada compilação é um engasgo (material com variantes, defines mudando)' : 'número de programas estável',
  });

  // Geometries and textures growing: a leak (made, never disposed).
  const geo = growth(collector.glPoints, (p) => p.geometries, 120_000);
  const tex = growth(collector.glPoints, (p) => p.textures, 120_000);
  const last = collector.glPoints[collector.glPoints.length - 1];
  const leaking = (geo.perMin > 50 && geo.rise > 100) || (tex.perMin > 10 && tex.rise > 20);
  add({
    id: 'objects', title: 'Geometrias e texturas vivas (vazamento)', tab: 'Consumo', focus: { category: 'VRAM' },
    verdict: leaking ? 'aviso' : 'ok',
    value: `${last?.geometries ?? '?'} geometrias (${geo.perMin >= 0 ? '+' : ''}${geo.perMin.toFixed(0)}/min) · ${last?.textures ?? '?'} texturas (${tex.perMin >= 0 ? '+' : ''}${tex.perMin.toFixed(1)}/min) em 2 min`,
    why: leaking ? 'crescendo sem parar: algo cria sem dispose (com a câmera parada deveria estabilizar; ao andar o streaming sobe e desce)' : 'contagem estável',
  });

  // The heap's slope.
  const heap = growth(collector.glPoints, (p) => p.heap, 180_000);
  add({
    id: 'heap', title: 'Crescimento do heap JS', tab: 'Visão geral',
    verdict: heap.perMin > 120 ? 'problema' : heap.perMin > 30 ? 'aviso' : 'ok',
    value: `${last?.heap?.toFixed(0) ?? '?'} MB · ${heap.perMin >= 0 ? '+' : ''}${heap.perMin.toFixed(1)} MB/min em 3 min`,
    why: heap.perMin > 30 ? 'heap subindo de forma contínua: vazamento ou cache sem limite (compare antes/depois de uma coleta)' : 'heap estável entre coletas',
  });

  // Long tasks a minute.
  const now = performance.now();
  const tasks = collector.longTasks.filter((t) => t >= now - 60_000).length;
  const loafs = collector.longFrames.filter((l) => l.t >= now - 60_000).length;
  add({
    id: 'longtasks', title: 'Tarefas longas e LoAF por minuto', tab: 'Consumo', focus: { category: 'CPU-main', filter: 'LoAF' },
    verdict: tasks + loafs > 30 ? 'problema' : tasks + loafs > 5 ? 'aviso' : 'ok',
    value: `${tasks} tarefas longas · ${loafs} quadros longos no último minuto`,
    why: 'cada uma bloqueia a entrada por mais de 50 ms (W3C Long Tasks / LoAF): veja os scripts atribuídos em Consumo',
  });

  // The pool saturated: every worker busy with jobs waiting.
  const pool = jobPoolStats();
  const busy = pool.workers.filter((w) => w.running !== null || w.laneWork > 0).length;
  const waitMeter = collector.book.get('pool.waiting')?.read('30s', now);
  const saturated = pool.workers.length >= pool.most && busy === pool.workers.length && pool.waiting > 0;
  add({
    id: 'workers', title: 'Workers do pool saturados', tab: 'Consumo', focus: { category: 'CPU-worker' },
    verdict: saturated && (waitMeter?.avg ?? 0) > 5 ? 'aviso' : pool.workers.some((w) => w.failed) ? 'problema' : 'ok',
    value: `${busy}/${pool.workers.length} ocupados (máx. ${pool.most}) · ${pool.waiting} na fila (média 30 s ${(waitMeter?.avg ?? 0).toFixed(1)}) · ${pool.workers.filter((w) => w.failed).length} falhos · ${navigator.hardwareConcurrency} núcleos`,
    why: saturated ? 'todos os workers ocupados e fila crescendo: o trabalho fora da página espera (tiles, níveis distantes atrasam)' : 'há folga no pool',
  });

  // Storage quota.
  const st = collector.platform.storage;
  const share = st && st.quota ? st.usage / st.quota : null;
  add({
    id: 'storage', title: 'Cota de armazenamento', tab: 'Consumo', focus: { category: 'Disco' },
    verdict: share === null ? 'info' : share > 0.8 ? 'problema' : share > 0.5 ? 'aviso' : st?.persisted === false ? 'info' : 'ok',
    value: st ? `${(st.usage / 1048576).toFixed(1)} MB de ${(st.quota / 1048576).toFixed(0)} MB (${((share ?? 0) * 100).toFixed(1)}%) · ${st.persisted ? 'persistente' : 'não persistente'}` : 'ainda não lido',
    why: share !== null && share > 0.5 ? 'perto da cota: gravações (salvamentos, cache de derivados) podem falhar com QuotaExceededError' : st?.persisted === false ? 'armazenamento "best-effort": o navegador pode despejar sob pressão de disco (StorageManager.persist())' : 'folga de armazenamento',
  });

  // Video memory against the ledger's cap.
  const ledger = collector.book.get('vram.ledger')?.read('5s', now);
  add({
    id: 'vram', title: 'Memória de vídeo × teto do livro', tab: 'Consumo', focus: { category: 'VRAM' },
    verdict: 'info',
    value: `${ledger?.last?.toFixed(0) ?? '?'} MB · ${ledger?.note ?? ''}`,
    why: 'o teto é estimado (WebGL não expõe a VRAM): o livro (gpuLedger) recusa detalhe acima dele',
  });

  // The machine.
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  add({
    id: 'machine', title: 'Máquina (núcleos, memória)', tab: 'Visão geral',
    verdict: navigator.hardwareConcurrency < 4 ? 'aviso' : 'ok',
    value: `${navigator.hardwareConcurrency} núcleos lógicos · deviceMemory ${memory ?? '?'} GB (o navegador limita a 8)`,
    why: navigator.hardwareConcurrency < 4 ? 'poucos núcleos: o pool de jobs fica com 1-2 workers' : 'núcleos suficientes para o pool',
  });

  // The battery (no web API tells the OS's energy saver: only charging and level, MDN getBattery).
  const bat = collector.platform.battery;
  add({
    id: 'battery', title: 'Bateria / economia de energia', tab: 'Visão geral',
    verdict: bat && !bat.charging ? 'aviso' : 'info',
    value: bat ? `${bat.charging ? 'carregando' : 'na bateria'} · ${(bat.level * 100).toFixed(0)}%` : 'API indisponível',
    why: bat && !bat.charging ? 'na bateria o sistema e o navegador podem reduzir clock da CPU/GPU e limitar quadros (economia de energia não é exposta à página)' : 'nenhuma API web expõe o modo de economia do sistema; só carga e nível',
  });

  // The user agent's memory, workers included.
  const ua = collector.platform.uaMemory;
  add({
    id: 'uamemory', title: 'Memória do agente (página + workers)', tab: 'Consumo', focus: { category: 'RAM', filter: 'memória' },
    verdict: ua ? (ua.bytes > 3 * 2 ** 30 ? 'problema' : ua.bytes > 2 * 2 ** 30 ? 'aviso' : 'ok') : 'info',
    value: ua ? `${(ua.bytes / 1048576).toFixed(0)} MB · ${ua.breakdown.length} partes · há ${((now - ua.at) / 1000).toFixed(0)} s` : collector.platform.uaMemoryError ?? (collector.platform.uaMemoryRunning ? 'medindo…' : 'ainda não medida'),
    why: 'a página e seus workers partilham uma gaiola V8 de 4 GB (jobPool.ts): acima de 3 GB o Chrome pode matar a página',
  });

  return out.sort((a, b) => RANK[b.verdict] - RANK[a.verdict]);
}

export function createDiagnosticsTab(ctx: LabContext, collector: Collector): LabTab {
  let checks: Check[] = [];
  let summaryEl: HTMLElement | null = null;
  const table = createLabTable<Check>({
    columns: [
      { key: 'verdict', label: 'Veredito', value: (c) => c.verdict },
      { key: 'rank', label: '!', value: (c) => RANK[c.verdict], title: 'gravidade (3 problema, 2 aviso, 1 info, 0 ok)' },
      { key: 'title', label: 'Verificação', value: (c) => c.title },
      { key: 'value', label: 'Leitura', value: (c) => c.value },
      { key: 'why', label: 'Explicação', value: (c) => c.why },
      { key: 'tab', label: 'Ver em', value: (c) => `→ ${c.tab}`, title: 'clique na linha para abrir a aba' },
    ],
    rows: () => checks,
    sort: { key: 'rank', desc: true },
    categoryKey: 'verdict',
    onRow: (c) => ctx.navigate(TAB_IDS[c.tab] ?? 'overview', c.focus ?? {}),
  });
  let ranAt = -Infinity;
  /** The checks read WebGL's parameters and walk the readings: once a second is enough. */
  const run = (force = false): void => {
    const now = performance.now();
    if (!force && now - ranAt < 1000) return;
    ranAt = now;
    checks = runChecks(ctx, collector);
  };

  const mount = (host: HTMLElement): void => {
    const bar = document.createElement('div');
    bar.className = 'lab-row';
    const again = document.createElement('button');
    again.type = 'button';
    again.textContent = 'Ler armazenamento e memória de novo';
    again.onclick = () => { void Promise.all([collector.readStorage(), collector.measureMemory()]).then(() => { run(true); refresh(); }); };
    summaryEl = document.createElement('span');
    summaryEl.className = 'lab-muted';
    bar.append(again, summaryEl);
    host.append(bar, table.element);
    run(true);
    refresh();
  };

  function refresh(): void {
    run();
    table.refresh();
    if (summaryEl) {
      const count = (v: Verdict): number => checks.filter((c) => c.verdict === v).length;
      summaryEl.textContent = `${count('problema')} problemas · ${count('aviso')} avisos · ${count('ok')} ok · ${count('info')} informativos · linhas da tabela levam à aba indicada`;
    }
  }

  return { id: 'diagnostics', title: 'Verificações', mount, refresh, unmount: () => { summaryEl = null; } };
}

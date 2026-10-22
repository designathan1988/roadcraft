import { icon } from '../icons';
import type { LabContext, LabTab } from '../labTypes';
import { createLabTable } from '../table';
import { compareAll, fmtNum, segment, type Comparison, type Segment } from './analysis';
import { download, listServer, openText, postToServer, saveDesktop, serverUrl, type ServerReport } from './deliver';
import { startRecording, type RecEvent, type Recording, type RecordingHandle } from './recording';
import { buildReport, type LabReport } from './report';
import { drawTimeline, timelineLegend } from './timeline';

/** THE LAB'S RECORDER (tabs "Gravação" and "Relatórios"): the game recorded as it is set, cut at every change, each stretch held against the one before; on Stop a report for an AI (JSON + Markdown) downloaded, written by the dev server into `lab-reports/` and by the desktop app into its data folder. Probes drive it through `window.__labRecorder`. */

export interface SessionReport {
  readonly report: LabReport;
  /** Where it was written: the dev server's files, the desktop folder (null: not there). */
  server: string | null;
  desktop: string | null;
}

export interface LabRecorderProbe {
  start(options?: { seconds?: number }): void;
  stop(): LabReport | null;
  pause(): void;
  resume(): void;
  mark(name: string): void;
  report(): LabReport | null;
  /** The last report's deliveries, once done. */
  delivered(): Promise<SessionReport | null>;
  readonly recording: boolean;
}

/** The live segments are cut again at most this often while shown. */
const LIVE_SEGMENTS_MS = 1000;

const button = (text: string, title: string, onClick: () => void, iconName?: string): HTMLButtonElement => {
  const b = document.createElement('button');
  b.type = 'button';
  if (iconName) b.append(icon(iconName));
  b.append(text);
  b.title = title;
  b.onclick = onClick;
  return b;
};
const row = (...children: HTMLElement[]): HTMLDivElement => {
  const div = document.createElement('div');
  div.className = 'lab-row';
  div.append(...children);
  return div;
};
const card = (...children: HTMLElement[]): HTMLDivElement => {
  const div = document.createElement('div');
  div.className = 'lab-card';
  div.append(...children);
  return div;
};
const heading = (text: string): HTMLHeadingElement => {
  const h = document.createElement('h3');
  h.textContent = text;
  return h;
};
const verdictOf = (c: Comparison | undefined): string => {
  if (!c) return '';
  const real = c.deltas.filter((d) => d.verdict !== 'dentro do ruído');
  if (!c.deltas.length) return 'poucos quadros';
  if (!real.length) return 'dentro do ruído';
  const worse = real.filter((d) => d.verdict === 'piorou').length, better = real.length - worse;
  return worse && better ? 'misto' : worse ? 'piorou' : 'melhorou';
};

export function createRecorderTabs(ctx: LabContext): LabTab[] {
  let handle: RecordingHandle | null = null;
  let shown: Recording | null = null;
  let segments: Segment[] = [];
  let previous = new Map<number, Comparison>();
  let segmentsAt = -Infinity;
  let delivering: Promise<SessionReport | null> = Promise.resolve(null);
  let autoDownload = false;
  let server: ServerReport[] = [];
  const reports: SessionReport[] = [];
  const views: { refresh(): void }[] = [];
  const refreshAll = (): void => { for (const v of views) v.refresh(); };

  const finish = (rec: Recording): void => {
    handle = null;
    const report = buildReport(ctx, rec);
    const entry: SessionReport = { report, server: null, desktop: null };
    reports.unshift(entry);
    segments = [...report.segments];
    previous = new Map(report.comparisons.filter((c) => c.kind === 'previous').map((c) => [c.segment, c]));
    const json = JSON.stringify(report.json);
    if (autoDownload) {
      download(`${report.stamp}.json`, json, 'application/json');
      download(`${report.stamp}.md`, report.md, 'text/markdown');
    }
    delivering = Promise.all([postToServer(report.stamp, json, report.md), saveDesktop(report.stamp, json, report.md)]).then(async ([toServer, toDesktop]) => {
      entry.server = toServer;
      entry.desktop = toDesktop;
      server = await listServer();
      refreshAll();
      return entry;
    });
    ctx.emit('rec.report', `relatório ${report.stamp}: ${report.summary}`);
    refreshAll();
  };

  const probe: LabRecorderProbe = {
    start(options) {
      if (handle) return;
      const seconds = options?.seconds ?? 0;
      ctx.emit('rec.start', `gravação iniciada${seconds > 0 ? ` (${seconds} s)` : ''}`);
      handle = startRecording(ctx, seconds > 0 ? seconds * 1000 : null, finish);
      shown = handle.recording;
      segments = [];
      previous = new Map();
      segmentsAt = -Infinity;
      // The frames come only while drawn: one asked for now.
      ctx.requestDraw();
      refreshAll();
    },
    stop() {
      handle?.stop('botão Parar');
      return reports[0]?.report ?? null;
    },
    pause() { handle?.pause(); refreshAll(); },
    resume() { handle?.resume(); refreshAll(); },
    mark(name) { handle?.mark(name); },
    report: () => reports[0]?.report ?? null,
    delivered: () => delivering,
    get recording() { return handle !== null; },
  };
  (window as unknown as { __labRecorder: LabRecorderProbe }).__labRecorder = probe;

  ctx.reportSection('recording', () => {
    if (handle) return { state: handle.recording.state, seconds: Math.round(handle.recording.activeMs / 100) / 10, frames: handle.recording.frames.t.length };
    const last = reports[0];
    if (!last) return { state: 'none' };
    const r = last.report;
    return {
      summary: r.summary,
      stamp: r.stamp,
      server: last.server,
      desktop: last.desktop,
      segments: r.segments.map((s) => ({ index: s.index, label: s.label, frames: s.cpu?.n ?? 0, intervalP50: s.interval?.p50 ?? null, cpuP50: s.cpu?.p50 ?? null, gpuP50: s.gpu?.p50 ?? null, hitches50: s.hitches50 })),
      changes: r.comparisons.filter((c) => c.kind === 'previous').map((c) => c.summary),
      anomalies: r.anomalies.map((a) => a.detail),
    };
  });

  const liveSegments = (): void => {
    const rec = shown;
    if (!rec || !handle) return;
    const now = performance.now();
    if (now - segmentsAt < LIVE_SEGMENTS_MS) return;
    segmentsAt = now;
    segments = segment(rec.frames, rec.events, rec.endMs);
    previous = new Map(compareAll(segments).filter((c) => c.kind === 'previous').map((c) => [c.segment, c]));
  };

  // ---- the recording tab
  const recorderTab = (): LabTab => {
    const host = document.createElement('div');
    const start = button('Gravar', 'Começar a gravar (tudo como está configurado)', () => probe.start({ seconds: Number(duration.value) || 0 }), 'record');
    const pause = button('Pausar', 'Pausar / retomar a gravação', () => (handle?.recording.state === 'paused' ? probe.resume() : probe.pause()), 'pause');
    const stop = button('Parar', 'Parar e gerar o relatório', () => probe.stop(), 'stop');
    const duration = document.createElement('input');
    duration.type = 'number';
    duration.min = '0';
    duration.step = '5';
    duration.value = '0';
    duration.style.width = '64px';
    duration.title = 'Duração em segundos (0 = até parar)';
    const durationLabel = document.createElement('span');
    durationLabel.className = 'lab-muted';
    durationLabel.textContent = 'duração (s, 0 = sem limite)';
    const status = document.createElement('div');
    status.className = 'lab-muted';
    const markName = document.createElement('input');
    markName.type = 'text';
    markName.placeholder = 'Nome do marcador…';
    markName.style.flex = '1';
    const mark = button('Marcar', 'Uma nota neste instante (também divide os segmentos)', () => { probe.mark(markName.value); markName.value = ''; }, 'plus');
    markName.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); mark.click(); } e.stopPropagation(); };
    duration.onkeydown = (e) => e.stopPropagation();
    const auto = document.createElement('label');
    const autoBox = document.createElement('input');
    autoBox.type = 'checkbox';
    autoBox.onchange = () => { autoDownload = autoBox.checked; };
    auto.append(autoBox, ' baixar JSON e MD ao parar');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:100%;height:150px;display:block;border-radius:6px';
    const delivery = document.createElement('div');
    delivery.className = 'lab-muted';
    const getJson = button('Baixar JSON', 'O relatório completo (todos os quadros)', () => { const r = reports[0]; if (r) download(`${r.report.stamp}.json`, JSON.stringify(r.report.json), 'application/json'); }, 'download');
    const getMd = button('Baixar MD', 'O resumo em Markdown, para uma IA ler', () => { const r = reports[0]; if (r) download(`${r.report.stamp}.md`, r.report.md, 'text/markdown'); }, 'download');
    const openMd = button('Abrir MD', 'Ler o resumo numa aba', () => { const r = reports[0]; if (r) openText(r.report.md, 'text/plain'); }, 'eye');
    const copyMd = button('Copiar MD', 'Copiar o resumo', () => { const r = reports[0]; if (r) void navigator.clipboard.writeText(r.report.md).catch((error: unknown) => console.warn('lab recorder: not copied', error)); }, 'copy');

    const segmentTable = createLabTable<Segment>({
      columns: [
        { key: 'index', label: '#', value: (s) => s.index },
        { key: 'start', label: 'início s', value: (s) => s.startMs / 1000, format: (v) => fmtNum(v, 1) },
        { key: 'dur', label: 'dur. s', value: (s) => (s.endMs - s.startMs) / 1000, format: (v) => fmtNum(v, 1) },
        { key: 'n', label: 'quadros', value: (s) => s.cpu?.n ?? 0 },
        { key: 'label', label: 'mudança', value: (s) => s.label },
        { key: 'int', label: 'interv. p50', value: (s) => s.interval?.p50 ?? null },
        { key: 'cpu', label: 'CPU p50', value: (s) => s.cpu?.p50 ?? null, bar: true },
        { key: 'cpu95', label: 'CPU p95', value: (s) => s.cpu?.p95 ?? null },
        { key: 'gpu', label: 'GPU p50', value: (s) => s.gpu?.p50 ?? null, bar: true },
        { key: 'gpu95', label: 'GPU p95', value: (s) => s.gpu?.p95 ?? null },
        { key: 'h50', label: '>50 ms', value: (s) => s.hitches50, title: 'Quadros com intervalo acima de 50 ms (fora do assentamento)' },
        { key: 'calls', label: 'draw calls', value: (s) => (s.drawCalls ? Math.round(s.drawCalls.mean) : null) },
        { key: 'delta', label: 'Δ vs anterior', value: (s) => { const c = previous.get(s.index); return c ? c.effect : ''; } },
        { key: 'verdict', label: 'veredito', value: (s) => verdictOf(previous.get(s.index)) },
      ],
      rows: () => segments,
      sort: { key: 'index', desc: false },
    });
    const eventTable = createLabTable<RecEvent>({
      columns: [
        { key: 't', label: 't (s)', value: (e) => e.t / 1000, format: (v) => fmtNum(v, 2) },
        { key: 'kind', label: 'tipo', value: (e) => e.kind },
        { key: 'detail', label: 'detalhe', value: (e) => e.detail },
        { key: 'split', label: 'divide', value: (e) => (e.split ? 'sim' : '') },
      ],
      rows: () => shown?.events ?? [],
      sort: { key: 't', desc: true },
      categoryKey: 'kind',
      limit: 300,
    });
    host.append(
      card(row(start, pause, stop, duration, durationLabel), status, row(markName, mark), row(auto)),
      card(canvas, timelineLegend()),
      heading('Segmentos'),
      segmentTable.element,
      heading('Relatório'),
      card(delivery, row(getJson, getMd, openMd, copyMd)),
      heading('Eventos'),
      eventTable.element,
    );

    const refresh = (): void => {
      const rec = shown;
      const state = handle?.recording.state ?? 'stopped';
      start.disabled = handle !== null;
      pause.disabled = handle === null;
      stop.disabled = handle === null;
      mark.disabled = handle === null;
      duration.disabled = handle !== null;
      pause.replaceChildren(icon(state === 'paused' ? 'play' : 'pause'), state === 'paused' ? 'Retomar' : 'Pausar');
      start.classList.toggle('on', state === 'recording');
      status.textContent = rec
        ? `${state === 'recording' ? '● gravando' : state === 'paused' ? '❚❚ pausada' : 'parada'} — ${fmtNum(rec.activeMs / 1000, 1)} s${rec.limitMs ? ` de ${fmtNum(rec.limitMs / 1000, 0)} s` : ''}, ${rec.frames.t.length.toLocaleString('pt-BR')} quadros, ${rec.events.length} eventos, ${rec.events.filter((e) => e.split).length} mudanças${rec.stopReason ? ` (parada: ${rec.stopReason})` : ''}`
        : 'Nenhuma gravação ainda. Configure o jogo, aperte Gravar e mude interruptores/otimizações: cada mudança abre um segmento.';
      const last = reports[0];
      for (const b of [getJson, getMd, openMd, copyMd]) b.disabled = !last;
      delivery.textContent = last
        ? `${last.report.stamp}: ${last.report.summary}. Servidor: ${last.server ?? '—'} · App desktop: ${last.desktop ?? '—'}`
        : 'O relatório sai ao parar.';
      liveSegments();
      drawTimeline(canvas, rec);
      segmentTable.refresh();
      eventTable.refresh();
    };
    const view = { refresh };
    return {
      id: 'recorder',
      title: 'Gravação',
      mount(target) {
        target.appendChild(host);
        if (!views.includes(view)) views.push(view);
        refresh();
      },
      refresh,
      unmount() {
        const i = views.indexOf(view);
        if (i >= 0) views.splice(i, 1);
      },
    };
  };

  // ---- the reports tab
  const reportsTab = (): LabTab => {
    const host = document.createElement('div');
    const sessionList = document.createElement('div');
    const serverList = document.createElement('div');
    const reload = button('Atualizar', 'Ler de novo a pasta lab-reports/ do servidor', () => { void listServer().then((files) => { server = files; refresh(); }); }, 'refresh');
    host.append(heading('Desta sessão'), sessionList, row(heading('Em lab-reports/ (servidor de desenvolvimento)'), reload), serverList);
    const table = (heads: readonly string[], rows: readonly HTMLElement[][]): HTMLElement => {
      const wrap = document.createElement('div');
      wrap.className = 'lab-table';
      const scroll = document.createElement('div');
      scroll.className = 'lab-table-scroll';
      const t = document.createElement('table');
      const tr = document.createElement('tr');
      for (const h of heads) { const th = document.createElement('th'); th.textContent = h; tr.appendChild(th); }
      const head = document.createElement('thead');
      head.appendChild(tr);
      const body = document.createElement('tbody');
      for (const cells of rows) {
        const r = document.createElement('tr');
        for (const c of cells) { const td = document.createElement('td'); td.appendChild(c); r.appendChild(td); }
        body.appendChild(r);
      }
      t.append(head, body);
      scroll.appendChild(t);
      wrap.appendChild(scroll);
      return wrap;
    };
    const text = (s: string): HTMLElement => { const span = document.createElement('span'); span.textContent = s; return span; };
    const refresh = (): void => {
      sessionList.replaceChildren(reports.length
        ? table(['relatório', 'resumo', 'salvo em', ''], reports.map((r) => [
          text(r.report.stamp),
          text(r.report.summary),
          text([r.server, r.desktop].filter(Boolean).join(' · ') || '—'),
          row(
            button('Abrir', 'Ler o Markdown numa aba', () => openText(r.report.md, 'text/plain'), 'eye'),
            button('MD', 'Baixar o Markdown', () => download(`${r.report.stamp}.md`, r.report.md, 'text/markdown'), 'download'),
            button('JSON', 'Baixar o JSON', () => download(`${r.report.stamp}.json`, JSON.stringify(r.report.json), 'application/json'), 'download'),
          ),
        ]))
        : text('Nenhum relatório nesta sessão.'));
      serverList.replaceChildren(server.length
        ? table(['arquivo', 'tamanho', 'data', ''], server.map((f) => {
          const open = document.createElement('a');
          open.href = serverUrl(f.name);
          open.target = '_blank';
          open.rel = 'noopener';
          open.textContent = 'Abrir';
          const get = document.createElement('a');
          get.href = serverUrl(f.name);
          get.download = f.name;
          get.textContent = 'Baixar';
          return [text(f.name), text(`${fmtNum(f.size / 1024, 0)} KB`), text(new Date(f.mtime).toLocaleString('pt-BR')), row(open, get)];
        }))
        : text(import.meta.env.DEV ? 'Nenhum arquivo (ou o servidor não respondeu).' : 'Só no servidor de desenvolvimento.'));
    };
    const view = { refresh };
    return {
      id: 'recorder-reports',
      title: 'Relatórios',
      mount(target) {
        target.appendChild(host);
        if (!views.includes(view)) views.push(view);
        refresh();
        void listServer().then((files) => { server = files; refresh(); });
      },
      unmount() {
        const i = views.indexOf(view);
        if (i >= 0) views.splice(i, 1);
      },
    };
  };

  return [recorderTab(), reportsTab()];
}

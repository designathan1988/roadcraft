// WHAT RUNS INSIDE THE PAGE AND THE WORKERS for the probe (PLANO-SONDA.md §3 [B], Etapa 0): nothing of the game's code is touched;
// these functions are serialised by Playwright (`addInitScript`, `page.evaluate`, `worker.evaluate`) and run in the browser.
// DO NOT close over anything from this module: each function is sent as its own source text.

/** Before the game's code (`addInitScript`): the long-animation-frame observer (passive, both passes) and, in the counting pass
 *  (`hooks`), the page's side of every worker message: how many, how many bytes, and each one over `largeBytes` with the game's line that sent it. */
export function initScript({ hooks, largeBytes }) {
  const S = (window.__sonda = { loaf: [], msgs: { byWorker: {}, large: [], ports: { n: 0, bytes: 0 } }, hooks });
  // Long animation frames (>= 50 ms, the browser's own threshold): the entry script of each, kept for the analyser.
  if (PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) S.loaf.push(e.toJSON()); }).observe({ type: 'long-animation-frame', buffered: true });
  }
  // Every animation frame the page ran a callback in, counted where it fires (one per frame, however many callbacks): the frames the game drew,
  // all of them (`__frames` keeps the last 240). Wrapping asks no frame of its own.
  S.frames = 0;
  let lastFrame = -1;
  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) { return raf.call(window, (t) => { if (t !== lastFrame) { lastFrame = t; S.frames++; } return cb(t); }); };
  if (!hooks) return;
  const STACK = /\(?((?:https?:)?\/\/[^\s()]+):(\d+):(\d+)\)?\s*$/;
  /** The first line of the game's own code (/src/) in the stack, or the first line there is. */
  const site = () => {
    const lines = new Error().stack.split('\n');
    let first = null;
    for (let i = 2; i < lines.length; i++) {
      const m = lines[i].match(STACK);
      if (!m) continue;
      if (m[1].includes('/src/')) return `${m[1]}:${m[2]}:${m[3]}`;
      first ??= `${m[1]}:${m[2]}:${m[3]}`;
    }
    return first ?? '(no stack)';
  };
  /** The bytes a structured clone of `v` carries, bounded: exact for buffers and strings, 8 a number, the first 1024 items of an array. */
  const sizeOf = (v, depth = 0) => {
    if (v == null) return 0;
    if (v instanceof ArrayBuffer) return v.byteLength;
    if (ArrayBuffer.isView(v)) return v.byteLength;
    if (typeof v === 'string') return v.length * 2;
    if (typeof v !== 'object' || depth > 4) return 8;
    let n = 0;
    if (Array.isArray(v)) { const k = Math.min(v.length, 1024); for (let i = 0; i < k; i++) n += sizeOf(v[i], depth + 1); return (n * v.length) / Math.max(1, k); }
    if (v instanceof Map) { for (const [a, b] of v) n += sizeOf(a, depth + 1) + sizeOf(b, depth + 1); return n; }
    if (v instanceof Set) { for (const a of v) n += sizeOf(a, depth + 1); return n; }
    for (const k in v) n += sizeOf(v[k], depth + 1);
    return n;
  };
  const names = new WeakMap();
  let serial = 0;
  const OrigWorker = window.Worker;
  window.Worker = function (url, options) {
    const w = new OrigWorker(url, options);
    const name = `${options?.name ?? String(url).replace(/^.*\//, '').replace(/\?.*$/, '')}#${++serial}`;
    names.set(w, name);
    const row = (S.msgs.byWorker[name] ??= { made: site(), url: String(url).replace(/\?.*$/, ''), out: 0, outBytes: 0, in: 0, inBytes: 0 });
    w.addEventListener('message', (e) => {
      const b = sizeOf(e.data);
      row.in++; row.inBytes += b;
      if (b >= largeBytes) S.msgs.large.push({ dir: 'from', worker: name, bytes: b, kind: String(e.data?.kind ?? e.data?.type ?? e.data?.service ?? ''), at: performance.now() });
    });
    return w;
  };
  window.Worker.prototype = OrigWorker.prototype;
  const post = OrigWorker.prototype.postMessage;
  OrigWorker.prototype.postMessage = function (data, transfer) {
    const name = names.get(this) ?? 'worker';
    const row = (S.msgs.byWorker[name] ??= { made: '?', url: '?', out: 0, outBytes: 0, in: 0, inBytes: 0 });
    const b = sizeOf(data);
    row.out++; row.outBytes += b;
    if (b >= largeBytes) S.msgs.large.push({ dir: 'to', worker: name, bytes: b, kind: String(data?.kind ?? data?.type ?? data?.service ?? ''), site: site(), at: performance.now() });
    return post.call(this, data, transfer);
  };
  const portPost = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (data, transfer) {
    const b = sizeOf(data);
    S.msgs.ports.n++; S.msgs.ports.bytes += b;
    if (b >= largeBytes) S.msgs.large.push({ dir: 'port', worker: '(port)', bytes: b, kind: String(data?.kind ?? data?.type ?? data?.service ?? ''), site: site(), at: performance.now() });
    return portPost.call(this, data, transfer);
  };
}

/** Inside a worker (`worker.evaluate`, counting pass): messages in and out of its global scope and its ports, counted with bytes; `self.__sonda` holds them. */
export function workerHooks() {
  if (self.__sonda) return 'already';
  const S = (self.__sonda = { in: 0, inBytes: 0, out: 0, outBytes: 0, portOut: 0, portOutBytes: 0, portIn: 0, portInBytes: 0, big: [] });
  const sizeOf = (v, depth = 0) => {
    if (v == null) return 0;
    if (v instanceof ArrayBuffer) return v.byteLength;
    if (ArrayBuffer.isView(v)) return v.byteLength;
    if (typeof v === 'string') return v.length * 2;
    if (typeof v !== 'object' || depth > 4) return 8;
    let n = 0;
    if (Array.isArray(v)) { const k = Math.min(v.length, 1024); for (let i = 0; i < k; i++) n += sizeOf(v[i], depth + 1); return (n * v.length) / Math.max(1, k); }
    for (const k in v) n += sizeOf(v[k], depth + 1);
    return n;
  };
  const post = self.postMessage;
  self.postMessage = function (data, transfer) { const b = sizeOf(data); S.out++; S.outBytes += b; if (b >= 1048576) S.big.push({ dir: 'out', bytes: b, kind: String(data?.kind ?? data?.type ?? '') }); return post.call(self, data, transfer); };
  self.addEventListener('message', (e) => { S.in++; S.inBytes += sizeOf(e.data); });
  const pp = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (data, transfer) { const b = sizeOf(data); S.portOut++; S.portOutBytes += b; return pp.call(this, data, transfer); };
  const d = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
  if (d?.set) Object.defineProperty(MessagePort.prototype, 'onmessage', { configurable: true, get: d.get, set(fn) { d.set.call(this, typeof fn === 'function' ? function (e) { S.portIn++; S.portInBytes += sizeOf(e.data); return fn.call(this, e); } : fn); } });
  return 'installed';
}

/** What a worker says of itself at a scene's end (both passes): its heap, when the browser exposes it, and the counters when installed. */
export function workerRead() {
  const mem = self.performance?.memory;
  return { heapBytes: mem ? mem.usedJSHeapSize : null, counters: self.__sonda ?? null };
}

/** After the game booted (`page.evaluate`): `window.__probe` with the scene's signature, `settle`, `frames`, the orbit sweep and the readings of a scene. */
export function helpers() {
  const r = window.__roadcraft;
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const handle = () => r.scene();
  /** What makes the scene the scene (`scripts/lib/measureCity.mjs`): the buildings' levels chosen and shown, the vehicles and people. */
  const signature = () => {
    const lv = handle().buildingLevels?.() ?? {};
    return { tri: lv.chosenTriangles ?? 0, detail: lv.shownDetail ?? 0, facade: lv.shownFacade ?? 0, notLanded: lv.notLanded ?? 0, vehicles: r.sim.vehicles.size, people: r.sim.pedViews.length, busy: handle().worldBusy, opening: handle().opening, programs: handle().gl.info.programs?.length ?? 0 };
  };
  const sign = (s) => `${s.tri}|${s.detail}|${s.facade}|${s.vehicles}|${s.people}|${s.programs}`;
  window.__probe = {
    signature, sign,
    /** Settled: the world not busy, nothing waiting to land, the signature the same for `stableMs`. Says how long it took. */
    async settle(stableMs, maxMs) {
      const t0 = performance.now();
      let last = '', since = t0;
      while (performance.now() - t0 < maxMs) {
        const s = signature(), now = sign(s);
        if (now !== last || s.notLanded > 0 || s.busy || s.opening) { last = now; since = performance.now(); }
        else if (performance.now() - since >= stableMs) return { ms: Math.round(performance.now() - t0), scene: now, settled: true };
        await sleep(200);
      }
      return { ms: Math.round(performance.now() - t0), scene: last, settled: false };
    },
    /** `n` frames drawn, so a picture shows what the last step did. */
    frames(n = 2) {
      return new Promise((done) => {
        r.redraw();
        let left = n;
        const tick = () => (--left <= 0 ? done() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      });
    },
    /** The camera turned a full circle round (x, y) at `zoom` in `ms`, a step a frame (`setView`, bearing and tilt in radians). */
    async orbit(x, y, zoom, elevationDeg, ms) {
      const t0 = performance.now();
      let frames = 0;
      while (performance.now() - t0 < ms) {
        const az = ((performance.now() - t0) / ms) * Math.PI * 2;
        r.setView({ x, y, zoom, azimuth: az, elevation: (elevationDeg * Math.PI) / 180 });
        frames++;
        await new Promise((res) => requestAnimationFrame(res));
      }
      return frames;
    },
    /** The scene marked in the page's own timeline (`blink.user_timing` in the trace, and the clock the LoAF entries use). */
    mark(name) { performance.mark(name); return performance.now(); },
    /** Everything the game already tells of itself, at a scene's end (`__roadcraft` memory/budget/shadowStats/buildingLevels, `__frames`, `__gpu`, `__state`). */
    readings(budgetView, since, sinceFrames) {
      const h = handle();
      const out = { at: performance.now(), framesDrawn: (window.__sonda?.frames ?? 0) - (sinceFrames ?? 0) };
      const take = (key, fn) => { try { out[key] = fn(); } catch (e) { out[key] = { error: String(e?.message ?? e) }; } };
      take('memory', () => r.memory());
      take('budget', () => (budgetView ? r.budget(budgetView) : null));
      take('shadowStats', () => h.shadowStats());
      take('buildingLevels', () => h.buildingLevels());
      take('frames', () => window.__frames(since));
      take('gpu', () => window.__gpu(true));
      take('state', () => window.__state(60));
      take('ledger', () => r.ledger());
      take('stats', () => ({ ...h.stats }));
      take('gl', () => ({ memory: { ...h.gl.info.memory }, programs: h.gl.info.programs?.length ?? 0, render: { ...h.gl.info.render } }));
      take('doc', () => ({ buildings: r.doc.buildings.size, segments: r.doc.segments.size, nodes: r.doc.nodes.size, lots: r.doc.lots.length, revision: r.doc.revision, netRevision: r.net.revision }));
      take('sim', () => ({ paused: r.sim.clock.paused, speed: r.sim.clock.speed, vehicles: r.sim.vehicles.size, people: r.sim.pedViews.length, time: r.sim.clock.time }));
      take('heap', () => performance.memory?.usedJSHeapSize ?? null);
      take('loaf', () => { const l = window.__sonda?.loaf ?? []; const mine = l.filter((e) => e.startTime >= since); return mine; });
      take('msgs', () => window.__sonda?.msgs ?? null);
      take('quality', () => h.stats.quality);
      return out;
    },
    /** The page's memory as the browser measures it at its next GC (`measureUserAgentSpecificMemory`, cross-origin isolated), or why not. */
    async uaMemory(timeoutMs) {
      if (!crossOriginIsolated) return { error: 'not cross-origin isolated' };
      if (typeof performance.measureUserAgentSpecificMemory !== 'function') return { error: 'measureUserAgentSpecificMemory missing' };
      return Promise.race([performance.measureUserAgentSpecificMemory(), sleep(timeoutMs).then(() => ({ error: `no answer in ${timeoutMs} ms` }))]);
    },
  };
  return { fit: { x: r.camera.x, y: r.camera.y, zoom: r.camera.zoom } };
}

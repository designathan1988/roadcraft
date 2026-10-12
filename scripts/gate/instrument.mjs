// What the gate puts into every page before the game's own scripts run
// (`page.addInitScript`): the long animation frames with their scripts
// (Chrome, "Long Animation Frames API"), every WebGL program linked, and the
// bytes handed to the GPU by buffer and texture uploads. Counters only: the
// gate reads them as deltas over a measured window. The same script runs in
// the base and the candidate, so its own small cost cancels out.
/* global window, PerformanceObserver, WebGL2RenderingContext, WebGLRenderingContext, Element */
export function instrument() {
  const g = {
    loaf: [],
    links: 0,
    linkTimes: [],
    up: { buffer: 0, texture: 0, calls: 0 },
  };
  window.__gate = g;
  Element.prototype.requestPointerLock = function requestPointerLock() { return Promise.resolve(); };
  try {
    window.localStorage.setItem('roadcraft.language', 'pt-BR');
  } catch (error) {
    console.error('gate: language not set', error);
  }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (g.loaf.length >= 5000) g.loaf.shift();
        g.loaf.push({
          start: e.startTime,
          duration: e.duration,
          blocking: e.blockingDuration,
          scripts: (e.scripts ?? []).slice(0, 4).map((s) => ({
            source: String(s.sourceURL ?? '').split('/').pop(),
            fn: s.sourceFunctionName ?? '',
            invoker: s.invoker ?? '',
            duration: Math.round(s.duration),
          })),
        });
      }
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch (error) {
    console.error('gate: no long-animation-frame observer', error);
  }
  // Bytes a texture call sends: width x height (x depth) x bytes per pixel of
  // its format and type (WebGL 2 specification, texImage2D/texSubImage2D);
  // never the length of the array handed in, which may be larger.
  const CHANNELS = { 0x1908: 4, 0x1907: 3, 0x8227: 2, 0x1903: 1, 0x8d99: 4, 0x8d98: 3, 0x8228: 2, 0x8d94: 1, 0x1906: 1, 0x1909: 1, 0x190a: 2, 0x1902: 1, 0x84f9: 1 };
  const CHANNEL_BYTES = { 0x1401: 1, 0x1400: 1, 0x1403: 2, 0x1402: 2, 0x1405: 4, 0x1404: 4, 0x140b: 2, 0x1406: 4 };
  const PACKED = { 0x8363: 2, 0x8033: 2, 0x8034: 2, 0x8368: 4, 0x8c3b: 4, 0x8c3e: 4, 0x84fa: 4, 0x8dad: 8 };
  const pixelBytes = (format, type) => PACKED[type] ?? (CHANNELS[format] ?? 4) * (CHANNEL_BYTES[type] ?? 1);
  const dims = (source) => [source?.width ?? source?.videoWidth ?? source?.displayWidth ?? 0, source?.height ?? source?.videoHeight ?? source?.displayHeight ?? 0];
  /** Bytes per kind of texture upload (call, size, format, type): which one is sent the most. */
  g.up.byKind = new Map();
  const tex = (name, w, h, d, format, type) => {
    const bytes = w * h * d * pixelBytes(format, type);
    g.up.calls += 1;
    g.up.texture += bytes;
    const key = `${name} ${w}x${h}${d > 1 ? `x${d}` : ''} f${Number(format).toString(16)} t${Number(type).toString(16)}`;
    const k = g.up.byKind.get(key) ?? { bytes: 0, calls: 0 };
    k.bytes += bytes;
    k.calls += 1;
    g.up.byKind.set(key, k);
  };
  const bytesOf = (view, offset = 0, length = 0) => {
    if (!view) return 0;
    const unit = view.BYTES_PER_ELEMENT ?? 1;
    if (length) return length * unit;
    return Math.max(0, (view.byteLength ?? 0) - offset * unit);
  };
  const wrap = (proto, name, count) => {
    const original = proto[name];
    if (typeof original !== 'function') return;
    proto[name] = function wrapped(...args) {
      count(args);
      return original.apply(this, args);
    };
  };
  for (const ctx of [WebGL2RenderingContext, WebGLRenderingContext]) {
    const p = ctx?.prototype;
    if (!p) continue;
    wrap(p, 'linkProgram', () => { g.links += 1; if (g.linkTimes.length < 5000) g.linkTimes.push(performance.now()); });
    wrap(p, 'bufferData', (a) => { g.up.calls += 1; g.up.buffer += typeof a[1] === 'number' ? a[1] : bytesOf(a[1], a[3] ?? 0, a[4] ?? 0); });
    wrap(p, 'bufferSubData', (a) => { g.up.calls += 1; g.up.buffer += bytesOf(a[2], a[3] ?? 0, a[4] ?? 0); });
    wrap(p, 'texImage2D', (a) => {
      if (a.length >= 9) { tex('texImage2D', a[3], a[4], 1, a[6], a[7]); return; }
      const [w, h] = dims(a[5]);
      tex('texImage2D', w, h, 1, a[3], a[4]);
    });
    wrap(p, 'texSubImage2D', (a) => {
      if (a.length >= 9) { tex('texSubImage2D', a[4], a[5], 1, a[6], a[7]); return; }
      const [w, h] = dims(a[6]);
      tex('texSubImage2D', w, h, 1, a[4], a[5]);
    });
    wrap(p, 'texImage3D', (a) => tex('texImage3D', a[3], a[4], a[5], a[7], a[8]));
    wrap(p, 'texSubImage3D', (a) => tex('texSubImage3D', a[5], a[6], a[7], a[8], a[9]));
    wrap(p, 'compressedTexImage2D', (a) => { g.up.calls += 1; g.up.texture += typeof a[6] === 'number' ? a[6] : bytesOf(a[6]); });
    wrap(p, 'compressedTexSubImage2D', (a) => { g.up.calls += 1; g.up.texture += typeof a[7] === 'number' ? a[7] : bytesOf(a[7]); });
  }
}

// WHAT THE DIAGNOSIS WATCHES INSIDE THE PAGE, installed before the game's own code runs (Playwright `addInitScript`): every long animation
// frame with the scripts that held it (Long Animation Frames API), every WebGL call that makes the page wait for the GPU, with the stack that
// made it, the programs linked and the bytes uploaded - each filed under the phase of the run it happened in (`window.__diag.setPhase`).

// Runs in the page, not in node.
export function instrument() {
  const diag = {
    // A reload on purpose (the save opened again) names its phase before it (`diag:phase`): its frames are filed under it, not under the first boot.
    phase: window.sessionStorage.getItem('diag:phase') ?? 'boot',
    /** Long animation frames (> 50 ms), with their scripts. */
    longFrames: [],
    /** Per phase: per WebGL call that waits for the GPU, its count, ms and the stacks that made it. */
    sync: {},
    /** Per phase: programs linked, bytes uploaded to buffers and textures, upload calls. */
    gpuWork: {},
    setPhase(name) { diag.phase = name; performance.mark(`diag:${name}`); },
  };
  window.__diag = diag;
  const work = () => (diag.gpuWork[diag.phase] ??= { linked: 0, bufferBytes: 0, textureBytes: 0, uploads: 0 });

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        diag.longFrames.push({
          phase: diag.phase, start: Math.round(e.startTime), ms: Math.round(e.duration), blocking: Math.round(e.blockingDuration ?? 0),
          scripts: (e.scripts ?? []).map((s) => ({ url: s.sourceURL, fn: s.sourceFunctionName, pos: s.sourceCharPosition, ms: Math.round(s.duration), invoker: s.invoker, type: s.invokerType })),
        });
      }
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch (error) { console.warn(`no long animation frames (${error.message}): the CPU profile still says where the time went`); }

  // The calls that block the page until the GPU has caught up (Khronos WebGL 2.0: reading back buffers and pixels, finishing, waiting on a
  // sync; a program's or shader's status read before KHR_parallel_shader_compile says it is done).
  const COMPLETION_STATUS_KHR = 0x91b1;
  const BLOCKING = ['getBufferSubData', 'readPixels', 'finish', 'clientWaitSync', 'getError', 'getProgramParameter', 'getShaderParameter'];
  const MOST_STACKS = 25;
  const wrapBlocking = (proto, name) => {
    const original = proto[name];
    if (typeof original !== 'function') return;
    proto[name] = function (...args) {
      const t0 = performance.now();
      const value = original.apply(this, args);
      const ms = performance.now() - t0;
      const phase = (diag.sync[diag.phase] ??= {});
      // Asking whether a parallel compile is done is meant not to wait, but every query is a round trip to Chrome's GPU process: filed
      // apart, so a poll of many programs shows as what it costs.
      const key = (name === 'getProgramParameter' || name === 'getShaderParameter') && args[1] === COMPLETION_STATUS_KHR ? `${name}(COMPLETION_STATUS)` : name;
      const row = (phase[key] ??= { count: 0, ms: 0, worst: 0, stacks: {} });
      row.count++;
      row.ms += ms;
      row.worst = Math.max(row.worst, ms);
      if (Object.keys(row.stacks).length < MOST_STACKS || ms > 1) {
        // Deep enough to get past three's own frames to the game's (V8 keeps 10 by default).
        const limit = Error.stackTraceLimit;
        Error.stackTraceLimit = 30;
        const stack = String(new Error().stack ?? '').split('\n').slice(2, 30).join('\n');
        Error.stackTraceLimit = limit;
        const s = (row.stacks[stack] ??= { count: 0, ms: 0 });
        s.count++;
        s.ms += ms;
      }
      return value;
    };
  };
  const bytesOf = (v) => (v && typeof v.byteLength === 'number' ? v.byteLength : typeof v === 'number' ? v : 0);
  const wrapUpload = (proto, name, kind, at) => {
    const original = proto[name];
    if (typeof original !== 'function') return;
    proto[name] = function (...args) {
      const w = work();
      w.uploads++;
      // The data's argument: a typed array (its bytes) or, for bufferData, a size.
      const data = args.findLast?.((a) => a && typeof a.byteLength === 'number') ?? args[at];
      w[kind] += bytesOf(data);
      return original.apply(this, args);
    };
  };
  for (const ctor of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (!ctor) continue;
    const proto = ctor.prototype;
    for (const name of BLOCKING) wrapBlocking(proto, name);
    const link = proto.linkProgram;
    proto.linkProgram = function (...args) { work().linked++; return link.apply(this, args); };
    wrapUpload(proto, 'bufferData', 'bufferBytes', 1);
    wrapUpload(proto, 'bufferSubData', 'bufferBytes', 2);
    for (const name of ['texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D', 'compressedTexImage2D', 'compressedTexSubImage2D']) wrapUpload(proto, name, 'textureBytes', -1);
  }
}

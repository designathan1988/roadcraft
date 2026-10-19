// THE PROBE'S COLLECTORS over the DevTools protocol (PLANO-SONDA.md §3 [B]): coverage, CPU profile, allocation sampling, heap
// snapshots, the browser's memory of the tab, and the served sources with their maps. Every reading is written under `out/bruto/`
// as it is taken: a run that dies keeps what it had.
import { createWriteStream, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Precise coverage (V8 block counts): started once, taken at each scene's end as the counts since the last take. */
export async function startCoverage(cdp) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true, allowTriggeredUpdates: false });
}

/** The counts since the last take: the game's own scripts (/src/) whole, every other script summed (its calls, its functions run). */
export async function takeCoverage(cdp) {
  const { result, timestamp } = await cdp.send('Profiler.takePreciseCoverage');
  const ours = [], others = [];
  for (const script of result) {
    const url = script.url.replace(/\?.*$/, '');
    if (url.includes('/src/')) ours.push({ url, scriptId: script.scriptId, functions: script.functions });
    else {
      let calls = 0, run = 0, total = 0;
      for (const fn of script.functions) { total++; const c = fn.ranges[0]?.count ?? 0; if (c > 0) { run++; calls += c; } }
      if (calls > 0) others.push({ url: url || '(inline)', calls, run, total });
    }
  }
  return { timestamp, ours, others };
}

/** The sampled CPU profile of a stretch (`Profiler.start`/`stop`), written as a `.cpuprofile` DevTools opens. */
export async function startProfile(cdp, samplingUs) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: samplingUs });
  await cdp.send('Profiler.start');
}
export async function stopProfile(cdp, file) {
  const { profile } = await cdp.send('Profiler.stop');
  writeFileSync(file, JSON.stringify(profile));
  return { file, samples: profile.samples.length, startTime: profile.startTime, endTime: profile.endTime };
}

/** Allocation sampling with the objects the GC already took kept in (what was allocated, not what survived). */
export async function startAllocations(cdp, intervalBytes) {
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: intervalBytes, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
}
/** The profile since the start, written; sampling started again for the next scene. */
export async function cutAllocations(cdp, file, intervalBytes) {
  const { profile } = await cdp.send('HeapProfiler.stopSampling');
  writeFileSync(file, JSON.stringify(profile));
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: intervalBytes, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  let bytes = 0;
  (function walk(n) { bytes += n.selfSize; for (const c of n.children ?? []) walk(c); })(profile.head);
  return { file, bytes };
}

/** The heap after a collection, exact (`Runtime.getHeapUsage`), bytes. */
export async function heapAfterGc(cdp) {
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  const u = await cdp.send('Runtime.getHeapUsage');
  return { usedBytes: u.usedSize, totalBytes: u.totalSize };
}

/** The whole heap written as DevTools' `.heapsnapshot`, streamed; refused (said why) over `maxBytes` of used heap. */
export async function heapSnapshot(cdp, file, maxBytes) {
  const before = await heapAfterGc(cdp);
  if (before.usedBytes > maxBytes) return { file: null, skipped: `heap de ${Math.round(before.usedBytes / 1e6)} MB passa do teto de ${Math.round(maxBytes / 1e6)} MB para um instantâneo`, ...before };
  const stream = createWriteStream(file);
  let written = 0;
  const write = ({ chunk }) => { written += chunk.length; stream.write(chunk); };
  cdp.on('HeapProfiler.addHeapSnapshotChunk', write);
  const t0 = Date.now();
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false, exposeInternals: false });
  cdp.off('HeapProfiler.addHeapSnapshotChunk', write);
  await new Promise((done) => stream.end(done));
  return { file, bytes: written, ms: Date.now() - t0, ...before };
}

/** The served sources the run touched (/src/ URLs seen in coverage, profiles, allocations and long frames), fetched from the dev server with
 *  their inline source maps, so the analyser resolves lines offline (`fontes.json`). */
export async function fetchSources(base, urls, file) {
  const out = {};
  for (const raw of urls) {
    const clean = raw.replace(/\?.*$/, '');
    if (!clean.includes('/src/') || out[clean]) continue;
    try {
      const abs = clean.startsWith('http') ? clean : base.replace(/\/$/, '') + clean;
      const text = await (await fetch(abs)).text();
      const m = text.match(/\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/);
      const lineStarts = [0];
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
      out[clean] = { lineStarts, map: m ? JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) : null };
    } catch (e) { out[clean] = { error: String(e.message ?? e) }; }
  }
  writeFileSync(file, JSON.stringify(out));
  return Object.keys(out).length;
}

/** The URLs under /src/ a scene's raw readings name. */
export function sourceUrlsOf(scene) {
  const urls = new Set();
  for (const s of scene.coverage?.ours ?? []) urls.add(s.url);
  for (const e of scene.readings?.loaf ?? []) for (const sc of e.scripts ?? []) if (sc.sourceURL) urls.add(sc.sourceURL);
  return urls;
}

/** The URLs a `.cpuprofile` or allocation profile names under /src/. */
export function sourceUrlsOfProfile(profile) {
  const urls = new Set();
  const nodes = profile.nodes ?? [];
  for (const n of nodes) if (String(n.callFrame.url).includes('/src/')) urls.add(n.callFrame.url);
  if (profile.head) (function walk(n) { if (String(n.callFrame.url).includes('/src/')) urls.add(n.callFrame.url); for (const c of n.children ?? []) walk(c); })(profile.head);
  return urls;
}

export const sceneFile = (out, n, name, ext) => join(out, 'bruto', `cena${String(n).padStart(2, '0')}-${name}.${ext}`);

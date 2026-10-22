// SERVED LINE -> SOURCE LINE: the inline source maps Vite puts in each served `/src/` module (`sources.json`, fetched by the run),
// read offline by the analyser. A position the map does not cover stays as the served file and line, marked.
import { SourceMapConsumer } from 'source-map-js';

export class Sources {
  constructor(table) {
    this.table = table;
    this.consumers = new Map();
  }
  entry(url) {
    const clean = String(url ?? '').replace(/\?.*$/, '');
    return this.table[clean] ?? null;
  }
  consumer(url) {
    const clean = String(url ?? '').replace(/\?.*$/, '');
    if (this.consumers.has(clean)) return this.consumers.get(clean);
    const e = this.table[clean];
    const c = e?.map ? new SourceMapConsumer(e.map) : null;
    this.consumers.set(clean, c);
    return c;
  }
  /** `src/x.ts:12` for a served line and column (1-based line, 1-based column). */
  original(url, line, column) {
    const c = this.consumer(url);
    if (c) {
      const p = c.originalPositionFor({ line, column: Math.max(0, (column ?? 1) - 1) });
      if (p.source) return `${sourcePath(url, p.source)}:${p.line}`;
    }
    return `${shortPath(url)}:${line}`;
  }
  /** `src/x.ts:12` for a character offset in the served script (coverage ranges, LoAF `sourceCharPosition`). */
  atOffset(url, offset) {
    const e = this.entry(url);
    if (!e?.lineStarts) return `${shortPath(url)}@${offset}`;
    const ls = e.lineStarts;
    let lo = 0, hi = ls.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ls[mid] <= offset) lo = mid; else hi = mid - 1; }
    return this.original(url, lo + 1, offset - ls[lo] + 1);
  }
  /** The source file alone (`src/x.ts`) of a served URL. */
  fileOf(url) {
    return shortPath(url);
  }
}

/** The source file a map names, as `src/...`: Vite names it relative to the served module's folder (`jobPool.ts` for `/src/jobs/jobPool.ts`). */
function sourcePath(url, source) {
  const s = String(source);
  if (s.includes('/src/') || s.startsWith('src/')) return shortPath(s);
  const dir = shortPath(url).replace(/[^/]*$/, '');
  const parts = (dir + s).split('/');
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.' && p !== '') out.push(p); }
  return out.join('/');
}

export const shortPath = (p) => String(p ?? '').replace(/^.*?\/src\//, 'src/').replace(/^.*?\/node_modules\/\.vite\/deps\//, 'deps/').replace(/^.*?\/node_modules\//, 'node_modules/').replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '');

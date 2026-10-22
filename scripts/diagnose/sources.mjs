// FROM THE BUILT BUNDLE BACK TO THE GAME'S OWN LINE: a position in `assets/*.js` (a CPU profile's frame, a stack's line, a long frame's
// script) read through the build's source maps into `src/<file>.ts:<line>` (@jridgewell/trace-mapping, the maps Vite writes with `sourcemap`).
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';

export function sourceMapper(dist, root) {
  const maps = new Map();
  const texts = new Map();
  /** The bundle file a URL of the preview server names, or null (another origin, a blob, a worker's inline code). */
  const fileOf = (url) => {
    try {
      const path = new URL(url).pathname.replace(/^\//, '');
      const file = join(dist, path);
      return existsSync(file) ? file : null;
    } catch (error) { if (error instanceof TypeError) return null; throw error; }
  };
  const mapOf = (file) => {
    if (!maps.has(file)) maps.set(file, existsSync(`${file}.map`) ? new TraceMap(readFileSync(`${file}.map`, 'utf8')) : null);
    return maps.get(file);
  };
  /** `src/x.ts:12` for a 0-based line and column in the bundle at `url`, or null. */
  const at = (url, line, column) => {
    const file = fileOf(url);
    const map = file ? mapOf(file) : null;
    if (!map || line < 0) return null;
    const p = originalPositionFor(map, { line: line + 1, column: Math.max(0, column) });
    if (!p.source) return null;
    const source = relative(root, resolve(join(file, '..'), p.source)).replace(/\\/g, '/');
    return { file: source, line: p.line, name: p.name, where: `${source}:${p.line}` };
  };
  return {
    at,
    /** The same for a character offset into the bundle (a long frame's `sourceCharPosition`). */
    atChar(url, char) {
      const file = fileOf(url);
      if (!file || !(char >= 0)) return null;
      if (!texts.has(file)) texts.set(file, readFileSync(file, 'utf8'));
      const text = texts.get(file);
      let line = 0, start = 0;
      for (let i = text.indexOf('\n'); i !== -1 && i < char; i = text.indexOf('\n', i + 1)) { line++; start = i + 1; }
      return at(url, line, char - start);
    },
    /** A stack (Error().stack's lines, `at fn (url:line:col)`) as the game's own frames, `src/x.ts:12`; the first frame outside `src/`
     *  (three's, the browser's) kept before them when the stack starts there, so a wait inside three still says which of its calls waited. */
    stack(text) {
      const frames = [];
      let outside = null;
      for (const line of String(text).split('\n')) {
        const m = /at (?:(.+?) \()?(https?:\/\/[^)\s]+?):(\d+):(\d+)\)?\s*$/.exec(line.trim());
        if (!m) continue;
        const p = at(m[2], Number(m[3]) - 1, Number(m[4]) - 1);
        if (p && p.file.startsWith('src/')) frames.push(p.where);
        else if (!frames.length && !outside && p) outside = `${p.file.replace(/^.*node_modules\//, '')}:${p.line}`;
      }
      return outside ? [outside, ...frames] : frames;
    },
  };
}

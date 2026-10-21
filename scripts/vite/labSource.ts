import fs from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import type { Plugin } from 'vite';

/** THE LAB INSPECTOR'S SOURCE SEARCH (dev server only): `GET /__lab/source-find?q=<name>` - where in `src/` a 3D object's name is made: the name
 *  written whole in a string, or the fixed parts of a template that makes it (`building-${kind}`, `car-${style}-${body}-far`), each with its lines round it.
 *  Vite plugin API: `configureServer` adds a Connect middleware; `apply: 'serve'` keeps it out of builds. The files are read again only when changed. */

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.glsl', '.vert', '.frag', '.wgsl']);
const MAX_HITS = 40;
const CONTEXT = 3;
/** Parts too common to look for alone. */
const COMMON = new Set(['far', 'near', 'lod', 'mesh', 'group', 'lite', 'cards', 'the', 'and']);

interface Kept { readonly mtime: number; readonly lines: readonly string[] }
interface Hit { file: string; line: number; text: string; context: string; start: number; how: string; score: number }

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

/** The strings looked for, each with what it says and how much it weighs: the whole name quoted, then the fixed start and end of a template. */
export function patternsOf(name: string): { text: string; how: string; score: number }[] {
  const out: { text: string; how: string; score: number }[] = [];
  for (const q of ["'", '"', '`']) out.push({ text: `${q}${name}${q}`, how: 'whole name', score: 100 });
  // A piece of code asked as it is written (the lab's investigation: `mark('drawing')`, `hitch:draw/Render`, `gpuTimer.begin()`).
  if (name.length >= 4) out.push({ text: name, how: 'text', score: 90 });
  // A level's mark (`@4`, a ladder of detail) is added to the name made: the parts are looked for without it.
  const parts = name.replace(/@\w+$/, '').split('-');
  for (let k = parts.length - 1; k >= 1; k--) {
    const prefix = parts.slice(0, k).join('-');
    if (prefix.length < 3 || (k === 1 && COMMON.has(prefix))) continue;
    for (const q of ["'", '"', '`']) out.push({ text: `${q}${prefix}-`, how: `prefix "${prefix}-"`, score: 50 + 6 * k });
  }
  for (let k = parts.length - 1; k >= 1; k--) {
    const suffix = parts.slice(parts.length - k).join('-');
    if (suffix.length < 3 || (k === 1 && COMMON.has(suffix))) continue;
    for (const end of ["'", '"', '`']) out.push({ text: `-${suffix}${end}`, how: `suffix "-${suffix}"`, score: 35 + 6 * k });
    out.push({ text: `}-${suffix}`, how: `suffix "-${suffix}"`, score: 35 + 6 * k });
  }
  return out;
}

export function labSourcePlugin(): Plugin {
  let root = '';
  const kept = new Map<string, Kept>();

  /** Every source file under `src/`, its lines read again when its time changed. */
  const files = async (): Promise<[string, readonly string[]][]> => {
    const out: [string, readonly string[]][] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        if (!EXTENSIONS.has(path.extname(entry.name)) || entry.name.endsWith('.d.ts')) continue;
        // The inspector's own tables of names are not where the objects are made.
        if (full.includes(`${path.sep}lab${path.sep}inspector${path.sep}`)) continue;
        const stat = await fs.stat(full);
        let file = kept.get(full);
        if (!file || file.mtime !== stat.mtimeMs) {
          file = { mtime: stat.mtimeMs, lines: (await fs.readFile(full, 'utf8')).split(/\r?\n/) };
          kept.set(full, file);
        }
        out.push([path.relative(root, full).split(path.sep).join('/'), file.lines]);
      }
    };
    await walk(path.join(root, 'src'));
    return out;
  };

  const search = async (name: string): Promise<Hit[]> => {
    const patterns = patternsOf(name);
    const hits: Hit[] = [];
    for (const [file, lines] of await files()) {
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i]!;
        let best: { how: string; score: number } | null = null;
        for (const p of patterns) if ((!best || p.score > best.score) && text.includes(p.text)) best = p;
        if (!best) continue;
        // A line that names an object weighs more than one that only mentions the string; one that reads a name (a comparison, a test) less.
        const naming = /\.name\s*=[^=]|\bname:\s*['"`]/.test(text) ? 15 : 0;
        const reading = /startsWith\(|endsWith\(|includes\(|===\s*['"`]|\.test\(/.test(text) ? -25 : 0;
        const start = Math.max(0, i - CONTEXT);
        hits.push({ file, line: i + 1, text: text.trim().slice(0, 240), context: lines.slice(start, i + CONTEXT + 1).join('\n'), start: start + 1, how: best.how, score: best.score + naming + reading });
      }
    }
    hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
    return hits.slice(0, MAX_HITS);
  };

  return {
    name: 'roadcraft-lab-source',
    apply: 'serve',
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const [url, query = ''] = (req.url ?? '').split('?');
        if (url !== '/__lab/source-find') { next(); return; }
        const q = new URLSearchParams(query).get('q')?.trim() ?? '';
        if (!q || q.length > 200) { send(res, 400, { error: 'q: the name looked for (1 to 200 characters)' }); return; }
        void search(q).then((hits) => send(res, 200, { q, hits }), (error: unknown) => {
          console.error('lab source search failed', error);
          send(res, 500, { error: String(error) });
        });
      });
    },
  };
}

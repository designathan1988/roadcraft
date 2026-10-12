import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * THE URLS OF THE MODEL FILES, one module per folder of `public/models`
 * (`virtual:model-urls/<folder>?ext=a,b`): its files by their path inside
 * the folder. The game serves no public folder (`publicDir: false`), so each
 * file was reached through an eager `import.meta.glob(..., { query: '?url' })`:
 * every file a module of its own - 2 086 requests through the dev server at
 * every opening - and in a build every small file inlined as base64 into the
 * main chunk (1.8 MB of its 4.2 MB). Here the dev server is handed the
 * files' own paths (what `?url` gave there: it serves the project's files),
 * and a build emits each as an asset of its own and writes its URL the way
 * Vite's `?url` does (`__VITE_ASSET__<referenceId>__`, replaced when the
 * chunk is rendered), never inlined.
 */
const PREFIX = 'virtual:model-urls/';

function filesUnder(dir: string, extensions: ReadonlySet<string>, prefix = ''): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...filesUnder(path.join(dir, entry.name), extensions, rel));
    else if (extensions.has(path.extname(entry.name).slice(1).toLowerCase())) out.push(rel);
  }
  return out.sort();
}

export function modelUrlsPlugin(): Plugin {
  let root = process.cwd();
  let building = false;
  return {
    name: 'roadcraft-model-urls',
    configResolved(config) {
      root = config.root;
      building = config.command === 'build';
    },
    resolveId(id) {
      return id.startsWith(PREFIX) ? `\0${id}` : null;
    },
    load(id) {
      if (!id.startsWith(`\0${PREFIX}`)) return null;
      const [folder = '', query = ''] = id.slice(1 + PREFIX.length).split('?');
      const extensions = new Set((new URLSearchParams(query).get('ext') ?? '').split(',').filter(Boolean));
      const dir = path.join(root, 'public', 'models', folder);
      const urls: Record<string, string> = {};
      for (const rel of filesUnder(dir, extensions)) {
        if (!building) {
          urls[rel] = `/public/models/${folder}/${rel}`;
          continue;
        }
        const referenceId = this.emitFile({ type: 'asset', name: path.basename(rel), source: fs.readFileSync(path.join(dir, rel)) });
        urls[rel] = `__VITE_ASSET__${referenceId}__`;
      }
      return `export default ${JSON.stringify(urls)};`;
    },
  };
}

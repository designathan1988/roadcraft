import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/** THE URLS OF THE MODEL FILES, one module per folder of `public/models` (`virtual:model-urls/<folder>?ext=a,b`) */
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

import { lookup, mapOfModule, type DecodedMap, type SourceLocation } from './sourceMap';

/** THE CODE'S SOURCES, as the dev server serves them: each module fetched once, its map decoded, its original text kept (the map's `sourcesContent`). Owned by the code tabs. */

interface ModuleEntry {
  /** null: no map, or not fetched (`error` says). */
  map: DecodedMap | null;
  error: string | null;
}

export interface SourceStore {
  /** The original place of a profiled function (1-based generated line and column, as the Profiler gives them); null until the module's map is in (asked for then), or if it has none. */
  locate(url: string, line: number, column: number): SourceLocation | null;
  /** The module's map, fetched if needed. */
  load(url: string): Promise<DecodedMap | null>;
  /** The original text of a source (`/src/...ts`), from a map already in, or fetched as Vite's `?raw` module. */
  text(file: string): Promise<string | null>;
  /** Every source file whose text is known (from the maps fetched). */
  files(): readonly string[];
  /** The text known for `file` now, without fetching. */
  textNow(file: string): string | null;
  /** The modules reachable from the game's entry by their imports (`/src/main.ts`), each loaded; `progress` told as it goes. */
  crawl(entry: string, progress: (done: number, total: number) => void): Promise<readonly string[]>;
  /** Modules asked and their state. */
  stats(): { modules: number; mapped: number; failed: number };
}

const CRAWL_PARALLEL = 8;
/** Vite's rewritten imports: `from "/src/x.ts"`, `import "/src/x.ts"`, `import("/src/x.ts")`. */
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\/src\/[^"'?]+\.(?:ts|js|mjs|tsx))(?:\?[^"']*)?["']/g;

export function createSourceStore(): SourceStore {
  const modules = new Map<string, ModuleEntry>();
  const pending = new Map<string, Promise<DecodedMap | null>>();
  const texts = new Map<string, string>();
  const imports = new Map<string, string[]>();

  const keep = (map: DecodedMap): void => {
    map.sources.forEach((file, i) => {
      const content = map.contents[i];
      if (typeof content === 'string' && !texts.has(file)) texts.set(file, content);
    });
  };

  async function fetchModule(url: string): Promise<DecodedMap | null> {
    const entry: ModuleEntry = { map: null, error: null };
    modules.set(url, entry);
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const found: string[] = [];
      for (const m of text.matchAll(IMPORT)) found.push(m[1]!);
      imports.set(url, found);
      entry.map = await mapOfModule(text, url);
      if (entry.map) keep(entry.map);
      else entry.error = 'sem mapa';
    } catch (error) {
      console.warn(`lab code: module ${url} not read`, error);
      entry.error = String(error);
    }
    return entry.map;
  }

  const store: SourceStore = {
    locate(url, line, column) {
      // Only the server's scripts have maps (not `wasm:`, `blob:` or the browser's own).
      if (!/^https?:/.test(url)) return null;
      const entry = modules.get(url);
      if (!entry) { void store.load(url); return null; }
      if (!entry.map) return null;
      return lookup(entry.map, line - 1, column - 1);
    },
    load(url) {
      const entry = modules.get(url);
      if (entry && !pending.has(url)) return Promise.resolve(entry.map);
      let p = pending.get(url);
      if (!p) {
        p = fetchModule(url).finally(() => pending.delete(url));
        pending.set(url, p);
      }
      return p;
    },
    async text(file) {
      const known = texts.get(file);
      if (known !== undefined) return known;
      // Vite's `?raw`: the file as a module, `export default "..."` (a JSON string literal); a script with no source behind it (a prebundled dependency) as served.
      try {
        const response = await fetch(file.startsWith('/src/') ? `${file}?raw` : file);
        if (!response.ok) return null;
        const body = await response.text();
        const m = file.startsWith('/src/') ? /export default (".*")\s*;?\s*(?:\/\/#|$)/s.exec(body) : null;
        if (file.startsWith('/src/') && !m) return null;
        const text = m ? (JSON.parse(m[1]!) as string) : body;
        texts.set(file, text);
        return text;
      } catch (error) {
        console.warn(`lab code: source ${file} not read`, error);
        return null;
      }
    },
    files: () => [...texts.keys()],
    textNow: (file) => texts.get(file) ?? null,
    async crawl(entry, progress) {
      const origin = location.origin;
      const seen = new Set<string>([entry]);
      const queue = [entry];
      let done = 0;
      const worker = async (): Promise<void> => {
        for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
          const url = origin + path;
          await store.load(url);
          done++;
          for (const next of imports.get(url) ?? []) {
            if (!seen.has(next)) { seen.add(next); queue.push(next); }
          }
          progress(done, seen.size);
        }
      };
      // Workers wait for the queue to refill while others are still loading.
      const running = new Set<Promise<void>>();
      while (queue.length || running.size) {
        while (queue.length && running.size < CRAWL_PARALLEL) {
          const p: Promise<void> = worker().finally(() => running.delete(p));
          running.add(p);
        }
        if (running.size) await Promise.race(running);
      }
      return [...seen];
    },
    stats() {
      let mapped = 0, failed = 0;
      for (const e of modules.values()) { if (e.map) mapped++; if (e.error) failed++; }
      return { modules: modules.size, mapped, failed };
    },
  };
  return store;
}

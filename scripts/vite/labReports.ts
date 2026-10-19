import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Plugin } from 'vite';

/** THE LAB'S REPORTS ON DISK (dev server only): the recorder's report (`src/lab/recorder/deliver.ts`) written into `lab-reports/<stamp>.json` and `.md` in the repository, listed and read back. Vite plugin API: `configureServer` adds a Connect middleware; `apply: 'serve'` keeps it out of builds. */

const FOLDER = 'lab-reports';
/** A whole recording's frames fit well under this; more is refused (413). */
const MAX_BODY = 64 * 1024 * 1024;
/** The only names written or read: no separators, no dots leading anywhere. */
const STAMP = /^[A-Za-z0-9_-]{1,80}$/;
const FILE = /^[A-Za-z0-9_-]{1,80}\.(json|md)$/;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8'): void {
  res.statusCode = status;
  res.setHeader('content-type', type);
  res.setHeader('cache-control', 'no-store');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

export function labReportsPlugin(): Plugin {
  let dir = '';
  return {
    name: 'roadcraft-lab-reports',
    apply: 'serve',
    // The reports written are not the game's sources: no reload when one lands.
    config: () => ({ server: { watch: { ignored: [`**/${FOLDER}/**`] } } }),
    configResolved(config) {
      dir = path.resolve(config.root, FOLDER);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]!;
        if (!url.startsWith('/__lab/report')) { next(); return; }
        void (async () => {
          try {
            if (url === '/__lab/report' && req.method === 'POST') {
              let parsed: { stamp?: unknown; json?: unknown; md?: unknown };
              try {
                parsed = JSON.parse(await readBody(req)) as typeof parsed;
              } catch (error) {
                send(res, String(error).includes('too large') ? 413 : 400, { error: String(error) });
                return;
              }
              const { stamp, json, md } = parsed;
              if (typeof stamp !== 'string' || !STAMP.test(stamp) || typeof json !== 'string' || typeof md !== 'string') { send(res, 400, { error: 'expected { stamp, json, md } strings, stamp [A-Za-z0-9_-]' }); return; }
              await fs.promises.mkdir(dir, { recursive: true });
              const files = [`${stamp}.json`, `${stamp}.md`];
              await fs.promises.writeFile(path.join(dir, files[0]!), json, 'utf8');
              await fs.promises.writeFile(path.join(dir, files[1]!), md, 'utf8');
              server.config.logger.info(`lab report written: ${FOLDER}/${files[1]}`, { timestamp: true });
              send(res, 200, { files: files.map((f) => `${FOLDER}/${f}`) });
              return;
            }
            if (url === '/__lab/reports' && req.method === 'GET') {
              const names = fs.existsSync(dir) ? (await fs.promises.readdir(dir)).filter((n) => FILE.test(n)) : [];
              const files = await Promise.all(names.map(async (name) => {
                const stat = await fs.promises.stat(path.join(dir, name));
                return { name, size: stat.size, mtime: stat.mtimeMs };
              }));
              send(res, 200, { files: files.sort((a, b) => b.mtime - a.mtime) });
              return;
            }
            if (url.startsWith('/__lab/reports/') && req.method === 'GET') {
              const name = decodeURIComponent(url.slice('/__lab/reports/'.length));
              if (!FILE.test(name)) { send(res, 400, { error: 'bad name' }); return; }
              const file = path.join(dir, name);
              if (!fs.existsSync(file)) { send(res, 404, { error: 'not found' }); return; }
              send(res, 200, await fs.promises.readFile(file, 'utf8'), name.endsWith('.md') ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8');
              return;
            }
            send(res, 405, { error: 'method not allowed' });
          } catch (error) {
            server.config.logger.error(`lab report failed: ${String(error)}`);
            if (!res.headersSent) send(res, 500, { error: String(error) });
          }
        })();
      });
    },
  };
}

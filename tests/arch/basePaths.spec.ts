import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * EVERY FILE THE GAME FETCHES IS UNDER THE BUILD'S BASE. The two modes are
 * served from one origin, each under its own base (`/plano/`, `/planeta/`,
 * `scripts/build-modes.mjs`, Vite's `base`). A fetch of `/cooked/...` there is
 * answered with the root page, not the file: the cooked people's manifest
 * failed to parse, silently, and every person in the player's game was built
 * on the main thread as they came into view (audit of 2026-10-12). A path
 * the game fetches is written from `import.meta.env.BASE_URL`; only the dev
 * server's own endpoints (`/__cook`, `/__build`) stand at the root.
 */
const SRC = join(process.cwd(), 'src');
const ABSOLUTE_FETCH = /fetch\(\s*['"`]\/(?!__)/;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...tsFilesUnder(path));
    else if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('base paths', () => {
  it('fetches nothing from the origin root but the dev server endpoints', () => {
    const offenders = tsFilesUnder(SRC)
      .map((file) => relative(SRC, file).split(sep).join('/'))
      .filter((file) => !file.startsWith('backup/'))
      .filter((file) => ABSOLUTE_FETCH.test(code(readFileSync(join(SRC, file), 'utf8'))));
    expect(offenders).toEqual([]);
  });
});

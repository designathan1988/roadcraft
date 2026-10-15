import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { loadRocketboxClips, type RocketboxLibrary } from '@render/citizenWalk';

/** Both Rocketbox motion libraries through the game's own loader */
export async function rocketboxLibrary(): Promise<RocketboxLibrary> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const file = basename(url.split('?')[0]!);
    return Promise.resolve(new Response(readFileSync(join(process.cwd(), 'src', 'render', 'motion', file))));
  }) as typeof fetch;
  try {
    return { male: await loadRocketboxClips('male'), female: await loadRocketboxClips('female') };
  } finally {
    globalThis.fetch = realFetch;
  }
}

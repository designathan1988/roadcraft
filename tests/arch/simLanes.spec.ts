import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** THE SIMULATION'S BAYS AND CONFLICT PAIRS ON LANES OF THEIR OWN (`jobPool.ts` jobChannel), never queued jobs of the page's pool: a queued job runs on any of its workers, and each worker that took one carried the simulation's modules and state, up to nine isolates of it in the one V8 cage (the 20 km runs k20g-k20m, the page out of memory, 2026-10-18) */

const root = join(__dirname, '..', '..');
const sources = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);

describe("the simulation's work on the page's job pool", () => {
  it('is never a queued job: bays and conflicts go only to the lanes the page hands the simulation', () => {
    const queued: string[] = [];
    for (const file of sources('src')) {
      const text = readFileSync(join(root, file), 'utf8');
      // A queued job of either service, or a channel that turns asks into queued jobs.
      if (/submitJob\(\{[^}]*service:\s*'(?:bays|conflicts)'/s.test(text) || /jobQueueChannel/.test(text)) queued.push(file);
    }
    expect(queued).toEqual([]);
  });

  it('has as many lanes as the pool has workers for other kinds: one on a machine of four threads', () => {
    const main = readFileSync(join(root, 'src/main.ts'), 'utf8');
    expect(main).toMatch(/Array\.from\(\{ length: jobLanes\(4\) \}, \(\) => jobChannel\(service, \(\) => sim\.laneLost\(service\)\)\)/);
  });

  it.each([[4, 1], [6, 2], [24, 2]])('a machine of %i threads gives the simulation %i lanes each for bays and pairs', async (cores, lanes) => {
    vi.resetModules();
    vi.stubGlobal('navigator', { hardwareConcurrency: cores });
    vi.stubGlobal('document', {});
    const { jobLanes } = await import('@/jobs/jobPool');
    expect(jobLanes(4)).toBe(lanes);
  });
  afterEach(() => { vi.unstubAllGlobals(); });
});

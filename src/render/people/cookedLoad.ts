import type { Group } from 'three';
import { uncookInWorker } from '../bakePool';
import { assemblePerson, uncookPerson } from './cookedPerson';

/** The people cooked for this build, read back (`cookedPerson.ts`): the manifest, and each person read in a worker */

declare const __PEOPLE_COOK_HASH__: string | undefined;
/** The fingerprint of how people are built in this build (`cook-plugin.ts`); null in tests. */
const COOK_HASH = typeof __PEOPLE_COOK_HASH__ !== 'undefined' ? __PEOPLE_COOK_HASH__ : null;
let manifest: Promise<ReadonlySet<string> | null> | null = null;
/** A missing or stale cook is looked for again a little later */
function lookAgain(): void {
  if (typeof setTimeout === 'function') setTimeout(() => { manifest = null; }, 20_000);
}

/** The ids cooked for this build, or null when there are none (or another build's). */
function cookedIds(): Promise<ReadonlySet<string> | null> {
  manifest ??= (async () => {
    if (!COOK_HASH || typeof fetch === 'undefined') return null;
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('nocook')) return null;
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}cooked/people/manifest.json`, { cache: 'no-cache' });
      if (!response.ok) {
        console.warn(`No cooked people for this build (fingerprint ${COOK_HASH}): every person is built during play, which stutters. Run "npm run cook:people".`);
        lookAgain();
        return null;
      }
      const m = (await response.json()) as { hash?: string; ids?: string[] };
      if (m.hash !== COOK_HASH) {
        // Named rather than silent: a stale cook is how a rebuild turned into a stutter nobody could explain.
        console.warn(`The cooked people are stale: they were cooked under ${m.hash ?? '(no hash)'}, this build fingerprints ${COOK_HASH}. Every person is built during play until "npm run cook:people" is run again.`);
        lookAgain();
        return null;
      }
      return Array.isArray(m.ids) ? new Set(m.ids) : null;
    } catch (error) {
      // Unreadable - an HTML page served in its place, as when the path missed the build's base
      console.error(`The cooked people's manifest could not be read (${String(error)}): every person is built during play, which stutters.`);
      return null;
    }
  })();
  return manifest;
}

/** The person cooked for this build, read back; null when it was not cooked (it is built instead). */
export async function loadCookedPerson(id: string): Promise<Group | null> {
  const ids = await cookedIds();
  if (!ids?.has(id)) return null;
  const path = `${import.meta.env.BASE_URL}cooked/people/${id}.bin`;
  try {
    // Read in a worker, its arrays moved here; read here only where no worker can.
    const decoded = await uncookInWorker(new URL(path, location.href).href);
    if (decoded) return assemblePerson(decoded);
    const response = await fetch(path);
    if (!response.ok) return null;
    return uncookPerson(await response.arrayBuffer());
  } catch {
    return null;
  }
}

/** This build's fingerprint, for the cook to stamp its manifest with. */
export const peopleCookHash = (): string | null => COOK_HASH;

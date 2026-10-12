import { Matrix4 } from 'three';
import type { ClipFrames } from '../citizenBake';
import { packRecord, unpackRecord, type PackRecord, type PackValue } from './cookPack';

/**
 * The procedural crowd cooked ahead (`proceduralCrowd.ts`): every body
 * class's data (shape basis, expressions, joint basis, face slots, clips) and
 * every hairstyle's cards, built once by `npm run cook:people` and read back
 * here. They are functions of the code and the assets alone, the same in
 * every game: built in the player's browser they were a stall of 40-240 ms
 * per class and 45-395 ms per hairstyle each time a new kind of person came
 * in (docs/performance.md #8). Missing or stale, they are built as before.
 */

declare const __PROCEDURAL_COOK_HASH__: string | undefined;
const COOK_HASH = typeof __PROCEDURAL_COOK_HASH__ !== 'undefined' ? __PROCEDURAL_COOK_HASH__ : null;

let manifest: Promise<ReadonlySet<string> | null> | null = null;
function cookedNames(): Promise<ReadonlySet<string> | null> {
  manifest ??= (async () => {
    if (!COOK_HASH || typeof fetch === 'undefined') return null;
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('nocook')) return null;
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}cooked/procedural/manifest.json`, { cache: 'no-cache' });
      const m = response.ok ? (await response.json()) as { hash?: string; names?: string[] } : null;
      if (!m || m.hash !== COOK_HASH || !Array.isArray(m.names)) {
        console.warn(`The procedural people are not cooked for this build (fingerprint ${COOK_HASH}): their classes and hairstyles are built during play. Run "npm run cook:people".`);
        // Looked for again later: a cook run meanwhile is read without reloading the game.
        if (typeof setTimeout === 'function') setTimeout(() => { manifest = null; }, 20_000);
        return null;
      }
      return new Set(m.names);
    } catch (error) {
      // Unreadable - an HTML page served in its place, as when the path
      // missed the build's base: loud, since every class is then built in play.
      console.error(`The procedural people's manifest could not be read (${String(error)}): their classes and hairstyles are built during play.`);
      return null;
    }
  })();
  return manifest;
}

/** A cooked record of this build, or null (not cooked: it is built instead). */
export async function loadProcedural(name: string): Promise<Record<string, PackValue> | null> {
  const names = await cookedNames();
  if (!names?.has(name)) return null;
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}cooked/procedural/${name}.bin`);
    return response.ok ? unpackRecord(await response.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

export const proceduralCookHash = (): string | null => COOK_HASH;

/** A clip as fields of a record, under a prefix. */
export function clipFields(prefix: string, clip: ClipFrames): PackRecord {
  return {
    [`${prefix}.data`]: clip.data, [`${prefix}.frames`]: clip.frames, [`${prefix}.duration`]: clip.duration,
    [`${prefix}.stride`]: clip.stride, [`${prefix}.pelvisY`]: clip.pelvisY, [`${prefix}.pelvisX`]: clip.pelvisX,
    [`${prefix}.pelvisZ`]: clip.pelvisZ, [`${prefix}.loop`]: clip.loop,
    [`${prefix}.travel`]: clip.travel ?? null, [`${prefix}.yaw`]: clip.yaw ?? null, [`${prefix}.hands`]: clip.hands ?? null,
    [`${prefix}.head`]: clip.head ? [...clip.head.elements] : null,
  };
}

export function clipOf(prefix: string, r: Record<string, PackValue>): ClipFrames {
  const head = r[`${prefix}.head`] as number[] | null;
  const clip: ClipFrames = {
    data: r[`${prefix}.data`] as Float32Array, frames: r[`${prefix}.frames`] as number, duration: r[`${prefix}.duration`] as number,
    stride: r[`${prefix}.stride`] as number, pelvisY: r[`${prefix}.pelvisY`] as number, pelvisX: r[`${prefix}.pelvisX`] as number,
    pelvisZ: r[`${prefix}.pelvisZ`] as number, loop: r[`${prefix}.loop`] as boolean,
  };
  const travel = r[`${prefix}.travel`], yaw = r[`${prefix}.yaw`], hands = r[`${prefix}.hands`];
  if (travel instanceof Float32Array) clip.travel = travel;
  if (yaw instanceof Float32Array) clip.yaw = yaw;
  if (hands instanceof Float32Array) clip.hands = hands;
  if (head) clip.head = new Matrix4().fromArray(head);
  return clip;
}

export { packRecord };

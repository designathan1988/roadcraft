import { fractureData, mergeFragments, type FractureInput } from './fracture';

/**
 * Breaks a building into its fragments off the main thread (`fracture.ts`):
 * a big building's Voronoi fracture took up to a second, the game frozen.
 * The fragments come back in one buffer per building (`mergeFragments`, made
 * here too: on the main thread it took up to 0.7 s), each buffer crossing
 * once (MDN: a buffer listed twice in the transfer throws a DataCloneError).
 */
self.onmessage = (e: MessageEvent<{ id: number; input: FractureInput }>) => {
  // Every job answered, a failure too (`destruction.ts` lets the building go):
  // DO NOT leave the page waiting for a building that never breaks.
  try {
    const still = mergeFragments(fractureData(e.data.input));
    const transfer: ArrayBuffer[] = [];
    for (const a of [still.position, still.normal, still.colour, still.uv, still.decay, ...still.slots]) transfer.push(a.buffer as ArrayBuffer);
    (self as unknown as Worker).postMessage({ id: e.data.id, still }, transfer);
  } catch (error) {
    console.error('[fracture worker]', error);
    (self as unknown as Worker).postMessage({ id: e.data.id, error: String(error) });
  }
};

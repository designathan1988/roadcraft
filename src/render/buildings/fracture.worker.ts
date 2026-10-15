import { fractureData, mergeFragments, type FractureInput } from './fracture';

/** Breaks a building into its fragments off the main thread (`fracture.ts`) */
self.onmessage = (e: MessageEvent<{ id: number; input: FractureInput }>) => {
  // Every job answered, a failure too (`destruction.ts` lets the building go)
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

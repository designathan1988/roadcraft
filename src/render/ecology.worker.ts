import { computeEcology, type EcologyField, type EcologyInput } from '@world/ecology';

/**
 * A plate's ecosystem off the page's thread (`ecologyPool.ts`): the whole
 * field of what grows read from the land sent (its arrays transferred, not
 * copied), and sent back the same way with the job's id.
 */
self.onmessage = (event: MessageEvent<{ id: number; input: EcologyInput }>) => {
  const { id, input } = event.data;
  try {
    const field: EcologyField = computeEcology(input);
    const transfer = [field.canopy, field.trees, field.emergent, field.shrub, field.palm, field.cactus, field.grass, field.dry, field.wet, field.rocky, field.region, field.waterDistance]
      .filter((a): a is Float32Array | Uint8Array => ArrayBuffer.isView(a))
      .map((a) => a.buffer);
    (self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }).postMessage({ id, field }, transfer);
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};

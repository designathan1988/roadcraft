import type { EcologyField, EcologyInput } from '@world/ecology';
import { forgetOtherDerived } from './derivedCache';
import { ECOLOGY_HASH, WOODS_HASH, derivedEcologyCache, keptEcology, keptWoods } from './ecologyKept';
import { FarWoodsWork, type FarWoodsAsk } from './farWoods';
import type { JobScope } from '../jobs/jobScope';

/** This service of the job system (`job.worker.ts`): its messages answered on the scope it is given. */
export function serve(self: JobScope): void {
  /** What this worker's far woods are worked in, plate after plate (`FarWoodsWork`). */
  const woodsWork = new FarWoodsWork();
  /** Where this worker keeps the fields and woods it works out, under its own write budget. */
  const kept = derivedEcologyCache();
  // An older build's fields and woods let go (kept under another fingerprint).
  if (ECOLOGY_HASH) forgetOtherDerived('ecology', ECOLOGY_HASH);
  if (WOODS_HASH) forgetOtherDerived('farWoods', WOODS_HASH);
  /** A plate's ecosystem off the page's thread (`ecologyPool.ts`): the whole field of what grows read from the land sent */
  self.onmessage = async (event: MessageEvent<{ id: number; input?: EcologyInput; far?: FarWoodsAsk }>) => {
    const { id, input, far } = event.data;
    const post = self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void };
    try {
      if (far) {
        // The woods kept for the same ask read back before they are worked out (`ecologyKept.ts`).
        const woods = await keptWoods(far, woodsWork, kept);
        post.postMessage({ id, woods }, [woods.x, woods.y, woods.z, woods.size, woods.yaw, woods.seed, woods.pick].map((a) => a.buffer));
        return;
      }
      // The field kept for the same land read back before it is worked out (`ecologyKept.ts`).
      const field: EcologyField = await keptEcology(input!, kept);
      const transfer = [field.canopy, field.trees, field.emergent, field.shrub, field.palm, field.cactus, field.grass, field.dry, field.wet, field.rocky, field.region, field.waterDistance]
        .filter((a): a is Float32Array | Uint8Array => ArrayBuffer.isView(a))
        .map((a) => a.buffer);
      post.postMessage({ id, field }, transfer);
    } catch (error) {
      self.postMessage({ id, error: String(error) });
    }
  };
}

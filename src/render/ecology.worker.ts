import { computeEcology, type EcologyField, type EcologyInput } from '@world/ecology';
import { farWoods, type FarWoodsAsk } from './farWoods';
import type { JobScope } from '../jobs/jobScope';

/** This service of the job system (`jobs/job.worker.ts`): its messages answered on the scope it is given. */
export function serve(self: JobScope): void {
  /** A plate's ecosystem off the page's thread (`ecologyPool.ts`): the whole field of what grows read from the land sent */
  self.onmessage = (event: MessageEvent<{ id: number; input?: EcologyInput; far?: FarWoodsAsk }>) => {
    const { id, input, far } = event.data;
    const post = self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void };
    try {
      if (far) {
        const woods = farWoods(far);
        post.postMessage({ id, woods }, [woods.x, woods.y, woods.z, woods.size, woods.yaw, woods.seed, woods.pick].map((a) => a.buffer));
        return;
      }
      const field: EcologyField = computeEcology(input!);
      const transfer = [field.canopy, field.trees, field.emergent, field.shrub, field.palm, field.cactus, field.grass, field.dry, field.wet, field.rocky, field.region, field.waterDistance]
        .filter((a): a is Float32Array | Uint8Array => ArrayBuffer.isView(a))
        .map((a) => a.buffer);
      post.postMessage({ id, field }, transfer);
    } catch (error) {
      self.postMessage({ id, error: String(error) });
    }
  };
}

import metaUrl from '../../../public/models/people/faceunits.json?url';
import binaryUrl from '../../../public/models/people/faceunits.bin?url';

/**
 * The face's blendshapes: the 52 of Apple's ARKit face tracking (the
 * industry's common set - Rocketbox/HeadBox, MetaHuman Live Link, VRM and
 * Ready Player Me all speak it), sculpted on the MakeHuman base mesh by the
 * MakeHuman community (faceunits01, CC0).
 * They share the body's stable vertex numbering.
 */
interface FaceunitMeta {
  vertexCount: number; entryCount: number; deltaOffset: number;
  targets: { name: string; start: number; count: number; scale: number }[];
}

/**
 * The 52 shapes, read and expanded once and shared by every face: they are the
 * same for every body (the base mesh's numbering), and their users only read
 * them (`render/people/faceExpression.ts` `channelShapes`, `proceduralBake.ts`).
 * DO NOT expand them per call: every body cooked for the street allocated 52
 * arrays of the whole mesh's size (some 12 MB) to the same values.
 */
let shapes: Promise<Readonly<Record<string, Float32Array>>> | undefined;

export function expressionShapes(): Promise<Readonly<Record<string, Float32Array>>> {
  if (shapes) return shapes;
  const loading = Promise.all([fetch(metaUrl).then((r) => r.json() as Promise<FaceunitMeta>), fetch(binaryUrl).then((r) => r.arrayBuffer())])
    .then(([meta, binary]) => {
      const indices = new Uint16Array(binary, 0, meta.entryCount);
      const deltas = new Int16Array(binary, meta.deltaOffset, meta.entryCount * 3);
      const out: Record<string, Float32Array> = {};
      for (const target of meta.targets) {
        const shape = out[target.name] = new Float32Array(meta.vertexCount * 3);
        for (let i = target.start; i < target.start + target.count; i++) {
          const vertex = indices[i]! * 3;
          for (let k = 0; k < 3; k++) shape[vertex + k] = deltas[i * 3 + k]! * target.scale;
        }
      }
      return out;
    });
  // A load that failed is tried again by the next face, not kept failed for the session.
  loading.catch((error: unknown) => {
    console.error('[people] the face shapes could not be loaded; the next face asks again', error);
    if (shapes === loading) shapes = undefined;
  });
  return (shapes = loading);
}

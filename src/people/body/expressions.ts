import metaUrl from '../../../public/models/people/faceunits.json?url';
import binaryUrl from '../../../public/models/people/faceunits.bin?url';

/** The face's blendshapes: the 52 of Apple's ARKit face tracking */
interface FaceunitMeta {
  vertexCount: number; entryCount: number; deltaOffset: number;
  targets: { name: string; start: number; count: number; scale: number }[];
}

/** DO NOT expand them per call: every body cooked for the street allocated 52 arrays of the whole mesh's size */
let shapes: Promise<Readonly<Record<string, Float32Array>>> | undefined;

/** A file fetched, or the load failed: a 404 page read as the shapes was no face. */
async function fetched(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return response;
}

export function expressionShapes(): Promise<Readonly<Record<string, Float32Array>>> {
  if (shapes) return shapes;
  const loading = Promise.all([fetched(metaUrl).then((r) => r.json() as Promise<FaceunitMeta>), fetched(binaryUrl).then((r) => r.arrayBuffer())])
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

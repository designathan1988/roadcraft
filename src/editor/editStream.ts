import { Rng } from '@core/rng';
import type { RoadDoc } from '@world/doc';

/** DO NOT hand an edit of the document `Math.random`: the map an edit made could not be made again */
export function editRng(doc: RoadDoc, x: number, y: number): Rng {
  return new Rng((doc.changes.version * 0x9e3779b1 + Math.round(x) * 73856093 + Math.round(y) * 19349663) >>> 0);
}

/** `editRng` as a function of no arguments, uniform in [0, 1). */
export function editRandom(doc: RoadDoc, x: number, y: number): () => number {
  const rng = editRng(doc, x, y);
  return () => rng.float();
}

import { Rng } from '@core/rng';
import type { RoadDoc } from '@world/doc';

/**
 * THE CHANCE OF AN EDIT: a stream seeded by the document (its diary's serial)
 * and the place the edit lands, for whatever an edit lays by chance in the
 * DOCUMENT - the trees and elements a brush scatters, the clouds spread over
 * the sky, the poles a blow pulls over. The same edit on the same document
 * lays the same things.
 * DO NOT hand an edit of the document `Math.random`: the map an edit made
 * could not be made again (a test, a replay, the same steps on another
 * machine), and two runs of the same steps disagreed.
 */
export function editRng(doc: RoadDoc, x: number, y: number): Rng {
  return new Rng((doc.changes.version * 0x9e3779b1 + Math.round(x) * 73856093 + Math.round(y) * 19349663) >>> 0);
}

/** `editRng` as a function of no arguments, uniform in [0, 1). */
export function editRandom(doc: RoadDoc, x: number, y: number): () => number {
  const rng = editRng(doc, x, y);
  return () => rng.float();
}

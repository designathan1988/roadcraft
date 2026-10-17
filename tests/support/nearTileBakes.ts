import { expect } from 'vitest';
import type { RoadDoc } from '@world/doc';
import { TILE, tileKey } from '@world/tiles';
import type { NearKind, NearPart, NearTileCache, NearTileReply } from '@render/nearTileBake';
import { runNearJob } from '@render/nearBakers';
import { recordsFor } from '@render/nearTiles';

/** A NEAR KIND BAKED OVER EVERY TILE OF A TOWN (`nearTileBake.ts`), each from the page's records of the 3 x 3 round it, as a worker bakes it: what the specs compare with the page's layer of the whole town */

const noCache: NearTileCache = { ready: async () => false, get: async () => undefined, put: async () => {} };

/** Every tile's bake of `kind` over the tiles `box` reaches, those with something in them. */
export async function bakeEveryTile(doc: RoadDoc, box: readonly [number, number, number, number], kind: NearKind, extra: unknown,
  parts: readonly NearPart[] = ['roads', 'rest']): Promise<unknown[]> {
  const i0 = Math.floor(box[0] / TILE) - 1, i1 = Math.floor(box[2] / TILE) + 1, j0 = Math.floor(box[1] / TILE) - 1, j1 = Math.floor(box[3] / TILE) + 1;
  const out: unknown[] = [];
  for (let i = i0 + 1; i < i1; i++) {
    for (let j = j0 + 1; j < j1; j++) {
      const tiles = [tileKey(i, j)];
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (di || dj) tiles.push(tileKey(i + di, j + dj));
      const reply: NearTileReply = await runNearJob({
        node: `${i},${j}`, asks: [{ kind, sig: 's', want: 'w', shown: null, extra }], prefix: null, heavy: true,
        tiles: tiles.map((key) => ({ key, version: 1 })), records: tiles.map((key) => recordsFor(doc.tileRecords(key, 1), parts)),
        ground: { ground: null, naturalIsGround: true },
      }, noCache);
      expect(reply.kind).toBe('near');
      const answer = reply.kind === 'near' ? reply.answers[0] : undefined;
      expect(answer && 'error' in answer ? answer.error : '').toBe('');
      if (answer && !('error' in answer) && answer.payload !== null) out.push(answer.payload);
    }
  }
  return out;
}

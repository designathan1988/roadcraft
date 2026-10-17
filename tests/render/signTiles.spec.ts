import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import { Network } from '@world/network';
import { applyLots, planLots } from '@world/lots';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import { layCity, widenCityFootways } from '@editor/cityGenerator';
import { buildRoadElevation } from '@world/elevation';
import { SIGN_TYPES, snapLandscape } from '@world/landscape';
import { m } from '@world/units';
import { type SignBake, createSignLayer, signProduct as pageSigns } from '@render/signLayer';
import { signProduct } from '@render/signTiles';
import { bakeEveryTile } from '../support/nearTileBakes';

/** A TILE'S SIGNS BAKED IN A WORKER (`signTiles.ts`): every tile's bake together stands what the page's layer stands for the whole town */

describe('a tile\'s signs baked in a worker', () => {
  it('every tile\'s bake together stands the page\'s plates of the whole town, each once', async () => {
    const doc = layCity(planCity({ ...DEFAULT_CITY, size: 'small' }));
    widenCityFootways(doc);
    doc.setMarkingStyle('br');
    const net = new Network(doc);
    net.rebuild();
    applyLots(doc, planLots(doc, net));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of doc.nodes.values()) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
    const rng = new Rng(0x5161);
    for (let i = 0; i < 120; i++) {
      const at = { x: x0 + rng.float() * (x1 - x0), y: y0 + rng.float() * (y1 - y0) };
      const snap = snapLandscape(net, doc.landscape.values(), 'sign', at, m(40));
      if (i % 4 === 0) doc.addLandscape('streetname', snap.ok ? snap.at : at, { text: `Rua ${i}` });
      else doc.addLandscape('sign', snap.ok ? snap.at : at, { signType: SIGN_TYPES[i % SIGN_TYPES.length]!, text: `${i}` });
    }
    if (net.revision !== doc.revision) net.rebuild();
    const elevation = buildRoadElevation(net, () => 0);
    const product = pageSigns();
    const want: string[] = [];
    for (const key of product.refresh({ changes: doc.changes, net, elevation }, [])) {
      for (const s of product.get(key)?.stands ?? []) want.push([s.x, s.y, s.ground, s.yaw].map((v) => v.toFixed(3)).concat(s.type, s.text).join(','));
    }
    const tiled = signProduct(createSignLayer(), () => doc.markingStyle);
    const bakes = await bakeEveryTile(doc, [x0, y0, x1, y1], 'signs', tiled.extra!(0)) as SignBake[];
    expect(bakes.length).toBeGreaterThan(1);
    const got = bakes.flatMap((b) => b.stands.map((s) => [s.x, s.y, s.ground, s.yaw].map((v) => v.toFixed(3)).concat(s.type, s.text).join(',')));
    expect(want.length).toBeGreaterThan(100);
    expect(got.sort()).toEqual(want.sort());
  });
});

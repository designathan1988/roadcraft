import { describe, expect, it } from 'vitest';
import type { InstancedBufferGeometry, InstancedMesh, InterleavedBufferAttribute, Mesh, Object3D } from 'three';
import { Group } from 'three';
import { Network } from '@world/network';
import { applyLots, planLots } from '@world/lots';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import { greenCity, layCity, widenCityFootways } from '@editor/cityGenerator';
import { buildRoadElevation } from '@world/elevation';
import type { RoadDoc } from '@world/doc';
import { TILE, tileKey } from '@world/tiles';
import { createSceneryKit } from '@render/scenery';
import type { PoleBake } from '@render/poleBake';
import { PoleLayer, buildUtilities } from '@render/poleLayer';
import { poleGroundAt } from '@render/utilities';
import type { NearTileCache, NearTileJob } from '@render/nearTileBake';
import { runNearJob } from '@render/nearBakers';
import { bakeEveryTile } from '../support/nearTileBakes';
import { poleProduct } from '@render/poleTiles';
import { recordsFor } from '@render/nearTiles';

/** A TILE'S POLES BAKED IN A WORKER (`poleTiles.ts`): every tile's bake together draws what the page's layer draws for the whole town */

/** Each part's drawn instances as sorted rows over every layer under `root`, and the wires' likewise: the picture, whatever the cells and slots. */
function picture(root: Object3D): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const put = (name: string, rows: string[]): void => { out.set(name, [...(out.get(name) ?? []), ...rows].sort()); };
  root.traverse((o) => {
    const mesh = o as InstancedMesh;
    if (mesh.isInstancedMesh) {
      const a = mesh.instanceMatrix.array as Float32Array;
      const rows: string[] = [];
      for (let i = 0; i < mesh.count; i++) {
        const row = [...a.subarray(i * 16, i * 16 + 16)];
        // An arm is a box about the mast: turned half round it is the same box (a corner pole's arm lies on the bisector of its two spans, signed by the order they were filed in, `poleArmsAt`).
        if (mesh.name === 'utility-arms' && (row[0]! < -1e-6 || (Math.abs(row[0]!) <= 1e-6 && row[2]! < 0))) for (const c of [0, 1, 2, 8, 9, 10]) row[c] = -row[c]!;
        rows.push(row.map((v) => (Math.abs(v) < 5e-4 ? 0 : v).toFixed(3)).join(','));
      }
      if (rows.length) put(mesh.name, rows);
    } else if ((o as Mesh).isMesh && o.name === 'utility-wires') {
      const geometry = (o as Mesh).geometry as InstancedBufferGeometry;
      const data = (geometry.getAttribute('aStart') as InterleavedBufferAttribute).data.array as Float32Array;
      const rows: string[] = [];
      for (let i = 0; i < geometry.instanceCount; i++) rows.push([...data.subarray(i * 8, i * 8 + 8)].map((v) => v.toFixed(3)).join(','));
      if (rows.length) put(o.name, rows);
    }
  });
  return out;
}

function city(): { doc: RoadDoc; net: Network } {
  const doc = layCity(planCity({ ...DEFAULT_CITY, size: 'small' }));
  widenCityFootways(doc);
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  greenCity(doc, net, DEFAULT_CITY.seed);
  if (net.revision !== doc.revision) net.rebuild();
  return { doc, net };
}

const noCache: NearTileCache = { ready: async () => false, get: async () => undefined, put: async () => {} };

describe('a tile\'s poles baked in a worker', () => {
  it('every tile\'s bake together draws the page\'s layer of the whole town, each pole and wire once', async () => {
    const { doc, net } = city();
    expect(doc.poles.size).toBeGreaterThan(50);
    const kit = createSceneryKit();
    const flat = (): number => 0;
    const page = buildUtilities(net, poleGroundAt(buildRoadElevation(net, flat), flat, net), kit);
    // The tiles the town reaches, each baked from the records of the 3 x 3 round it, as a worker bakes it.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of doc.nodes.values()) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
    const product = poleProduct(kit, new Group());
    const bakes = await bakeEveryTile(doc, [x0, y0, x1, y1], 'poles', product.extra!(0)) as PoleBake[];
    const drawn = new Group();
    for (const bake of bakes) drawn.add(PoleLayer.fromBake(kit, bake).group);
    const baked = bakes.length;
    expect(baked).toBeGreaterThan(1);
    expect(picture(drawn)).toEqual(picture(page.group));
    page.dispose();
  });

  it('one job answers every kind asked of a tile, each as its own job would; a bake the page draws comes back as the same, its arrays not sent again', async () => {
    const { doc } = city();
    const kit = createSceneryKit();
    const product = poleProduct(kit, new Group());
    const pole = [...doc.poles.values()][0]!;
    const i = Math.floor(pole.x / TILE), j = Math.floor(pole.y / TILE);
    const tiles = [tileKey(i, j)];
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (di || dj) tiles.push(tileKey(i + di, j + dj));
    const job: NearTileJob = {
      node: `${i},${j}`, prefix: null, ground: { ground: null, naturalIsGround: true },
      asks: [{ kind: 'poles', sig: 'p', want: 'w', shown: null, extra: product.extra!(0) }, { kind: 'signs', sig: 's', want: 'w', shown: null, extra: { markingStyle: 'classic' } }],
      tiles: tiles.map((key) => ({ key, version: 1 })), records: tiles.map((key) => recordsFor(doc.tileRecords(key, 1), ['roads', 'rest'])),
    };
    const both = await runNearJob(job, noCache);
    if (both.kind !== 'near') throw new Error(both.kind);
    expect(both.answers.map((a) => a.kind).sort()).toEqual(['poles', 'signs']);
    for (const ask of job.asks) {
      const alone = await runNearJob({ ...job, asks: [ask] }, noCache);
      if (alone.kind !== 'near') throw new Error(alone.kind);
      expect(both.answers.find((a) => a.kind === ask.kind)).toEqual(alone.answers[0]);
    }
    const again = await runNearJob({ ...job, asks: job.asks.map((ask) => ({ ...ask, shown: (both.answers.find((a) => a.kind === ask.kind) as { bake: string }).bake })) }, noCache);
    expect(again).toMatchObject({ kind: 'near', answers: [{ same: true, payload: null }, { same: true, payload: null }] });
  });
});

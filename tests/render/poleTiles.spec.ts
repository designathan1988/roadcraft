import { describe, expect, it } from 'vitest';
import type { InstancedBufferGeometry, InstancedMesh, InterleavedBufferAttribute, Mesh, Object3D } from 'three';
import { Group } from 'three';
import { Network } from '@world/network';
import { applyLots, planLots } from '@world/lots';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import { greenCity, layCity, widenCityFootways } from '@editor/cityGenerator';
import { buildRoadElevation } from '@world/elevation';
import type { RoadDoc, TileRecords } from '@world/doc';
import { TILE, tileKey } from '@world/tiles';
import { createSceneryKit } from '@render/scenery';
import type { PoleBake } from '@render/poleBake';
import { PoleLayer, buildUtilities } from '@render/poleLayer';
import { poleGroundAt } from '@render/utilities';
import type { NearTileCache } from '@render/nearTileBake';
import { runNearJob as runNearTileJob } from '@render/nearBakers';
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
    // The tiles the town reaches, each as the store keeps it.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of doc.nodes.values()) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
    const i0 = Math.floor(x0 / TILE) - 1, i1 = Math.floor(x1 / TILE) + 1, j0 = Math.floor(y0 / TILE) - 1, j1 = Math.floor(y1 / TILE) + 1;
    const records = new Map<number, TileRecords>();
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) records.set(tileKey(i, j), doc.tileRecords(tileKey(i, j), 1));
    const product = poleProduct(kit, new Group());
    const drawn = new Group();
    let baked = 0;
    for (let i = i0 + 1; i < i1; i++) {
      for (let j = j0 + 1; j < j1; j++) {
        const tiles = [tileKey(i, j)];
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (di || dj) tiles.push(tileKey(i + di, j + dj));
        const reply = await runNearTileJob({
          kind: 'poles', node: `poles:${i},${j}`, sig: 's', want: 'w', shown: null, prefix: null,
          tiles: tiles.map((key) => ({ key, version: 1 })), records: tiles.map((key) => recordsFor(records.get(key)!, ['roads', 'rest'])),
          ground: { ground: null, naturalIsGround: true }, extra: product.extra!(0),
        }, noCache);
        expect(reply.kind).toBe('near');
        if (reply.kind !== 'near' || reply.payload === null) continue;
        baked++;
        drawn.add(PoleLayer.fromBake(kit, reply.payload as PoleBake).group);
      }
    }
    expect(baked).toBeGreaterThan(1);
    expect(picture(drawn)).toEqual(picture(page.group));
    page.dispose();
  });

  it('a bake the page draws comes back as the same, its arrays not sent again', async () => {
    const { doc } = city();
    const kit = createSceneryKit();
    const product = poleProduct(kit, new Group());
    const pole = [...doc.poles.values()][0]!;
    const i = Math.floor(pole.x / TILE), j = Math.floor(pole.y / TILE);
    const key = tileKey(i, j);
    const job = {
      kind: 'poles' as const, node: `poles:${i},${j}`, sig: 's', want: 'w', shown: null, prefix: null,
      tiles: [{ key, version: 1 }], records: [recordsFor(doc.tileRecords(key, 1), ['roads', 'rest'])],
      ground: { ground: null, naturalIsGround: true }, extra: product.extra!(0),
    };
    const first = await runNearTileJob(job, noCache);
    expect(first.kind === 'near' && first.payload).toBeTruthy();
    const again = await runNearTileJob({ ...job, shown: first.kind === 'near' ? first.bake : null }, noCache);
    expect(again).toMatchObject({ kind: 'near', same: true, payload: null });
  });
});

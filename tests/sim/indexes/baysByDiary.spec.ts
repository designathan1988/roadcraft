import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { Rng } from '@core/rng';
import { applyLots, planLots, zoneLots } from '@world/lots';
import type { Building, BuildingId } from '@world/buildings/types';
import { growOnLot } from '@editor/zoning';
import { SimWorld } from '@sim/world';
import { type Bay, collectBays } from '@sim/agents/parking';
import { collectBays as oldCollectBays } from './oracle/parkingOld';

/** THE BAYS KEPT FROM THE DIARY ARE THE BAYS OF THE OLD PASS. */
const strip = (bays: readonly Bay[]): string[] => bays.map(({ id, building, x, y, ox, oy, depth, lane, via, room, kerb }) =>
  [id, building, x, y, ox, oy, depth, room, kerb ? 'k' : '-',
    lane ? `${lane.lanelet}:${lane.at}@${lane.x},${lane.y}>${lane.tx},${lane.ty}:${lane.entryAt ?? '-'}` : 'null',
    via.map((p) => `${p.x},${p.y}`).join(' ')].join('|'));

const PARK = { left: 'parallel', right: 'parallel' } as const;

function town(seed: number): { doc: RoadDoc; net: Network; w: SimWorld } {
  const doc = new RoadDoc();
  const rng = new Rng(seed);
  const a = doc.addNode({ x: m(-260), y: 0 }).id, b = doc.addNode({ x: m(260), y: 0 }).id;
  const c = doc.addNode({ x: 0, y: m(-200) }).id, d = doc.addNode({ x: 0, y: m(200) }).id;
  const e = doc.addNode({ x: m(-260), y: m(160) }).id, f = doc.addNode({ x: m(260), y: m(160) }).id;
  doc.addSegment(a, b, 1, null, 0, 'both', null, 'ground', undefined, PARK);
  doc.addSegment(c, d, 1, null, 0, 'both', null, 'ground', undefined, rng.bool() ? PARK : undefined);
  doc.addSegment(e, f, 1, null, 0, 'both', null, 'ground', undefined, PARK);
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  const zones = [{ use: 'commercial', density: 'low' }, { use: 'residential', density: 'medium' }, { use: 'industrial', density: 'medium' }] as const;
  doc.lots.forEach((l, i) => zoneLots(doc, [l.id], zones[(i + seed) % zones.length]!));
  const w = new SimWorld(doc, net, seed);
  w.rebuildTopology();
  return { doc, net, w };
}

function same(w: SimWorld): number {
  const now = strip(collectBays(w));
  const old = strip(oldCollectBays(w));
  if (now.join('\n') !== old.join('\n')) {
    const i = now.findIndex((x, k) => x !== old[k]);
    expect(now[i], `first difference at ${i} of ${now.length} / ${old.length}`).toBe(old[i]);
  }
  return now.length;
}

describe('the bays kept from the diary', () => {
  for (const seed of [3, 0x5eed]) {
    it(`are the old pass's bays, in its order, through edits (seed ${seed})`, () => {
      const { doc, net, w } = town(seed);
      const rng = new Rng(seed * 7 + 1);
      const refused = new Set<number>();
      const grown: BuildingId[] = [];
      const gone: { id: BuildingId; record: Building }[] = [];
      let kerb = 0, lot = 0;
      for (let k = 0; k < 36; k++) {
        const roll = rng.float();
        if (roll < 0.45 || grown.length < 3) {
          const id = growOnLot({ doc, net, groundAt: () => 0 }, refused, seed + k);
          if (id !== null) grown.push(id as BuildingId);
        } else if (roll < 0.6) {
          // Aged: the record replaced, nothing a bay reads.
          const b = doc.buildings.get(grown[rng.int(0, grown.length - 1)]!);
          if (b) doc.buildings.put({ ...b, decay: (b.decay ?? 0) + 0.05 });
        } else if (roll < 0.7) {
          // Altered: its parking or a gate taken out (the kerb in front may take bays again).
          const b = doc.buildings.get(grown[rng.int(0, grown.length - 1)]!);
          const els = b?.elements ?? [];
          const at = els.findIndex((el) => el.kind === 'parking' || el.kind === 'gate');
          if (b && at >= 0) doc.buildings.put({ ...b, elements: els.filter((_, i) => i !== at) });
        } else if (roll < 0.8) {
          const id = grown.splice(rng.int(0, grown.length - 1), 1)[0]!;
          const record = doc.buildings.get(id);
          if (record) { doc.buildings.remove(id); gone.push({ id, record }); }
        } else if (roll < 0.9 && gone.length) {
          // Put back (an undo): last in the store's order now.
          const { id, record } = gone.shift()!;
          doc.buildings.restore(id, record);
          grown.push(id);
        } else {
          // A road drawn across: the lanes move, every lot is digested again.
          const y = m(rng.range(-150, 150));
          doc.addSegment(doc.addNode({ x: m(-240), y }).id, doc.addNode({ x: m(240), y }).id, 1, null, 0, 'both', null, 'ground', undefined, PARK);
          net.rebuild();
          w.rebuildTopology();
        }
        const bays = collectBays(w);
        kerb = Math.max(kerb, bays.filter((b) => b.kerb).length);
        lot = Math.max(lot, bays.filter((b) => !b.kerb && b.lane).length);
        same(w);
      }
      expect(kerb).toBeGreaterThan(10);
      expect(lot).toBeGreaterThan(10);
    });
  }
});

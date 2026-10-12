import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import type { SegmentId } from '@world/ids';
import { footwayAt, LANDSCAPE_RADIUS, medianAt } from '@world/landscape';
import { streetFurniture } from '@world/streetFurniture';
import { Network } from '@world/network';
import { furnitureFor, NBR9050_CLEAR_WALK } from '@world/roads/furnitureSets';
import { sectionOf, zonesOn } from '@world/section';
import { m } from '@world/units';

/**
 * THE FURNITURE OF A NEW ROAD (docs/VIAS.md V7): placed as the landscaping
 * tool places, on the footway's service strip, never in the clear walk of
 * NBR 9050 (1,20 m), never two pieces in one place, nothing on a footway too
 * narrow to keep the clear walk.
 */
function street(type: number, length = 400): { doc: RoadDoc; net: Network; seg: SegmentId } {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: 0, y: 0 });
  const b = doc.addNode({ x: length, y: 0 });
  const seg = doc.addSegment(a.id, b.id, type)!;
  const net = new Network(doc);
  net.rebuild();
  return { doc, net, seg: seg.id };
}

describe('the furniture of a new road', () => {
  it('complete: lamps on both sides staggered, a hydrant, all on the service strip, none overlapping', () => {
    const { net, seg } = street(1);
    const pieces = furnitureFor(net, [seg], 'complete', []);
    const lamps = pieces.filter((p) => p.kind === 'lamp');
    expect(lamps.length).toBeGreaterThanOrEqual(2 * Math.floor(400 / m(30)) - 2);
    expect(pieces.some((p) => p.kind === 'hydrant')).toBe(true);
    const section = sectionOf(net.ribbons.get(seg)!.road);
    for (const p of pieces) {
      const hit = footwayAt(net, p.at)!;
      expect(hit, p.kind).not.toBeNull();
      const zones = zonesOn(section, hit.side > 0 ? 'left' : 'right');
      // Beside the kerb, leaving 1,20 m clear to the footway's outer edge.
      const outer = Math.max(zones.through.outer, zones.frontage.outer);
      expect(outer - (hit.across + LANDSCAPE_RADIUS[p.kind])).toBeGreaterThanOrEqual(NBR9050_CLEAR_WALK - m(0.25));
    }
    for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) {
      const a = pieces[i]!, b = pieces[j]!;
      expect(Math.hypot(a.at.x - b.at.x, a.at.y - b.at.y)).toBeGreaterThan(LANDSCAPE_RADIUS[a.kind] + LANDSCAPE_RADIUS[b.kind]);
    }
  });

  it('the same roads give the same pieces; none gives nothing; basic is lamps and bins', () => {
    const { net, seg } = street(1);
    expect(furnitureFor(net, [seg], 'complete', [])).toEqual(furnitureFor(net, [seg], 'complete', []));
    expect(furnitureFor(net, [seg], 'none', [])).toEqual([]);
    expect(new Set(furnitureFor(street(3).net, [street(3).seg], 'basic', []).map((p) => p.kind))).toEqual(new Set(['lamp', 'bin']));
  });

  it('on a 2 m footway only the slim pieces go (lamps, hydrants): a bin or a bench would leave under 1,20 m (NBR 9050 6.12.3)', () => {
    const { net, seg } = street(1);
    expect(new Set(furnitureFor(net, [seg], 'complete', []).map((p) => p.kind))).toEqual(new Set(['lamp', 'hydrant']));
    const wide = street(3);
    expect(furnitureFor(wide.net, [wide.seg], 'complete', []).some((p) => p.kind === 'bench' || p.kind === 'bin')).toBe(true);
  });

  it('a boulevard plants its trees in the median, on its centre line, and drawn there; its footways keep clear of trees', () => {
    const { doc, net, seg } = street(3);
    const pieces = furnitureFor(net, [seg], 'complete', []);
    const trees = pieces.filter((p) => p.kind === 'tree');
    expect(trees.length).toBeGreaterThan(10);
    for (const t of trees) {
      expect(footwayAt(net, t.at)).toBeNull();
      expect(medianAt(net, t.at)).not.toBeNull();
    }
    for (const p of pieces) doc.addLandscape(p.kind, p.at);
    const drawn = streetFurniture(net).filter((i) => i.kind === 'streetTree');
    expect(drawn.length).toBe(trees.length);
    expect(drawn.every((i) => i.on === 'median')).toBe(true);
  });
});

describe('the furniture catalogue', () => {
  it('every piece once, named in both languages, the sets read from it', async () => {
    const { FURNITURE_CATALOG } = await import('@world/roads/furnitureCatalog');
    const { PT_BR: pt } = await import('@ui/i18n/pt-BR');
    const { EN: en } = await import('@ui/i18n/en');
    expect(new Set(FURNITURE_CATALOG.map((e) => e.kind)).size).toBe(FURNITURE_CATALOG.length);
    for (const e of FURNITURE_CATALOG) {
      expect((pt as Record<string, string>)[e.nameKey], e.nameKey).toBeTruthy();
      expect((en as Record<string, string>)[e.nameKey], e.nameKey).toBeTruthy();
      expect(e.every).toBeGreaterThan(0);
    }
  });
});

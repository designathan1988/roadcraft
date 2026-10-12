import { describe, expect, it } from 'vitest';

import { applyProfileTo } from '@editor/roads/profile';
import { RoadDoc } from '@world/doc';
import { profileOf } from '@world/roads/profile';
import { flipProfile, streetChain } from '@world/roads/streetChain';

/**
 * THE WHOLE STREET (docs/VIAS.md V8, bulk edit): straight on through the
 * junctions, a stretch drawn the other way known as such, and a profile
 * copied along it keeps its sides in the world (the parking stays on the
 * same kerb), never mirrored on a stretch drawn backwards.
 */
function street() {
  const doc = new RoadDoc();
  const n = [0, 100, 200, 300].map((x) => doc.addNode({ x, y: 0 }).id);
  const side = doc.addNode({ x: 100, y: 120 }).id;
  const s1 = doc.addSegment(n[0]!, n[1]!, 1)!.id;
  const s2 = doc.addSegment(n[2]!, n[1]!, 1)!.id; // drawn backwards
  const s3 = doc.addSegment(n[2]!, n[3]!, 1)!.id;
  const cross = doc.addSegment(n[1]!, side, 1)!.id;
  return { doc, s1, s2, s3, cross };
}

describe('the whole street', () => {
  it('runs straight through the junction, not round the corner, and knows the stretch drawn backwards', () => {
    const { doc, s1, s2, s3, cross } = street();
    const chain = streetChain(doc, s1);
    expect(chain.map((p) => p.id).sort()).toEqual([s1, s2, s3].sort());
    expect(chain.find((p) => p.id === s2)!.flipped).toBe(true);
    expect(chain.find((p) => p.id === s3)!.flipped).toBe(false);
    expect(chain.some((p) => p.id === cross)).toBe(false);
  });

  it('a profile flipped twice is itself; copied along, the parking stays on the same kerb in the world', () => {
    const { doc, s1, s2 } = street();
    doc.setSegmentParking(s1, { left: 'none', right: 'parallel' });
    const profile = profileOf(doc.segment(s1)!);
    expect(flipProfile(flipProfile(profile))).toEqual(profile);
    for (const piece of streetChain(doc, s1)) {
      if (piece.id !== s1) applyProfileTo(doc, [piece.id], piece.flipped ? flipProfile(profile) : profile);
    }
    // s1 runs east with parking on its right (south); s2 runs west: parking on its LEFT is south.
    expect(doc.segment(s2)!.parking).toEqual({ left: 'parallel', right: 'none' });
  });
});

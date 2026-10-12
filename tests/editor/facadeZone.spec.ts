import { describe, expect, it } from 'vitest';
import { opSetComponentZone } from '@editor/buildings';
import { Model } from '@world/buildings/cityBuildings';
import { componentAt, type Building } from '@world/buildings/types';

function tower(): Building {
  const body = new Model('office', 'commercial', 0).block({ x: 0, y: 0, w: 24, d: 12, storeys: 8, fill: 'window' }).build();
  return { ...body, id: 1, x: 0, y: 0, rotation: 0 } as Building;
}

describe('facade zone', () => {
  it('sets every bay of the dragged rectangle, in either drag direction, and nothing else', () => {
    const b = tower();
    const v = b.volumes[0]!;
    // Dragged from the top right down to the bottom left: floors 2-5, bays 1-3 of the front.
    expect(opSetComponentZone(b, v.id, 0, 5, 2, 3, 1, 'wall')).toBe(true);
    for (let s = 0; s < v.storeys.length; s++) {
      for (let i = 0; i < 8; i++) {
        const inside = s >= 2 && s <= 5 && i >= 1 && i <= 3;
        expect(componentAt(v.storeys[s]!.facade, 0, i), `floor ${s} bay ${i}`).toBe(inside ? 'wall' : 'window');
      }
      // The other sides untouched.
      expect(componentAt(v.storeys[s]!.facade, 1, 0)).toBe('window');
    }
  });

  it('reports no change when the zone already holds the component', () => {
    const b = tower();
    const v = b.volumes[0]!;
    expect(opSetComponentZone(b, v.id, 0, 0, 7, 0, 7, 'window')).toBe(false);
  });
});

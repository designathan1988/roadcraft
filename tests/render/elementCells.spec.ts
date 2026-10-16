import { describe, expect, it } from 'vitest';
import { BoxGeometry, MeshStandardMaterial, Vector3 } from 'three';

import { keepCellAt, keepCellRect } from '@render/cellKeeps';
import { createElementLayer, type ElementKit, type ElementSource } from '@render/elements';
import type { Exhaust } from '@render/exhaust';
import type { ChangeRect } from '@world/changes';
import type { ElementItem, ElementKind } from '@world/elements';

const geometry = new BoxGeometry(1, 1, 1);
geometry.computeBoundingSphere();
const material = new MeshStandardMaterial();
const part = { geometry, material };
/** Two prop kinds, two variants of one part each: no files read. */
const kit: ElementKit = {
  models: new Map<ElementKind, { geometry: BoxGeometry; material: MeshStandardMaterial }[][]>([['stones', [[part], [part]]], ['grass', [[part], [part]]]]),
  dispose() {},
};

/** A document's elements, counting what a sync reads of them. */
function sourceOf(items: ElementItem[]): ElementSource & { read: number; wholeReads: number } {
  const source = {
    read: 0,
    wholeReads: 0,
    get elements(): readonly ElementItem[] { source.wholeReads++; source.read += items.length; return items; },
    elementsIn(rect: ChangeRect): ElementItem[] {
      const found = items.filter((e) => e.x >= rect[0] - 1 && e.x <= rect[2] + 1 && e.y >= rect[1] - 1 && e.y <= rect[3] + 1);
      source.read += found.length;
      return found;
    },
  };
  return source;
}

/** `cells` cells along a row, ten stones in each. */
const row = (cells: number): ElementItem[] => Array.from({ length: cells * 10 }, (_, k) => ({
  kind: 'stones' as const, x: Math.floor(k / 10) * 64 + 5 + (k % 10) * 5, y: 10, size: 1, yaw: 0, seed: (k % 7) / 7,
}));

const flat = (): number => 0;

/** THE ELEMENTS KEPT CELL BY CELL (`elements.ts` `createElementLayer`): a dab lays its own cells again, never the map's */
describe('the elements kept cell by cell', () => {
  it('builds the whole map once, then reads only the cells a change reaches', () => {
    const work = (cells: number): number => {
      const items = row(cells);
      const source = sourceOf(items);
      const layer = createElementLayer(kit);
      expect(layer.sync(null, source, flat)).toBe(true);
      expect(source.wholeReads).toBe(1);
      // One stone laid in the middle cell.
      const at = { kind: 'stones' as const, x: Math.floor(cells / 2) * 64 + 33, y: 40, size: 1, yaw: 0, seed: 0.5 };
      items.push(at);
      source.read = 0;
      expect(layer.sync(new Set([keepCellAt(at.x, at.y)]), source, flat)).toBe(true);
      expect(source.wholeReads).toBe(1);
      layer.dispose();
      return source.read;
    };
    expect(work(4)).toBe(11);
    expect(work(3_000)).toBe(11);
  });

  it('lets a cell emptied go, and keeps the others', () => {
    const items = row(3);
    const source = sourceOf(items);
    const layer = createElementLayer(kit);
    layer.sync(null, source, flat);
    const key = keepCellAt(items[10]!.x, items[10]!.y);
    items.splice(10, 10);
    expect(layer.sync(new Set([key]), source, flat)).toBe(true);
    expect(source.elementsIn(keepCellRect(key)).length).toBe(0);
    layer.dispose();
  });

  it('gives off an effect\'s particles near the eye only', () => {
    const near = { kind: 'smoke' as const, x: 100, y: 100, size: 4, yaw: 0, seed: 0, intensity: 1 };
    const far = { kind: 'fire' as const, x: 4000, y: -4000, size: 4, yaw: 0, seed: 0, intensity: 1 };
    const source = sourceOf([near, far]);
    const layer = createElementLayer(kit);
    layer.sync(null, source, flat);
    expect(layer.hasEffects).toBe(true);
    const bursts: number[] = [];
    const exhaust = { burst: (x: number) => { bursts.push(x); } } as unknown as Exhaust;
    // The eye over the near one (three's z is -y).
    layer.emit(1, new Vector3(100, 50, -100), exhaust);
    expect(bursts.length).toBeGreaterThan(0);
    expect(bursts.every((x) => x === near.x)).toBe(true);
    layer.dispose();
  });
});

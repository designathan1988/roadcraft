import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignSheets } from '@render/signs';

/**
 * The street-name plates' pictures: every one on a sheet of a size every
 * graphics card takes. WebGL 2 guarantees 2048 and every device reports at
 * least 4096 (web3dsurvey.com, MAX_TEXTURE_SIZE); a canvas past its browser's
 * limit is unusable (MDN, `<canvas>`, "Maximum canvas size").
 */
const LIMIT = 4096;

/** A canvas without a page: the sizes it is given, and a 2D context that draws nothing. */
function fakeCanvas(): { width: number; height: number; getContext: () => unknown } {
  const context: unknown = new Proxy({}, {
    get: (_target, key) => key === 'measureText' ? () => ({ width: 0 }) : () => {},
    set: () => true,
  });
  return { width: 0, height: 0, getContext: () => context };
}

describe('the sheets of the sign plates', () => {
  beforeAll(() => { vi.stubGlobal('document', { createElement: () => fakeCanvas() }); });
  afterAll(() => { vi.unstubAllGlobals(); });

  it('hold any number of street names on sheets no larger than every card takes', () => {
    const sheets = new SignSheets();
    sheets.begin();
    const names = 1500;
    const places = new Set<string>();
    const sheetIds = new Map<unknown, number>();
    for (let i = 0; i < names; i++) {
      const place = sheets.plateCell('street', `Rua ${i}`) as { readonly cell: number; readonly sheet?: unknown };
      if (!sheetIds.has(place.sheet)) sheetIds.set(place.sheet, sheetIds.size);
      places.add(`${sheetIds.get(place.sheet)}:${place.cell}`);
    }
    // Each name in a cell of its own.
    expect(places.size).toBe(names);
    for (const sheet of sheets.sizes()) {
      expect(sheet.width).toBeLessThanOrEqual(LIMIT);
      expect(sheet.height).toBeLessThanOrEqual(LIMIT);
    }
  });
});

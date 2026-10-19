import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignSheets } from '@render/signs';

/** The street-name plates' pictures: every one on a sheet of a size every graphics card takes. */
const LIMIT = 4096;

/** Pictures drawn onto a canvas (`drawImage`), counted. */
let drawn = 0;

/** A canvas without a page: the sizes it is given, and a 2D context that draws nothing. */
function fakeCanvas(): { width: number; height: number; getContext: () => unknown } {
  const context: unknown = new Proxy({}, {
    get: (_target, key) => key === 'measureText' ? () => ({ width: 0 }) : key === 'drawImage' ? () => { drawn++; } : () => {},
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

  it('sends a new plate onto a sheet already on the GPU as its cell alone, where the whole painting puts it, and clears a cell let go (VIA-04)', () => {
    const copies: { x: number; y: number }[] = [];
    const sheets = new SignSheets(undefined, (_picture, _sheet, x, y) => { copies.push({ x, y }); });
    const a = sheets.take('street', 'Rua A');
    sheets.flush();
    // The first painting: the sheet whole, no cell copied.
    expect(copies).toEqual([]);
    const texture = a.sheet.texture;
    texture.onUpdate?.(texture);
    const version = texture.version;
    drawn = 0;
    const b = sheets.take('street', 'Rua B');
    sheets.flush();
    // One plate drawn and sent alone: the sheet neither painted again nor sent whole.
    expect(drawn).toBe(1);
    expect(texture.version).toBe(version);
    expect(copies.length).toBe(1);
    const sheet = b.sheet, pitch = sheet.cellHeight + 2 * 8;
    expect(copies[0]).toEqual({ x: (b.cell % 8) * (256 + 16), y: sheet.height - Math.floor(b.cell / 8) * pitch - pitch });
    // A plate let go: its cell cleared at the next flush (as a whole painting leaves it), nothing drawn in it.
    sheets.drop('street', 'Rua B');
    sheets.take('street', 'Rua C');
    copies.length = 0;
    drawn = 0;
    sheets.flush();
    // B's cell cleared and C drawn in its own (the next free one): two cells sent, one plate drawn.
    expect(copies.length).toBe(2);
    expect(drawn).toBe(1);
  });

  it('lets a sheet\'s canvas go once uploaded, and paints it again from its plates when the context comes back', () => {
    drawn = 0;
    const sheets = new SignSheets();
    const a = sheets.take('street', 'Rua A');
    sheets.take('street', 'Rua B');
    // Nothing painted onto the sheet before the flush.
    expect(drawn).toBe(0);
    sheets.flush();
    expect(drawn).toBe(2);
    const texture = a.sheet.texture;
    const canvas = texture.image as { width: number; height: number };
    expect(canvas.width).toBe(a.sheet.width);
    // three uploaded it: the canvas holds nothing more, the sheet keeps its size for the uv.
    texture.onUpdate!(texture);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(sheets.sizes()[0]).toEqual({ width: a.sheet.width, height: a.sheet.height });
    // A flush with nothing new paints nothing.
    sheets.flush();
    expect(drawn).toBe(2);
    // A plate let go is not painted again.
    sheets.drop('street', 'Rua B');
    sheets.refill();
    expect(drawn).toBe(3);
    expect(canvas.width).toBe(a.sheet.width);
    expect(canvas.height).toBe(a.sheet.height);
    expect(texture.version).toBeGreaterThan(1);
  });
});

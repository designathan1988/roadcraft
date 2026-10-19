import { describe, expect, it } from 'vitest';
import { Vector2 } from 'three';
import { screenSizer, type DrawingBuffer } from '@render/screenSize';

/** The screen sized once for each size and ratio (RND-13): the drawing buffer and the screen's targets made again only when either changed */

/** A drawing buffer as three's: `setPixelRatio` sizes it again (three calls `setSize`), and every sizing makes the buffer again. */
function buffer() {
  let width = 0, height = 0, ratio = 1;
  const gl = {
    made: 0,
    getSize: (v: Vector2) => v.set(width, height),
    getPixelRatio: () => ratio,
    setDrawingBufferSize(w: number, h: number, r: number) { width = w; height = h; ratio = r; gl.made++; },
    setPixelRatio(r: number) { ratio = r; gl.made++; },
  };
  return gl satisfies DrawingBuffer;
}

describe('the screen\'s size', () => {
  it('is made once for a size and kept while the window and the frame both ask for it', () => {
    const gl = buffer();
    const fits: number[][] = [];
    const size = screenSizer(gl, () => 2, (w, h, r, whole) => fits.push([w, h, r, whole]));
    const chain = {};
    size(1280, 720, 2, chain);
    expect(gl.made).toBe(1);
    // The window's resize event, then the next frame: nothing made again.
    size(1280, 720, 2, chain);
    size(1280, 720, 2, chain);
    expect(gl.made).toBe(1);
    expect(fits.length).toBe(1);
    // Dragged wider: once.
    size(1300, 720, 2, chain);
    expect(gl.made).toBe(2);
    expect(fits.length).toBe(2);
  });

  it('takes a new ratio with one drawing buffer, not two', () => {
    const gl = buffer();
    const size = screenSizer(gl, () => 2, () => {});
    const chain = {};
    size(1280, 720, 2, chain);
    gl.made = 0;
    // The dynamic resolution's step
    size(1280, 720, 1.6, chain);
    expect(gl.made).toBe(1);
    // A tier whose ratio three was given already (`setPixelRatio`): the buffer it made is kept.
    gl.setPixelRatio(1.2);
    gl.made = 0;
    size(1280, 720, 1.2, chain);
    expect(gl.made).toBe(0);
  });

  it('fits a new chain at the same size, without a new drawing buffer', () => {
    const gl = buffer();
    let fits = 0;
    const size = screenSizer(gl, () => 1, () => { fits++; });
    size(800, 600, 1, {});
    size(800, 600, 1, {});
    expect(fits).toBe(2);
    expect(gl.made).toBe(1);
  });

  it('gives the pixels at the whole ratio, whatever share of it is drawn', () => {
    const gl = buffer();
    const wholes: number[] = [];
    const size = screenSizer(gl, () => 2, (_w, _h, _r, whole) => wholes.push(whole));
    const chain = {};
    size(1000, 500, 2, chain);
    size(1000, 500, 1.4, chain);
    size(1000, 500, 1, chain);
    expect(wholes).toEqual([2000 * 1000, 2000 * 1000, 2000 * 1000]);
  });
});

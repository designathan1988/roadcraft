import { Vector2 } from 'three';

/** The renderer's drawing buffer as `screenSizer` sizes it (three's `WebGLRenderer`). */
export interface DrawingBuffer {
  getSize(target: Vector2): Vector2;
  getPixelRatio(): number;
  setDrawingBufferSize(width: number, height: number, pixelRatio: number): void;
}

/**
 * The screen sized for the canvas's CSS pixels and a pixel ratio: the drawing buffer made once (three's
 * `setPixelRatio` and `setSize` each make one), and none, nor the screen's targets (`fit`), when what it was
 * sized for has not changed. `chain`: what the targets belong to (the post chain): a new one is fitted even at
 * the same size. `fit` is also given the pixels at the whole ratio, for what must not follow the dynamic
 * resolution's share (the GPU's cap, `gpuLedger.ts`).
 */
export function screenSizer(gl: DrawingBuffer, whole: () => number,
  fit: (width: number, height: number, ratio: number, wholePixels: number) => void): (width: number, height: number, ratio: number, chain: object) => void {
  let chainFor: object | null = null;
  let widthFor = 0, heightFor = 0, ratioFor = 0;
  const size = new Vector2();
  return (width, height, ratio, chain) => {
    if (chain === chainFor && width === widthFor && height === heightFor && ratio === ratioFor) return;
    gl.getSize(size);
    if (size.x !== width || size.y !== height || gl.getPixelRatio() !== ratio) gl.setDrawingBufferSize(width, height, ratio);
    const r = whole();
    fit(width, height, ratio, Math.floor(width * r) * Math.floor(height * r));
    chainFor = chain;
    widthFor = width;
    heightFor = height;
    ratioFor = ratio;
  };
}

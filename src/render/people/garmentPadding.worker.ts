import { padGarmentPixels, type GarmentPadRequest, type GarmentPadResponse } from './garmentPadding';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<GarmentPadRequest>) => void) | null;
  postMessage(message: GarmentPadResponse, transfer?: Transferable[]): void;
};

/**
 * The texture's pixels, read here when the request names its file: fetched,
 * decoded (`createImageBitmap`) and read back through an OffscreenCanvas, all
 * off the frame. On the page, the draw into a canvas, `getImageData` and
 * `putImageData` of a 2048-pixel sheet were a 100-220 ms task each time a
 * garment came into view.
 */
async function pixelsOf(data: GarmentPadRequest): Promise<{ pixels: Uint8ClampedArray; width: number; height: number }> {
  if (data.pixels) return { pixels: data.pixels, width: data.width, height: data.height };
  const bitmap = await createImageBitmap(await (await fetch(data.url!)).blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2d context in the worker');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { pixels: image.data, width: canvas.width, height: canvas.height };
}

scope.onmessage = ({ data }) => {
  pixelsOf(data).then(({ pixels, width, height }) => {
    padGarmentPixels(pixels, width, height, data.uvs, data.index, data.padding);
    scope.postMessage({ id: data.id, pixels, width, height }, [pixels.buffer as ArrayBuffer]);
  }).catch((error: unknown) => {
    scope.postMessage({ id: data.id, error: String(error) });
  });
};

/**
 * A sheet to pad: its pixels, or - `pixels` absent - the file the worker
 * fetches and decodes itself (`createImageBitmap` and an OffscreenCanvas, both
 * there in a worker), so no pixel of it passes through the page.
 */
export interface GarmentPadRequest {
  readonly id: number;
  readonly pixels?: Uint8ClampedArray;
  readonly url?: string;
  readonly width: number;
  readonly height: number;
  readonly uvs: Float32Array;
  readonly index: Uint32Array;
  readonly padding: number;
}

export interface GarmentPadResponse {
  readonly id: number;
  readonly pixels?: Uint8ClampedArray;
  /** The sheet's size (what the worker decoded, for a request by file). */
  readonly width?: number;
  readonly height?: number;
  readonly error?: string;
}

/** Grows the garment's UV islands into their mipmap gutters, in place. */
export function padGarmentPixels(
  px: Uint8ClampedArray,
  W: number,
  H: number,
  uvs: Float32Array,
  idx: Uint32Array,
  padding: number,
): void {
  // The islands: every UV triangle, a little fat so its edge pixels count.
  const inside = new Uint8Array(W * H);
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = idx[i]!, b = idx[i + 1]!, c = idx[i + 2]!;
    const ax = uvs[a * 2]! * W, ay = uvs[a * 2 + 1]! * H;
    const bx = uvs[b * 2]! * W, by = uvs[b * 2 + 1]! * H;
    const cx = uvs[c * 2]! * W, cy = uvs[c * 2 + 1]! * H;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)) - 1), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)) + 1);
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)) - 1), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)) + 1);
    const slack = 0.75 * Math.abs(area) / Math.max(Math.hypot(bx - ax, by - ay), Math.hypot(cx - bx, cy - by), Math.hypot(ax - cx, ay - cy));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px0 = x + 0.5, py0 = y + 0.5;
        const w0 = ((bx - px0) * (cy - py0) - (by - py0) * (cx - px0)) / area;
        const w1 = ((cx - px0) * (ay - py0) - (cy - py0) * (ax - px0)) / area;
        const w2 = 1 - w0 - w1;
        const tol = slack / Math.abs(area);
        if (w0 >= -tol && w1 >= -tol && w2 >= -tol) inside[y * W + x] = 1;
      }
    }
  }
  // Grow the islands a ring at a time: each new pixel the mean of its
  // neighbours already inside.
  let ring: number[] = [];
  for (let p = 0; p < W * H; p++) {
    if (!inside[p]) continue;
    const x = p % W, y = (p - x) / W;
    if ((x > 0 && !inside[p - 1]) || (x < W - 1 && !inside[p + 1])
      || (y > 0 && !inside[p - W]) || (y < H - 1 && !inside[p + W])) ring.push(p);
  }
  for (let step = 0; step < padding && ring.length; step++) {
    const next: number[] = [];
    for (const p of ring) {
      const x = p % W, y = (p - x) / W;
      for (let side = 0; side < 4; side++) {
        const q = side === 0 ? (x > 0 ? p - 1 : -1)
          : side === 1 ? (x < W - 1 ? p + 1 : -1)
            : side === 2 ? (y > 0 ? p - W : -1)
              : (y < H - 1 ? p + W : -1);
        if (q < 0 || inside[q]) continue;
        let r = 0, g = 0, bl = 0, n = 0;
        const qx = side === 0 ? x - 1 : side === 1 ? x + 1 : x;
        const qy = side === 2 ? y - 1 : side === 3 ? y + 1 : y;
        if (qx > 0 && inside[q - 1]) {
          const o = (q - 1) * 4;
          r += px[o]!; g += px[o + 1]!; bl += px[o + 2]!; n++;
        }
        if (qx < W - 1 && inside[q + 1]) {
          const o = (q + 1) * 4;
          r += px[o]!; g += px[o + 1]!; bl += px[o + 2]!; n++;
        }
        if (qy > 0 && inside[q - W]) {
          const o = (q - W) * 4;
          r += px[o]!; g += px[o + 1]!; bl += px[o + 2]!; n++;
        }
        if (qy < H - 1 && inside[q + W]) {
          const o = (q + W) * 4;
          r += px[o]!; g += px[o + 1]!; bl += px[o + 2]!; n++;
        }
        if (!n) continue;
        px[q * 4] = r / n; px[q * 4 + 1] = g / n; px[q * 4 + 2] = bl / n;
        inside[q] = 2;
        next.push(q);
      }
    }
    for (const q of next) inside[q] = 1;
    ring = next;
  }
}

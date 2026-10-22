// THE PICTURE MEASURED, NOT LOOKED AT: the game's frame against the same frame rendered at twice the resolution each way and filtered down
// (a 4-sample supersampled reference of the same scene), pixel by pixel in OKLab (HyAB distance, the same measure `scripts/look-compare.mjs`
// uses): what differs is what the frame loses at 1 sample a pixel - jagged and crawling edges, sub-pixel detail that flickers. And the
// picture's own figures (lightness, contrast, colourfulness, crushed blacks and clipped whites) to catch a washed-out or murky look.

// `comparePictures` runs in the page (page.evaluate), not in node.
export async function comparePictures({ frame, reference, threshold }) {
  const load = (src) => new Promise((done, fail) => { const img = new Image(); img.onload = () => done(img); img.onerror = fail; img.src = src; });
  const [ia, ib] = await Promise.all([load(frame), load(reference)]);
  if (ia.width !== ib.width || ia.height !== ib.height) return { error: `different sizes: ${ia.width}x${ia.height} and ${ib.width}x${ib.height}` };
  const w = ia.width, h = ia.height;
  const pixels = (img) => {
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    return g.getImageData(0, 0, w, h).data;
  };
  const pa = pixels(ia), pb = pixels(ib);
  // sRGB 0-255 to OKLab (Björn Ottosson, "A perceptual color space for image processing").
  const lin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const oklab = (r, g, bl) => {
    const R = lin(r), G = lin(g), B = lin(bl);
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  };
  const figures = () => ({ n: 0, l: 0, l2: 0, chroma: 0, dark: 0, bright: 0 });
  const fa = figures(), fb = figures();
  const add = (f, [l, a, b]) => { f.n++; f.l += l; f.l2 += l * l; f.chroma += Math.hypot(a, b); if (l < 0.08) f.dark++; if (l > 0.97) f.bright++; };
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d');
  const view = g.createImageData(w, h);
  const d = view.data;
  let over = 0, sum = 0;
  for (let i = 0; i < pa.length; i += 4) {
    const A = oklab(pa[i], pa[i + 1], pa[i + 2]);
    const B = oklab(pb[i], pb[i + 1], pb[i + 2]);
    add(fa, A);
    add(fb, B);
    const e = Math.abs(A[0] - B[0]) + Math.hypot(A[1] - B[1], A[2] - B[2]);
    sum += e;
    if (e > threshold) {
      over++;
      d[i] = 255; d[i + 1] = Math.max(0, 255 - Math.round(e * 1200)); d[i + 2] = 0; d[i + 3] = 255;
    } else {
      // The frame, faded, so the marks read.
      const grey = 255 - (255 - (pa[i] * 0.3 + pa[i + 1] * 0.59 + pa[i + 2] * 0.11)) * 0.15;
      d[i] = d[i + 1] = d[i + 2] = grey; d[i + 3] = 255;
    }
  }
  g.putImageData(view, 0, 0);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const png = await new Promise((done) => { const r = new FileReader(); r.onload = () => done(r.result); r.readAsDataURL(blob); });
  const summary = (f) => {
    const mean = f.l / f.n;
    return { lightness: +mean.toFixed(4), contrast: +Math.sqrt(Math.max(0, f.l2 / f.n - mean * mean)).toFixed(4), chroma: +(f.chroma / f.n).toFixed(4), darkShare: +(f.dark / f.n).toFixed(4), brightShare: +(f.bright / f.n).toFixed(4) };
  };
  return { width: w, height: h, overShare: over / (w * h), meanError: sum / (w * h), frame: summary(fa), reference: summary(fb), png };
}

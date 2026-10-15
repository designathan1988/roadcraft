// COMPARE TWO RUNS OF THE SAME SCRIPT OF VIEWS, picture by picture (scripts/look.mjs)
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

/** HyAB distance in OKLab past which a pixel is changed (pixelmatch's default 0.1, on its scale). */
const THRESHOLD = 0.1;

const [a, b, outArg] = process.argv.slice(2);
if (!a || !b) {
  console.error('uso: node scripts/look-compare.mjs <pasta antes> <pasta depois> [pasta de saída]');
  process.exit(2);
}
const before = resolve(a), after = resolve(b);
const out = resolve(outArg ?? join(after, 'comparacao'));
mkdirSync(out, { recursive: true });
const names = readdirSync(before).filter((n) => n.endsWith('.png') && readdirSync(after).includes(n)).sort();
if (!names.length) {
  console.error(`nenhuma foto de mesmo nome em ${before} e ${after}`);
  process.exit(2);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const rows = [];
try {
  for (const name of names) {
    const data = (dir) => `data:image/png;base64,${readFileSync(join(dir, name)).toString('base64')}`;
    const result = await page.evaluate(compare, { a: data(before), b: data(after), threshold: THRESHOLD });
    if (result.error) { rows.push({ name, error: result.error }); continue; }
    const diff = join(out, name.replace(/\.png$/, '-diferenca.png'));
    writeFileSync(diff, Buffer.from(result.png.split(',')[1], 'base64'));
    rows.push({ name, changed: result.changed, share: result.changed / result.pixels, box: result.box, diff });
  }
} finally {
  await browser.close();
}
writeFileSync(join(out, 'comparacao.json'), JSON.stringify(rows, null, 2));
for (const r of rows) {
  if (r.error) { console.log(`${r.name}: ${r.error}`); continue; }
  const pct = (r.share * 100).toFixed(3).padStart(8);
  console.log(`${pct} %  ${String(r.changed).padStart(8)} px  ${r.box ? `caixa ${r.box.join(',')}` : 'iguais'}  ${r.name}`);
}
console.log(`diferenças: ${out}`);

/* global Image, OffscreenCanvas, FileReader -- `compare` runs in the page (page.evaluate), not in node. */
/** In the page: both pictures decoded on canvases, compared, and the difference drawn. */
async function compare({ a, b, threshold }) {
  const load = (src) => new Promise((done, fail) => { const img = new Image(); img.onload = () => done(img); img.onerror = fail; img.src = src; });
  const [ia, ib] = await Promise.all([load(a), load(b)]);
  if (ia.width !== ib.width || ia.height !== ib.height) return { error: `tamanhos diferentes: ${ia.width}x${ia.height} e ${ib.width}x${ib.height}` };
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
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d');
  const view = g.createImageData(w, h);
  const d = view.data;
  let changed = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let i = 0; i < pa.length; i += 4) {
    let differs = false;
    if (pa[i] !== pb[i] || pa[i + 1] !== pb[i + 1] || pa[i + 2] !== pb[i + 2]) {
      const [l1, a1, b1] = oklab(pa[i], pa[i + 1], pa[i + 2]);
      const [l2, a2, b2] = oklab(pb[i], pb[i + 1], pb[i + 2]);
      // HyAB: the lightness difference plus the chroma distance.
      differs = Math.abs(l1 - l2) + Math.hypot(a1 - a2, b1 - b2) > threshold;
    }
    if (differs) {
      changed++;
      const p = i / 4, x = p % w, y = (p - x) / w;
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
      d[i] = 255; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 255;
    } else {
      // The "before", faded, so the red reads.
      const grey = 255 - (255 - (pa[i] * 0.3 + pa[i + 1] * 0.59 + pa[i + 2] * 0.11)) * 0.15;
      d[i] = d[i + 1] = d[i + 2] = grey; d[i + 3] = 255;
    }
  }
  g.putImageData(view, 0, 0);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const png = await new Promise((done) => { const r = new FileReader(); r.onload = () => done(r.result); r.readAsDataURL(blob); });
  return { changed, pixels: w * h, box: changed ? [x0, y0, x1, y1] : null, png };
}

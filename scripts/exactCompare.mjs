// TWO FOLDERS OF SHOTS COMPARED EXACTLY: the pixels whose RGBA differ at all, the most a channel moved, and their box (`strokeShots.mjs`).
// Usage: node scripts/exactCompare.mjs <a.png> <b.png> [diff.png]
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const [a, b, diff] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const url = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;
const r = await page.evaluate(async ({ a, b }) => {
  const pixels = async (src) => {
    const bitmap = await createImageBitmap(await (await fetch(src)).blob());
    const c = new OffscreenCanvas(bitmap.width, bitmap.height), g = c.getContext('2d');
    g.drawImage(bitmap, 0, 0);
    return { d: g.getImageData(0, 0, bitmap.width, bitmap.height).data, w: bitmap.width, h: bitmap.height };
  };
  const A = await pixels(a), B = await pixels(b);
  if (A.w !== B.w || A.h !== B.h) return { error: 'sizes differ' };
  const list = [];
  let changed = 0, most = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  const out = new OffscreenCanvas(A.w, A.h), g = out.getContext('2d'), img = g.createImageData(A.w, A.h);
  for (let i = 0; i < A.w * A.h; i++) {
    let m = 0;
    for (let c = 0; c < 4; c++) m = Math.max(m, Math.abs(A.d[i * 4 + c] - B.d[i * 4 + c]));
    const v = A.d[i * 4] * 0.3 + A.d[i * 4 + 1] * 0.6 + A.d[i * 4 + 2] * 0.1;
    img.data[i * 4] = m ? 255 : v * 0.35; img.data[i * 4 + 1] = m ? 0 : v * 0.35; img.data[i * 4 + 2] = m ? 255 : v * 0.35; img.data[i * 4 + 3] = 255;
    if (!m) continue;
    changed++; most = Math.max(most, m);
    if (list.length < 40) list.push(`${i % A.w},${Math.floor(i / A.w)}:${[0, 1, 2].map((c) => A.d[i * 4 + c]).join('/')}>${[0, 1, 2].map((c) => B.d[i * 4 + c]).join('/')}`);
    const x = i % A.w, y = Math.floor(i / A.w);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  g.putImageData(img, 0, 0);
  const blob = await out.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = ''; for (const byte of bytes) s += String.fromCharCode(byte);
  return { list, changed, most, box: changed ? [x0, y0, x1, y1] : null, png: btoa(s), pixels: A.w * A.h };
}, { a: url(a), b: url(b) });
await browser.close();
if (r.error) { console.log(r.error); process.exit(1); }
if (diff) writeFileSync(diff, Buffer.from(r.png, 'base64'));
if (r.changed && r.changed <= 40) console.log(`  pixels (x,y: antes > depois): ${r.list.join('  ')}`);
console.log(`${String(r.changed).padStart(8)} px diferentes de ${r.pixels}, maior diferença ${r.most}/255${r.box ? `, caixa ${r.box.join(',')}` : ''}  ${a} x ${b}`);

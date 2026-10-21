// Bakes the Person Creator lab's choice pictures (`people-lab.html`): each choice drawn once on the mannequin and written to `src/peopleLab/pics/<hash>.webp`,
// so the lab never draws a picture in the browser. Needs the dev server (`npm run dev`). Usage: node scripts/bake-people-pics.mjs [--base=http://127.0.0.1:5300]
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const base = process.argv.find((a) => a.startsWith('--base='))?.slice(7) ?? 'http://127.0.0.1:5300';
const out = path.resolve('src/peopleLab/pics');
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('page:', e.message));
await page.goto(`${base}/people-lab.html`);
await page.waitForFunction(() => globalThis.peopleLab?.built, null, { timeout: 120000 });
const started = Date.now();
const pics = await page.evaluate(() => globalThis.peopleLab.bakePictures());
if (!pics.length) throw new Error('No picture was drawn: nothing written, nothing removed');
fs.mkdirSync(out, { recursive: true });
const keep = new Set(pics.map(([name]) => name));
for (const file of fs.readdirSync(out)) if (file.endsWith('.webp') && !keep.has(file)) fs.unlinkSync(path.join(out, file));
let bytes = 0;
for (const [name, src] of pics) {
  const data = Buffer.from(src.split(',')[1], 'base64');
  bytes += data.length;
  fs.writeFileSync(path.join(out, name), data);
}
console.log(`${pics.length} pictures, ${(bytes / 1024).toFixed(0)} KB, in ${((Date.now() - started) / 1000).toFixed(0)} s -> ${path.relative(process.cwd(), out)}`);
await browser.close();

// Pixel differences of the same-named pictures in two folders:
// node scripts/gate/diff-dirs.mjs <dirA> <dirB> <outDir>
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { diffPictures } from './compare.mjs';

const [a, b, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage();
for (const name of readdirSync(a).filter((f) => f.endsWith('.png') && existsSync(join(b, f)))) {
  const d = await diffPictures(page, join(a, name), join(b, name), join(out, `diff-${name}`));
  console.log(`${name}: ${(d.share * 100).toFixed(3)}% pixels diferentes, média ${d.mean.toFixed(2)}`);
}
await browser.close();

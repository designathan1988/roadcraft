// Cooks the people ahead src/render/people/cookedPerson.ts, and the procedural crowd's classes and hairstyles:
import { chromium } from '@playwright/test';
import { constants, setPriority } from 'node:os';

// Low priority, before Chrome is launched (its processes inherit it)
try { setPriority(0, constants.priority.PRIORITY_LOW); } catch { /* not allowed here: run as is */ }

const base = (process.argv.find((a) => a.startsWith('--base=')) ?? '--base=http://127.0.0.1:5173').slice(7);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
const started = Date.now();
await page.goto(`${base}/?nocook`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof window.__cookPeople === 'function', null, { timeout: 120_000 });
await page.waitForSelector('.loading-screen', { state: 'detached', timeout: 600_000 }).catch(() => {});
const result = await page.evaluate(() => window.__cookPeople());
if (!result.hash) throw new Error('The page has no people fingerprint (not a development build of this checkout?)');
const manifest = JSON.stringify({ hash: result.hash, ids: result.ids, cooked: new Date().toISOString() });
// Sent from the page, as the bodies were: Node's fetch refuses some ports (4190 among them).
const status = await page.evaluate(async (body) => (await fetch('/__cook/people/manifest.json', { method: 'PUT', body })).status, manifest);
if (status >= 300) throw new Error(`Manifest: ${status}`);
console.log(`cooked ${result.ids.length} people, ${(result.bytes / 1e6).toFixed(1)} MB, fingerprint ${result.hash}, ${((Date.now() - started) / 1000).toFixed(0)} s`);
// The procedural crowd's classes and hairstyles (`src/render/people/proceduralCook.ts`).
const procedural = await page.evaluate(() => (typeof window.__cookProcedural === 'function' ? window.__cookProcedural() : null));
if (procedural) {
  if (!procedural.hash) throw new Error('The page has no procedural fingerprint');
  const body = JSON.stringify({ hash: procedural.hash, names: procedural.names, cooked: new Date().toISOString() });
  const put = await page.evaluate(async (b) => (await fetch('/__cook/procedural/manifest.json', { method: 'PUT', body: b })).status, body);
  if (put >= 300) throw new Error(`Procedural manifest: ${put}`);
  console.log(`cooked ${procedural.names.length} procedural classes and hairstyles, ${(procedural.bytes / 1e6).toFixed(1)} MB, fingerprint ${procedural.hash}, ${((Date.now() - started) / 1000).toFixed(0)} s`);
}
if (errors.length) console.log('page errors:', errors.slice(0, 3));
await browser.close();

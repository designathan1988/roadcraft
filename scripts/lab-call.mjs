/* global performance */
// Calls one exported function of a game module inside the running game page and prints what it returns, as JSON.
// `node scripts/lab-call.mjs <src/module.ts> <export> [--url=http://127.0.0.1:5300]`
// For lab work (`src/lab`): the module is loaded by the dev server, in the same page and module graph as the game.
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const [given, exportName] = args.filter((a) => !a.startsWith('--'));
// Given as `src/...` (a leading slash is turned into a Windows path by Git Bash): served by the dev server at `/src/...`.
const modulePath = given ? `/${given.replace(/^.*?(?=src\/)/, '')}` : given;
const url = flags.find((f) => f.startsWith('--url='))?.slice(6) ?? 'http://127.0.0.1:5300/';
if (!modulePath || !exportName) {
  console.error('usage: node scripts/lab-call.mjs <module path under /src> <export>');
  process.exit(2);
}
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.on('pageerror', (error) => console.error(`page error: ${error.message}`));
  await page.goto(url);
  await page.waitForFunction(() => performance.getEntriesByName('opening:shown').length > 0, null, { timeout: 180000, polling: 250 });
  const result = await page.evaluate(async ([path, name]) => {
    const module = await import(path);
    return JSON.stringify(await module[name]());
  }, [modulePath, exportName]);
  console.log(result);
} finally {
  await browser.close();
}

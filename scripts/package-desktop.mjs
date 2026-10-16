/** Packs the desktop build: Electron with `desktop/` as its app, and the production build, for Windows x64 and Linux x64 */
import { packager } from '@electron/packager';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('No dist/index.html: run "npm run build" first.');
  process.exit(1);
}
const TARGETS = { win32: 'Roadcraft.exe', linux: 'Roadcraft' };
const asked = process.argv.slice(2).filter((arg) => arg in TARGETS);
const platforms = asked.length ? asked : Object.keys(TARGETS);
const electronVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
for (const platform of platforms) {
  const [appPath] = await packager({
    dir: path.join(root, 'desktop'),
    out: path.join(root, 'release'),
    name: 'Roadcraft',
    platform,
    arch: 'x64',
    electronVersion,
    overwrite: true,
    // Native code cannot be loaded from inside the archive: steamworks.js's module and Steam's library stay beside it.
    asar: { unpack: '**/*.{node,dll,so}' },
    prune: false,
  });
  const game = path.join(appPath, 'resources', 'game');
  fs.rmSync(game, { recursive: true, force: true });
  fs.cpSync(dist, game, { recursive: true, filter: (from) => !from.endsWith('.map') });
  // The App ID Steam is started with (`desktop/main.cjs` reads it): STEAM_APPID, or 480 (Valve's Spacewar, for tests).
  fs.writeFileSync(path.join(appPath, 'steam_appid.txt'), process.env.STEAM_APPID ?? '480');
  console.log(`Packed: ${path.join(appPath, TARGETS[platform])} (Steam App ID ${process.env.STEAM_APPID ?? '480, a test id'})`);
}

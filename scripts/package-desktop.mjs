/**
 * Packs the desktop build: Electron with `desktop/` as its app, and the
 * production build (`dist/`, without its source maps) beside it as
 * `resources/game` (`desktop/main.cjs` serves it). Run after `npm run build`.
 * The result: `release/Roadcraft-win32-x64/Roadcraft.exe`, a folder to copy
 * anywhere - no installer, no unpacking on every start.
 */
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
const electronVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
const [appPath] = await packager({
  dir: path.join(root, 'desktop'),
  out: path.join(root, 'release'),
  name: 'Roadcraft',
  platform: 'win32',
  arch: 'x64',
  electronVersion,
  overwrite: true,
  asar: true,
  prune: false,
});
const game = path.join(appPath, 'resources', 'game');
fs.rmSync(game, { recursive: true, force: true });
fs.cpSync(dist, game, { recursive: true, filter: (from) => !from.endsWith('.map') });
console.log(`Packed: ${path.join(appPath, 'Roadcraft.exe')}`);

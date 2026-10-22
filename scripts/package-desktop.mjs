/** Packs the desktop build for Steam: Electron with `desktop/` as its app and the production build, Windows x64 and Linux x64, and the SteamPipe scripts that upload them */
import { packager } from '@electron/packager';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Depot layout (one depot per OS, each the packer's folder as it is, `release/Roadcraft-<platform>-x64/`):
//   Roadcraft.exe | Roadcraft          the launch executable (Steamworks > Installation > General: one launch option per OS)
//   resources/app.asar                 `desktop/` (main.cjs, preload.cjs, saves.cjs, problems.cjs, isolation.cjs, package.json, node_modules)
//   resources/app.asar.unpacked/       steamworks.js's native module and Steam's library, which cannot load from the archive
//   resources/game/                    the production build (`dist/` without source maps), served as app://roadcraft/
//   steam_appid.txt                    for runs outside Steam only; excluded from the depots (Steamworks API overview: never shipped)
// Linux: a plain folder, not an AppImage (it needs FUSE, which the Steam Linux Runtime's container does not give); launched under
// Steamworks > Installation > Linux Runtime "Steam Linux Runtime 3.0 (sniper)". Pack and upload it from Linux: Windows keeps no
// executable bit, and `Roadcraft`, `chrome_crashpad_handler` and `chrome-sandbox` need it.
// Steam Cloud (Steamworks > Application > Steam Cloud), Auto-Cloud, no Cloud API (`desktop/main.cjs` `SAVES`):
//   Root WinAppDataRoaming, Subdirectory "Roadcraft/saves", Pattern "*", OS [All OSes], not recursive ("saves.staging" beside it stays out);
//   Root override: WinAppDataRoaming -> LinuxXdgDataHome on Linux, same subdirectory. Quotas: a file per map square and layer (`chunkedSave.ts`).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const desktop = path.join(root, 'desktop');
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('No dist/index.html: run "npm run build" first.');
  process.exit(1);
}
// steamworks.js is the shell's own optional dependency (`desktop/package.json`): without it the package runs without Steam.
if (!fs.existsSync(path.join(desktop, 'node_modules', 'steamworks.js', 'package.json'))) {
  console.warn('desktop/node_modules/steamworks.js is missing ("npm install --prefix desktop"): this package will run without Steam.');
}
/** Per platform: its executable, and what is left out: steamworks.js's binaries for the other systems (`dist/<os>`) and the import library (for linking only). */
const TARGETS = {
  win32: { exe: 'Roadcraft.exe', ignore: [/[\\/]steamworks\.js[\\/]dist[\\/](linux64|osx)([\\/]|$)/, /\.lib$/] },
  linux: { exe: 'Roadcraft', ignore: [/[\\/]steamworks\.js[\\/]dist[\\/](win64|osx)([\\/]|$)/] },
};
const asked = process.argv.slice(2).filter((arg) => arg in TARGETS);
const platforms = asked.length ? asked : Object.keys(TARGETS);
const electronVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
const appVersion = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).version;
/** The App ID: STEAM_APPID, or 480 (Valve's Spacewar) to try the package with Steam on this machine. */
const appId = process.env.STEAM_APPID ?? '480';
const packed = {};
for (const platform of platforms) {
  const [appPath] = await packager({
    dir: desktop,
    out: path.join(root, 'release'),
    name: 'Roadcraft',
    platform,
    arch: 'x64',
    electronVersion,
    overwrite: true,
    // Native code cannot be loaded from inside the archive: steamworks.js's module and Steam's library stay beside it.
    asar: { unpack: '**/*.{node,dll,so}' },
    prune: false,
    ignore: TARGETS[platform].ignore,
  });
  const game = path.join(appPath, 'resources', 'game');
  fs.rmSync(game, { recursive: true, force: true });
  fs.cpSync(dist, game, { recursive: true, filter: (from) => !from.endsWith('.map') });
  // Read by `desktop/main.cjs` when the package runs outside Steam; under Steam, Steam gives the id.
  fs.writeFileSync(path.join(appPath, 'steam_appid.txt'), appId);
  packed[platform] = appPath;
  if (platform === 'linux' && process.platform === 'win32') console.warn('Linux packed on Windows: the executables lost their executable bit; pack and upload the Linux depot from Linux.');
  console.log(`Packed: ${path.join(appPath, TARGETS[platform].exe)} (Steam App ID ${appId}${process.env.STEAM_APPID ? '' : ', a test id'})`);
}

// The SteamPipe scripts (Steamworks "Uploading to Steam": an app build naming one depot build per depot), for `steamcmd +run_app_build`.
/** Depot ids as Steamworks gave them (Installation > Depots): STEAM_DEPOT_WIN32, STEAM_DEPOT_LINUX. */
const depotIds = { win32: process.env.STEAM_DEPOT_WIN32, linux: process.env.STEAM_DEPOT_LINUX };
const unnamed = platforms.filter((platform) => !depotIds[platform]);
if (!process.env.STEAM_APPID || unnamed.length) {
  console.log('No SteamPipe scripts: they need STEAM_APPID and a depot id for each platform packed (STEAM_DEPOT_WIN32, STEAM_DEPOT_LINUX).');
} else {
  const steam = path.join(root, 'release', 'steam');
  fs.mkdirSync(steam, { recursive: true });
  const vdf = (text) => text.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const depots = [];
  for (const [platform, appPath] of Object.entries(packed)) {
    const id = depotIds[platform];
    const file = `depot_build_${id}.vdf`;
    fs.writeFileSync(path.join(steam, file), [
      '"DepotBuild"', '{',
      `\t"DepotID" "${id}"`,
      `\t"ContentRoot" "${vdf(appPath)}"`,
      '\t"FileMapping"', '\t{', '\t\t"LocalPath" "*"', '\t\t"DepotPath" "."', '\t\t"Recursive" "1"', '\t}',
      '\t"FileExclusion" "steam_appid.txt"',
      '}', '',
    ].join('\n'));
    depots.push(`\t\t"${id}" "${file}"`);
  }
  fs.writeFileSync(path.join(steam, `app_build_${appId}.vdf`), [
    '"AppBuild"', '{',
    `\t"AppID" "${appId}"`,
    `\t"Desc" "Roadcraft ${vdf(appVersion)}"`,
    // STEAM_PREVIEW=1: only the logs and the manifest, nothing uploaded (to check the mappings).
    `\t"Preview" "${process.env.STEAM_PREVIEW === '1' ? '1' : '0'}"`,
    `\t"BuildOutput" "${vdf(path.join(steam, 'output'))}"`,
    '\t"Depots"', '\t{', ...depots, '\t}',
    '}', '',
  ].join('\n'));
  console.log(`SteamPipe scripts: ${steam} (steamcmd +login <builder> +run_app_build "${path.join(steam, `app_build_${appId}.vdf`)}" +quit)`);
}

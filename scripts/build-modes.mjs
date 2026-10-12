// npm run build:modos [-- outDir]: the game in its two modes on one origin -
// the flat map in <outDir>/plano/ and the planet in <outDir>/planeta/ (Vite's
// `base`, https://vite.dev/guide/build.html "Public Base Path"), and a root
// page that goes to the mode last chosen (`ui/modeChooser.ts`, the planet the
// first time, which then asks). One origin: both modes share the browser's
// storage, each with its own maps under its own key.
// Serve it with: npx vite preview --outDir <outDir> --port 4182
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const out = resolve(process.argv[2] ?? 'C:/Codex-Shared/road-modes-dist');
mkdirSync(out, { recursive: true });
const vite = join('node_modules', 'vite', 'bin', 'vite.js');
for (const [mode, path] of [[null, 'plano'], ['planet', 'planeta']]) {
  const args = [vite, 'build', '--base', `/${path}/`, '--outDir', join(out, path), '--emptyOutDir', ...(mode ? ['--mode', mode] : [])];
  console.log(`> vite ${args.slice(1).join(' ')}`);
  const run = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
writeFileSync(join(out, 'index.html'), `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Roadcraft</title>
<script>
  // The mode last chosen in the game (ui/modeChooser.ts), else the planet, which asks.
  var mode = null;
  try { mode = localStorage.getItem('roadcraft.mode.v1'); } catch (e) {}
  location.replace(mode === 'flat' ? 'plano/' : 'planeta/');
</script></head>
<body style="background:#0b1416"></body></html>
`);
console.log(`modos em ${out}: plano/, planeta/, index.html`);

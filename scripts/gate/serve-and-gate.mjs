// Serves two builds (base on 5302, candidate on 5303, never the player's ports)
// with `vite preview`, runs the gate A/B on them with the player's large maps (copies from the backup), and stops the servers.
// node scripts/gate/serve-and-gate.mjs <baseDist> <candidateDist> [gate args...]
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { sleep } from './page.mjs';

const [base, candidate, ...extra] = process.argv.slice(2);
const MAPS = 'C:/Codex-Shared/_backup/roadcraft-mapas-2026-10-12/extraido/chrome-Default';
const vite = join('node_modules', 'vite', 'bin', 'vite.js');
const serve = (dir, port) => spawn(process.execPath, [vite, 'preview', '--outDir', dir, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: 'ignore' });
const servers = [serve(base, 5302), serve(candidate, 5303)];
const up = async (port) => {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/plano/`)).ok) return; } catch (error) { if (i === 59) throw error; }
    await sleep(500);
  }
};
try {
  await up(5302);
  await up(5303);
  const code = await new Promise((resolve) => {
    const gate = spawn(process.execPath, ['scripts/gate/gate.mjs', '--a', 'http://127.0.0.1:5302', '--b', 'http://127.0.0.1:5303',
      '--map-plano', `${MAPS}/http_127.0.0.1_4180/idb__roadcraft-saves__sessions__roadcraft.world.v7.json`,
      '--map-planeta', `${MAPS}/http_localhost_4181/localStorage__roadcraft.planet.atlas864.v1.txt`, ...extra], { stdio: 'inherit' });
    gate.on('exit', (c) => resolve(c ?? 1));
  });
  for (const s of servers) s.kill();
  process.exit(code);
} finally {
  for (const s of servers) s.kill();
}

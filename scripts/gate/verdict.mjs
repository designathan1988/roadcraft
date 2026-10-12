// The verdict of a gate run already written, computed again with a noise file:
// node scripts/gate/verdict.mjs <runDir> [noise.json]
// Reads every <mode>/<side>-r<k>/{city,map}.json and prints the judged metrics.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { summarize } from './compare.mjs';

const [dir, noisePath = 'gate/baseline/noise.json'] = process.argv.slice(2);
const noiseFile = existsSync(noisePath) ? JSON.parse(readFileSync(noisePath, 'utf8')) : {};
const NOISE = noiseFile.noise ?? noiseFile;
const fmt = (x) => (!Number.isFinite(x) ? '—' : Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(1));
let worse = 0;
for (const mode of readdirSync(dir).filter((m) => existsSync(join(dir, m)) && /^(plano|planeta)$/.test(m))) {
  const sides = { A: [], B: [] };
  for (const run of readdirSync(join(dir, mode)).filter((r) => /^[AB]-r\d+$/.test(r)).sort()) {
    const numbers = {};
    for (const part of ['city', 'map']) {
      const file = join(dir, mode, run, `${part}.json`);
      if (existsSync(file)) Object.assign(numbers, JSON.parse(readFileSync(file, 'utf8')).numbers);
    }
    sides[run[0]].push(numbers);
  }
  const rows = summarize(sides.A, sides.B, NOISE[mode] ?? {});
  const bad = rows.filter((r) => r.verdict === 'PIOR');
  worse += bad.length;
  console.log(`\n== ${mode}: A ${sides.A.length} rodadas, B ${sides.B.length}; ${bad.length} piores, ${rows.filter((r) => r.verdict === 'melhor').length} melhores`);
  for (const r of rows.filter((x) => x.judged && x.verdict !== 'igual')) {
    console.log(`${r.verdict.padEnd(6)} ${r.key.padEnd(40)} A ${fmt(r.a)} [${fmt(r.aMin)}–${fmt(r.aMax)}]  B ${fmt(r.b)} [${fmt(r.bMin)}–${fmt(r.bMax)}]  ruído ${(r.noise * 100).toFixed(0)}%`);
  }
}
process.exit(worse ? 1 : 0);

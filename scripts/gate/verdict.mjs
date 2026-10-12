// The verdict of a gate run already written, computed again:
// node scripts/gate/verdict.mjs <runDir>
// Reads every <mode>/<side>-r<k>/{city,map}.json and prints the metrics that
// are not `igual` (`compare.mjs` summarize: exact Mann-Whitney U, Cliff's delta).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { summarize } from './compare.mjs';

const [dir] = process.argv.slice(2);
const fmt = (x) => (!Number.isFinite(x) ? '—' : Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(1));
let worse = 0;
for (const mode of readdirSync(dir).filter((m) => existsSync(join(dir, m)) && /^(plano|planeta)$/.test(m))) {
  const sides = { A: [], B: [] };
  const errors = { A: 0, B: 0 };
  for (const run of readdirSync(join(dir, mode)).filter((r) => /^[AB]-r\d+$/.test(r)).sort()) {
    const numbers = {};
    for (const part of ['city', 'map']) {
      const file = join(dir, mode, run, `${part}.json`);
      if (!existsSync(file)) continue;
      const json = JSON.parse(readFileSync(file, 'utf8'));
      Object.assign(numbers, json.numbers);
      errors[run[0]] += json.errors.length;
    }
    sides[run[0]].push(numbers);
  }
  const rows = summarize(sides.A, sides.B);
  const bad = rows.filter((r) => r.verdict === 'PIOR');
  worse += bad.length + errors.B;
  console.log(`\n== ${mode}: A ${sides.A.length} rodadas, B ${sides.B.length}; ${bad.length} piores, ${rows.filter((r) => r.verdict === 'suspeito').length} suspeitas, ${rows.filter((r) => r.verdict === 'melhor').length} melhores; erros: base ${errors.A}, candidato ${errors.B}`);
  for (const r of rows.filter((x) => x.judged && x.verdict !== 'igual')) {
    console.log(`${r.verdict.padEnd(8)} ${r.key.padEnd(40)} A ${fmt(r.a)} [${fmt(r.aMin)}–${fmt(r.aMax)}]  B ${fmt(r.b)} [${fmt(r.bMin)}–${fmt(r.bMax)}]  p ${r.p.toFixed(3)} δ ${r.delta.toFixed(2)}`);
  }
}
process.exit(worse ? 1 : 0);

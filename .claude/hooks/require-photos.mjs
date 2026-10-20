import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Stop: while a game change (src/) has not been photographed and analysed, stopping is refused.
 *
 * The photos must be newer than the change: at least five PNGs under lab-reports/, a report.json from
 * `scripts/look.mjs`, and the three views the player judges the game by (map, district, street) by name.
 * `lab-reports/last-analysis.md`, newer than the change and written after looking at them, is the analysis.
 * Nothing is required when no game code changed.
 */

const project = resolve(process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd());
const marker = join(project, '.claude', 'verify-needed.json');
if (!existsSync(marker)) process.exit(0);
const since = statSync(marker).mtimeMs;
const reports = join(project, 'lab-reports');

const pngs = [];
const walk = (dir) => {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { walk(path); continue; }
    if (!entry.name.toLowerCase().endsWith('.png')) continue;
    try { if (statSync(path).mtimeMs > since) pngs.push(path); } catch { /* gone */ }
  }
};
walk(reports);
const named = (pattern) => pngs.filter((path) => pattern.test(path));
const map = named(/(^|[^a-z])(map|mapa|overview|plano)([^a-z]|$)/i);
const district = named(/(district|distrito|bairro)/i);
const street = named(/(street|rua|detail|detalhe)/i);
const reportsRead = [];
const look = (dir) => {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { look(path); continue; }
    if (entry.name !== 'report.json') continue;
    try { if (statSync(path).mtimeMs > since) reportsRead.push(JSON.parse(readFileSync(path, 'utf8'))); } catch { /* gone or not JSON */ }
  }
};
look(reports);
/** A memory reading with the heap, the geometry and the textures, and a timed run with its GPU time: what the process uses. */
const measured = reportsRead.some((report) => {
  const steps = Array.isArray(report?.steps) ? report.steps : [];
  const memory = steps.some((step) => {
    const value = step?.value;
    return step?.step === 'memory' && value && typeof value.heapMB === 'number' && typeof value.textureMB === 'number' && typeof value.geometryMB === 'number';
  });
  const gpu = steps.some((step) => {
    const value = step?.value;
    return step?.step === 'recordEnd' && value && value.gpu && typeof value.gpu.p95 === 'number' && typeof value.p95 === 'number';
  });
  // Every value reached, not a last reading: a sampled series with its peaks for the CPU, the GPU and the heap (and the GPU counts).
  const series = steps.some((step) => {
    const value = step?.value;
    return (step?.step === 'usage' || step?.step === 'usageEnd') && value && value.count >= 8 && Array.isArray(value.samples)
      && value.peak && typeof value.peak.cpuMax === 'number' && typeof value.peak.gpuMax === 'number' && typeof value.peak.heapMB === 'number';
  });
  return memory && gpu && series;
});
const analysisPath = join(reports, 'last-analysis.md');
let analysis = '';
try { if (statSync(analysisPath).mtimeMs > since) analysis = readFileSync(analysisPath, 'utf8'); } catch { /* none */ }
const analysisOk = analysis.trim().length >= 800
  && /map|mapa/i.test(analysis) && /district|distrito|bairro/i.test(analysis) && /street|rua|detalhe|detail/i.test(analysis)
  && /cpu/i.test(analysis) && /(memory|mem[oó]ria|heap)/i.test(analysis) && /gpu/i.test(analysis)
  && (analysis.match(/\d+(?:\.\d+)?\s*(?:%|mb|gb|ms|fps)/gi) ?? []).length >= 4;

const missing = [];
if (pngs.length < 5) missing.push(`at least 5 screenshots newer than the change (${pngs.length} now)`);
if (!map.length) missing.push('a whole-map screenshot (its name saying map)');
if (!district.length) missing.push('a district screenshot');
if (!street.length) missing.push('a street screenshot');
if (!reportsRead.length) missing.push('a report.json from scripts/look.mjs newer than the change');
if (!measured) missing.push('the process readings in that report: steps "memory" (heap, geometry, textures MB), "record"/"recordEnd" (frame and GPU p95 ms) and a "usage" series (8+ samples with the peak CPU, GPU and heap the process reached)');
if (!analysisOk) missing.push('lab-reports/last-analysis.md newer than the change (800+ chars judging the map, the district and the street, with the problems found and the peak CPU, memory and GPU values of the sampled series)');

if (!missing.length) {
  rmSync(marker, { force: true });
  process.exit(0);
}

const run = `node scripts/look.mjs scripts/look/views.json lab-reports/verify-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const reason = `A game change has not been photographed and analysed yet. Missing: ${missing.join('; ')}. `
  + `Run \`${run}\` (server: npm run dev), open every PNG and compare it with the previous run, write what is wrong or missing into lab-reports/last-analysis.md (map at the whole-city zoom, district, street close-up and its drag/turn/wheel shots), fix what the photos show, and only then stop.`;
console.log(JSON.stringify({ decision: 'block', reason }));
process.exit(0);

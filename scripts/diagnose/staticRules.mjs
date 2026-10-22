// WHAT THE CODE ITSELF SAYS, read without running it: patterns known to cost the player (a WebGL call that waits for the GPU, a batched mesh
// left sorting and culling every instance every pass, a material whose program three cannot tell apart, a quality setting no code reads).
// Each hit is a lead with its line; the run's measures say which of them the player pays for.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function filesUnder(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) filesUnder(path, out);
    else if (/\.ts$/.test(name) && !/\.(spec|test)\.ts$/.test(name)) out.push(path);
  }
  return out;
}

export function staticFindings(root) {
  const src = join(root, 'src');
  const findings = [];
  const rel = (p) => relative(root, p).replace(/\\/g, '/');
  // The lab's own tools read back on purpose; they are not the game.
  const files = filesUnder(src).filter((f) => !rel(f).startsWith('src/lab/'));
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    const code = (line) => line.replace(/\/\/.*$/, '');
    lines.forEach((line, i) => {
      const c = code(line);
      if (/\.(getBufferSubData|readPixels|clientWaitSync)\s*\(|\bgl\.finish\s*\(/.test(c)) {
        findings.push({ rule: 'gl-readback', where: `${rel(file)}:${i + 1}`, text: line.trim().slice(0, 140), why: 'the page waits for the GPU to finish everything queued before it' });
      }
    });
    // A BatchedMesh made here with three's defaults: every instance tested against the frustum and sorted by depth in every pass (colour and each shadow cascade).
    if (/new (Gpu)?BatchedMesh\s*\(|extends BatchedMesh/.test(text) && !/sortObjects\s*=\s*false/.test(text)) {
      const i = lines.findIndex((l) => /new (Gpu)?BatchedMesh\s*\(|extends BatchedMesh/.test(l));
      findings.push({ rule: 'batched-sort', where: `${rel(file)}:${i + 1}`, text: lines[i].trim().slice(0, 140), why: 'BatchedMesh keeps sortObjects and perObjectFrustumCulled true: a sort and a frustum test of every instance in every pass' });
    }
    // onBeforeCompile with no cache key of its own in the file: three keys the program by the function's source text.
    const hooks = (text.match(/onBeforeCompile\s*=/g) ?? []).length;
    const keys = (text.match(/customProgramCacheKey\s*=/g) ?? []).length;
    if (hooks > keys) {
      const i = lines.findIndex((l) => /onBeforeCompile\s*=/.test(l));
      findings.push({ rule: 'program-key', where: `${rel(file)}:${i + 1}`, text: `${hooks} onBeforeCompile, ${keys} customProgramCacheKey`, why: 'materials whose shader is patched without a key of their own may share or duplicate a program' });
    }
  }
  // Tier settings marked as read by nothing (`optimizationsQuality.ts` `unread: true`): the tier promises them, the frame never changes.
  const knobs = join(src, 'render', 'optimizationsQuality.ts');
  try {
    readFileSync(knobs, 'utf8').split('\n').forEach((line, i) => {
      if (/unread:\s*true/.test(line)) findings.push({ rule: 'dead-setting', where: `${rel(knobs)}:${i + 1}`, text: line.trim().slice(0, 140), why: 'a quality setting no code reads: changing the tier changes nothing here' });
    });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return findings;
}

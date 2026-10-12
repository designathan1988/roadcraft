// The gate's arithmetic: numbers of each run flattened to metric paths,
// medians and spread per side, the base-versus-candidate verdict against the
// noise measured A/A, and picture differences counted pixel by pixel inside a
// browser page (canvas decoding; no image library).
import { readFileSync, writeFileSync } from 'node:fs';

/** Every numeric leaf of `value` as `path -> number`; the road edits as medians over the ten. */
export function flatten(value, prefix = '', out = {}) {
  if (value === null || value === undefined) return out;
  if (typeof value === 'number') { if (Number.isFinite(value)) out[prefix] = value; return out; }
  if (typeof value === 'boolean') { out[prefix] = value ? 1 : 0; return out; }
  if (Array.isArray(value)) {
    if (prefix === 'edits') {
      const keys = new Set(value.flatMap((e) => Object.keys(e)));
      for (const k of keys) {
        const xs = value.map((e) => (typeof e[k] === 'boolean' ? (e[k] ? 1 : 0) : e[k])).filter((x) => Number.isFinite(x));
        out[`edits.${k}`] = k === 'built' ? Math.min(...xs) : median(xs);
        if (k !== 'built') out[`edits.${k}.max`] = Math.max(...xs);
      }
    }
    return out;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (['loafWorst', 'samples', 'label'].includes(k)) continue;
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
  return out;
}

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Metrics the verdict judges (lower is better), with the absolute margin
 * below which a difference is never called a change. Everything else is
 * reported, not judged (counts of the city, triangles: the pictures decide).
 */
const JUDGED = [
  [/^openMs$/, 50], [/^openMapMs$/, 100], [/^modeMs$/, 50],
  [/\.(p95|p99|max)$/, 2], [/\.(stutters|over50|loafCount)$/, 1], [/\.loafMax$/, 5], [/\.loafBlocking$/, 10],
  [/\.gpu\.(p95|p99)$/, 0.5], [/\.drawn\.calls$/, 5],
  [/\.programsLinked$/, 0], [/\.upload(Buffer|Texture)$/, 65536],
  [/^edits\.(clickMs|worldMs|readyMs|groundMs|maxGap)(\.max)?$/, 5], [/^edits\.over33(\.max)?$/, 1],
  [/Heap\.usedMB$/, 5], [/^idle\.slopeMBperMin$/, 1],
];
export function judged(path) {
  const hit = JUDGED.find(([re]) => re.test(path));
  return hit ? hit[1] : null;
}

/**
 * Per metric: the median and spread of each side, the relative noise when
 * an A/A pair is given, and the verdict: worse when the candidate's median
 * passes the base's by more than the noise and the absolute margin.
 */
export function summarize(runsA, runsB, noise = {}) {
  const flatA = runsA.map((r) => flatten(r));
  const flatB = runsB.map((r) => flatten(r));
  const keys = [...new Set([...flatA, ...flatB].flatMap((f) => Object.keys(f)))].sort();
  const rows = [];
  for (const key of keys) {
    const a = flatA.map((f) => f[key]).filter((x) => x !== undefined);
    const b = flatB.map((f) => f[key]).filter((x) => x !== undefined);
    const mA = median(a);
    const mB = b.length ? median(b) : NaN;
    const margin = judged(key);
    const rel = noise[key] ?? 0;
    let verdict = '';
    if (margin !== null && b.length && Number.isFinite(mA) && Number.isFinite(mB)) {
      const limit = mA * (1 + rel) + margin;
      verdict = mB > limit ? 'PIOR' : mB < mA * (1 - rel) - margin ? 'melhor' : 'igual';
    }
    rows.push({ key, a: mA, aMin: Math.min(...a), aMax: Math.max(...a), b: mB, bMin: b.length ? Math.min(...b) : NaN, bMax: b.length ? Math.max(...b) : NaN, noise: rel, judged: margin !== null, verdict });
  }
  return rows;
}

/** Relative A/A noise per metric: |median A - median A'| / median A, and each side's own spread. */
export function noiseOf(runsA, runsA2) {
  const out = {};
  for (const row of summarize(runsA, runsA2)) {
    if (!Number.isFinite(row.a) || !Number.isFinite(row.b) || row.a === 0) continue;
    const between = Math.abs(row.b - row.a) / Math.abs(row.a);
    const within = Math.max((row.aMax - row.aMin) / Math.abs(row.a), (row.bMax - row.bMin) / Math.abs(row.a)) / 2;
    out[row.key] = Math.max(between, within);
  }
  return out;
}

/**
 * Pixel differences of two PNG files, decoded in `page` (a blank page of a
 * running browser): the share of pixels where a channel differs by more than
 * `threshold` levels, the mean absolute difference, and a difference image.
 */
export async function diffPictures(page, fileA, fileB, diffPath, threshold = 16) {
  const a = readFileSync(fileA).toString('base64');
  const b = readFileSync(fileB).toString('base64');
  const result = await page.evaluate(async ({ a, b, threshold }) => {
    const load = async (data) => createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return { sizeMismatch: true };
    const w = ia.width, h = ia.height;
    const read = (img) => { const c = new OffscreenCanvas(w, h); const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, w, h).data; };
    const pa = read(ia), pb = read(ib);
    const out = new OffscreenCanvas(w, h);
    const og = out.getContext('2d');
    const img = og.createImageData(w, h);
    let differing = 0, sum = 0;
    for (let i = 0; i < pa.length; i += 4) {
      const d = Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2]));
      sum += d;
      const hit = d > threshold;
      if (hit) differing++;
      img.data[i] = hit ? 255 : pa[i] / 3; img.data[i + 1] = hit ? 0 : pa[i + 1] / 3; img.data[i + 2] = hit ? 0 : pa[i + 2] / 3; img.data[i + 3] = 255;
    }
    og.putImageData(img, 0, 0);
    const blob = await out.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { share: differing / (w * h), mean: sum / (w * h), png: btoa(bin) };
  }, { a, b, threshold });
  if (result.png) writeFileSync(diffPath, Buffer.from(result.png, 'base64'));
  return { share: result.share, mean: result.mean, sizeMismatch: Boolean(result.sizeMismatch) };
}

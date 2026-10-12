// The gate's arithmetic: numbers of each run flattened to metric paths,
// medians and spread per side, the base-versus-candidate verdict by an exact
// Mann-Whitney test and Cliff's delta, and picture differences counted pixel by pixel inside a
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
 * The decision (docs/research/gate.md, "Statistics"): Chromium's Pinpoint
 * calls two samples different at p <= 0.01 and has a third answer, "needs more
 * values"; Mozilla's PerfCompare tests with Mann-Whitney U and shows a change
 * only with a meaningful effect size (Cliff's delta, 0.47 and above: large).
 */
export const ALPHA = 0.01;
/** Above ALPHA and up to this: suspicious, more rounds are run (Pinpoint's "unknown"). */
export const ALPHA_SUSPECT = 0.05;
export const LARGE_DELTA = 0.47;

/**
 * Mann-Whitney U, two-sided and exact: the p-value is the share of all ways of
 * splitting the pooled values into two groups of these sizes whose rank sum is
 * at least as far from its mean as the observed one (ties take the mean rank;
 * the count of splits per rank sum by dynamic programming over the values).
 * Also Cliff's delta of b against a: P(b > a) - P(b < a), from -1 to 1.
 */
export function mannWhitney(a, b) {
  const n1 = a.length, n2 = b.length, n = n1 + n2;
  let greater = 0, less = 0;
  for (const x of b) for (const y of a) { if (x > y) greater++; else if (x < y) less++; }
  const delta = (greater - less) / (n1 * n2);
  // Ranks, doubled so mean ranks of ties are whole numbers.
  const pooled = [...a.map((v) => ({ v, b: false })), ...b.map((v) => ({ v, b: true }))].sort((p, q) => p.v - q.v);
  const rank2 = new Array(n);
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && pooled[j + 1].v === pooled[i].v) j++;
    for (let k = i; k <= j; k++) rank2[k] = i + j + 2;
    i = j + 1;
  }
  const observed = pooled.reduce((s, p, i) => s + (p.b ? rank2[i] : 0), 0);
  const total = rank2.reduce((s, r) => s + r, 0);
  // ways[k][s]: subsets of k values whose doubled ranks sum to s.
  const ways = Array.from({ length: n2 + 1 }, () => new Float64Array(total + 1));
  ways[0][0] = 1;
  for (let i = 0; i < n; i++) {
    for (let k = Math.min(i + 1, n2); k >= 1; k--) {
      const row = ways[k], prev = ways[k - 1], r = rank2[i];
      for (let s = total; s >= r; s--) row[s] += prev[s - r];
    }
  }
  const mean = (n2 * total) / n;
  const far = Math.abs(observed - mean) - 1e-9;
  let hit = 0, all = 0;
  ways[n2].forEach((count, s) => { all += count; if (Math.abs(s - mean) >= far) hit += count; });
  return { p: hit / all, delta };
}

/**
 * Per metric: the median and spread of each side, the Mann-Whitney p and
 * Cliff's delta of the candidate against the base, and the verdict. PIOR: the
 * candidate is larger (worse: every judged metric is lower-is-better) with
 * p <= ALPHA, a large delta and a median difference above the metric's
 * absolute margin; `suspeito` the same at p <= ALPHA_SUSPECT (more rounds
 * decide); `melhor` the mirror of PIOR; otherwise `igual`.
 */
export function summarize(runsA, runsB) {
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
    let verdict = '', p = NaN, delta = NaN;
    if (margin !== null && a.length >= 2 && b.length >= 2) {
      ({ p, delta } = mannWhitney(a, b));
      const up = mB - mA > margin && delta >= LARGE_DELTA;
      const down = mA - mB > margin && delta <= -LARGE_DELTA;
      verdict = up && p <= ALPHA ? 'PIOR' : up && p <= ALPHA_SUSPECT ? 'suspeito' : down && p <= ALPHA ? 'melhor' : 'igual';
    }
    rows.push({ key, a: mA, aMin: Math.min(...a), aMax: Math.max(...a), b: mB, bMin: b.length ? Math.min(...b) : NaN, bMax: b.length ? Math.max(...b) : NaN, p, delta, judged: margin !== null, verdict });
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

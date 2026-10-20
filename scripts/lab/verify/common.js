// THE LAB'S SELF-CHECK, shared by every step (run in the game's page by `scripts/lab/verify.mjs`): window.__v = { results, check, assert, wait, frames }.
window.__v ??= { results: [] };
window.__v.wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Frames drawn for `ms` (the game draws on demand: a still view gives none). */
window.__v.frames = async (ms) => {
  const end = performance.now() + ms;
  while (performance.now() < end) { window.__lab.requestDraw(); await window.__v.wait(50); }
};
window.__v.assert = (cond, msg) => { if (!cond) throw new Error(msg); };
window.__v.check = async (name, fn) => {
  const t0 = performance.now();
  try {
    const evidence = await fn();
    window.__v.results.push({ name, ok: true, evidence: String(evidence).slice(0, 400), ms: Math.round(performance.now() - t0) });
  } catch (error) {
    window.__v.results.push({ name, ok: false, evidence: String(error && error.message ? error.message : error).slice(0, 400), ms: Math.round(performance.now() - t0) });
  }
};
'ok';

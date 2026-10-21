/** THE FIELD PROBLEM LOG: what went wrong on the player's machine, kept on that machine only (nothing is sent anywhere).
 *  One JSON object a line in `<folder>/problems.log`, rotated by size (`problems.1.log` ... `problems.<keep>.log`), so the folder never holds
 *  more than `(keep + 1) * maxBytes`. Written by the main process alone: the page's problems arrive by IPC (`main.cjs` `problems:report`),
 *  the processes gone and the session's summary from here. A remote reporter (Sentry, a Breakpad server) is plugged in with `addSink`. */
const fs = require('node:fs');
const path = require('node:path');

/** The kinds a page may report; anything else is refused at the IPC boundary. */
const PAGE_KINDS = new Set(['error', 'rejection', 'ensure', 'webgl-lost', 'webgl-restored', 'shader', 'session', 'note']);
/** The longest message and detail kept, characters: a stack or a shader log is enough at that length. */
const MESSAGE_MAX = 500;
const DETAIL_MAX = 4000;
/** The most entries a session writes: a page failing every frame must not churn the disk. */
const SESSION_MAX = 400;

const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : undefined);

/** A page's report checked and cut to size, or null when it is not one (Electron security checklist: validate what IPC carries). */
function fromPage(raw) {
  if (!raw || typeof raw !== 'object' || !PAGE_KINDS.has(raw.kind)) return null;
  const message = text(raw.message, MESSAGE_MAX);
  if (!message) return null;
  const entry = { kind: raw.kind, message };
  const detail = text(raw.detail, DETAIL_MAX);
  if (detail) entry.detail = detail;
  // The session summary's numbers and short strings, one level deep, bounded.
  if (raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)) {
    const data = {};
    let fields = 0;
    for (const [key, value] of Object.entries(raw.data)) {
      if (++fields > 40 || !/^[A-Za-z0-9_]{1,40}$/.test(key)) continue;
      if (typeof value === 'number' && Number.isFinite(value)) data[key] = value;
      else if (typeof value === 'string') data[key] = value.slice(0, 1000);
      else if (typeof value === 'boolean') data[key] = value;
    }
    entry.data = data;
  }
  return entry;
}

/** The log over one folder. `maxBytes`: one file's size before it rotates; `keep`: the rotated files kept. */
function createProblemLog({ folder, maxBytes = 512 * 1024, keep = 3, sessionMax = SESSION_MAX, now = () => new Date() }) {
  const file = path.join(folder, 'problems.log');
  const rotated = (n) => path.join(folder, `problems.${n}.log`);
  const sinks = [];
  let written = 0;
  let dropped = 0;

  /** The current file moved to `.1`, `.1` to `.2` ..., the oldest past `keep` deleted. */
  function rotate() {
    fs.rmSync(rotated(keep), { force: true });
    for (let n = keep - 1; n >= 1; n--) if (fs.existsSync(rotated(n))) fs.renameSync(rotated(n), rotated(n + 1));
    if (keep >= 1) fs.renameSync(file, rotated(1));
    else fs.rmSync(file, { force: true });
  }

  function sizeOf(target) {
    try { return fs.statSync(target).size; } catch { return 0; }
  }

  /** One entry written (synchronously: problems are rare, and the last one before a crash must reach the disk), then handed to each sink. */
  function write(entry) {
    if (written >= sessionMax) { dropped++; return false; }
    written++;
    const record = { at: now().toISOString(), ...entry };
    let line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line) > maxBytes) line = `${JSON.stringify({ at: record.at, kind: record.kind, message: record.message, cut: true })}\n`;
    try {
      fs.mkdirSync(folder, { recursive: true });
      if (sizeOf(file) + Buffer.byteLength(line) > maxBytes) rotate();
      fs.appendFileSync(file, line, 'utf8');
    } catch (error) {
      console.error('problem log not written', error);
    }
    for (const sink of sinks) {
      try { sink(record); } catch (error) { console.error('problem sink failed', error); }
    }
    return true;
  }

  return {
    folder,
    file,
    write,
    /** THE ONE PLACE a remote reporter is plugged in (Sentry's `captureEvent`, a Breakpad endpoint): every entry, after it is on the disk. */
    addSink(sink) {
      sinks.push(sink);
      return () => { const at = sinks.indexOf(sink); if (at >= 0) sinks.splice(at, 1); };
    },
    /** Entries refused this session for being over `sessionMax`. */
    get dropped() { return dropped; },
  };
}

module.exports = { createProblemLog, fromPage, PAGE_KINDS };

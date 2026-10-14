/**
 * Runs a heavy job of a conversation (the check, the tests, the build) within the conversation's share of
 * the machine, at once: the job object of the conversation (`sessionJob.mjs`: a hard cap on CPU and on
 * memory, 25 % and 8 GB by default) holds this process and so every process it starts - npm, Vitest's
 * workers, a Chrome -, at below-normal priority, which the children inherit.
 *
 * DO NOT bring back the lock of one heavy job on the whole machine, the wait for the CPU to fall, the four
 * fixed cores every job shared or the loop that put Chrome back on them: conversations waited minutes for
 * one another while the machine (24 logical processors, 32 GB) was mostly idle, and one job could still
 * take every core its children escaped to (2026-10-14, the player: "não tem cabimento usar 100% da cpu em
 * um processo"). A job too slow within its share is a job, or a game, to make faster.
 */
import { spawn } from 'node:child_process';
import { constants, cpus, setPriority } from 'node:os';
import { clearTimeout, setTimeout } from 'node:timers';
import { dirname, join } from 'node:path';
import { joinSessionJob, share } from './sessionJob.mjs';

// Older callers' memory flags (`--kill-gb=N`, `--min-free-gb=N`): the job's memory cap does their work now.
const argv = process.argv.slice(2);
while (argv[0]?.startsWith('--kill-gb=') || argv[0]?.startsWith('--min-free-gb=')) argv.shift();
const [requested, ...args] = argv;
if (!requested) {
  process.stderr.write('Usage: node scripts/run-limited.mjs <command> [args...]\n');
  process.exit(2);
}

// npm and npx through their .cmd shims: PowerShell's execution policy
// refuses the .ps1 ones, and the check silently never ran.
const windows = process.platform === 'win32';
const executable = requested === 'npm' || requested === 'npx'
  ? windows ? join(dirname(process.execPath), `${requested}.cmd`) : requested
  : requested === 'node' ? process.execPath : requested;

const joined = joinSessionJob();
if (!joined.joined && windows) process.stderr.write(`[run-limited] not in the conversation's job: ${joined.why}\n`);
try { setPriority(constants.priority.PRIORITY_BELOW_NORMAL); } catch (error) { console.error(`[run-limited] priority: ${error.message}`); }

// Vitest's workers: as many as the share has processors (6 of 24 at 25 %), unless asked for fewer.
const { percent } = share();
const workers = Math.max(1, Math.floor((cpus().length * percent) / 100));
const asked = Number(process.env.VITEST_MAX_WORKERS);
const env = { ...process.env, VITEST_MAX_WORKERS: String(Number.isFinite(asked) ? Math.min(workers, Math.max(1, asked)) : workers), ROADCRAFT_IN_JOB: joined.joined ? '1' : '' };

const TIMEOUT_S = Number(process.env.RUN_LIMITED_TIMEOUT_S ?? 480);
// `.cmd` shims need cmd.exe on Windows (Node refuses to spawn them bare since CVE-2024-27980), and
// cmd.exe reads one command line: Node's docs, child_process, "Spawning .bat and .cmd files on Windows":
// spawn cmd.exe with the file as an argument, and "if the script filename contains spaces, it needs to be
// quoted". DO NOT go back to `shell: true` with the arguments apart: Node joins them with spaces unquoted
// (`windowsVerbatimArguments`), and npx under "C:\Program Files\nodejs" ran "C:\Program" (2026-10-14).
const viaCmd = windows && /\.cmd$/i.test(executable);
/** One word of a cmd.exe command line: quoted when it holds a space or a character cmd.exe reads. */
const cmdWord = (word) => (word === '' || /[\s"&|<>^()%!,;=]/.test(word) ? `"${word.replace(/"/g, '""')}"` : word);
const child = viaCmd
  // `/d` no AutoRun, `/s` the outer quotes taken off and the rest run as written, `/c` then exit.
  ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${[executable, ...args].map(cmdWord).join(' ')}"`],
    { stdio: 'inherit', env, windowsVerbatimArguments: true })
  : spawn(executable, args, { stdio: 'inherit', env });
let stopping = false;
const stop = (signal) => {
  if (stopping || !child.pid) return;
  stopping = true;
  // The whole process tree, not only the parent: a Vitest worker or a Chrome renderer would keep running.
  if (windows) spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill(signal);
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
};
const runaway = setTimeout(() => {
  process.stderr.write(`[run-limited] stopped after ${TIMEOUT_S} s (RUN_LIMITED_TIMEOUT_S)\n`);
  stop('SIGTERM');
}, TIMEOUT_S * 1000);
child.on('exit', () => clearTimeout(runaway));
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
child.on('error', (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.on('exit', (code, signal) => { if (!stopping) process.exitCode = code ?? (signal ? 1 : 0); });

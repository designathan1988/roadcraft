/**
 * Keep repository verification responsive on the machine running the game.
 * Set the Windows process limits before launching npm and its worker tree.
 */
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { cpus, freemem, tmpdir } from 'node:os';
import { clearTimeout, setTimeout } from 'node:timers';
import { dirname, join } from 'node:path';

// Leading --kill-gb=N / --min-free-gb=N: this job's own memory floors (the
// browser performance gate runs a town of 400 people and 400 cars, ~4.5 GB).
const argv = process.argv.slice(2);
while (argv[0]?.startsWith('--kill-gb=') || argv[0]?.startsWith('--min-free-gb=')) {
  const [flag, value] = argv.shift().split('=');
  process.env[flag === '--kill-gb' ? 'RUN_LIMITED_KILL_GB' : 'RUN_LIMITED_MIN_FREE_GB'] = value;
}
const [requested, ...args] = argv;
if (!requested) {
  process.stderr.write('Usage: node scripts/run-limited.mjs <command> [args...]\n');
  process.exit(2);
}

// npm and npx through their .cmd shims: PowerShell's execution policy
// refuses the .ps1 ones, and the check silently never ran.
const executable = requested === 'npm' || requested === 'npx'
  ? process.platform === 'win32' ? join(dirname(process.execPath), `${requested}.cmd`) : requested
  : requested === 'node' ? process.execPath : requested;

/*
 * The machine is the player's: one heavy job at a time on it (every session
 * and agent goes through this script), started only when the CPU and the
 * memory have room, and stopped if it runs away. Several headless Chromes at
 * once (each drawing in software) took the CPU to 100% and the free memory
 * to 3 GB of 32.
 */
const LOCK = join(tmpdir(), 'roadcraft-heavy-job.lock');
const MAX_CPU = Number(process.env.RUN_LIMITED_MAX_CPU ?? 70);
const MIN_FREE_GB = Number(process.env.RUN_LIMITED_MIN_FREE_GB ?? 6);
const TIMEOUT_S = Number(process.env.RUN_LIMITED_TIMEOUT_S ?? 480);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const busy = () => cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + Object.values(c.times).reduce((x, y) => x + y, 0) }), { idle: 0, total: 0 });
async function cpuPercent() {
  const a = busy();
  await sleep(1000);
  const b = busy();
  return 100 * (1 - (b.idle - a.idle) / Math.max(1, b.total - a.total));
}
function tryLock() {
  try {
    const fd = openSync(LOCK, 'wx');
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch {
    // Held: by a live process, wait; by a dead one, take it over.
    let owner;
    try { owner = Number(readFileSync(LOCK, 'utf8')); } catch { return false; }
    if (owner && alive(owner)) return false;
    try { unlinkSync(LOCK); } catch { /* raced */ }
    return false;
  }
}
const releaseLock = () => {
  try { if (Number(readFileSync(LOCK, 'utf8')) === process.pid) unlinkSync(LOCK); } catch { /* gone */ }
};
let said = '';
const say = (text) => { if (text !== said) { said = text; process.stderr.write(`[run-limited] ${text}
`); } };
for (;;) {
  if (!tryLock()) { say('waiting: another heavy job is running on this machine'); await sleep(3000); continue; }
  const cpu = await cpuPercent();
  const free = freemem() / 2 ** 30;
  if (cpu <= MAX_CPU && free >= MIN_FREE_GB) break;
  releaseLock();
  say(`waiting: CPU ${cpu.toFixed(0)}% (max ${MAX_CPU}), free memory ${free.toFixed(1)} GB (min ${MIN_FREE_GB})`);
  await sleep(5000);
}
process.on('exit', releaseLock);
const logicalProcessors = cpus().length;
const processorLimit = Math.min(4, Math.max(1, Math.floor(logicalProcessors / 2)));
// Adjacent logical processors on the development machine are SMT siblings.
// Spacing the selected bits lets four workers use separate physical cores.
const affinity = Array.from({ length: processorLimit }, (_, i) => i * 2)
  .reduce((mask, index) => mask + 2 ** index, 0);
const requestedWorkers = Number(process.env.VITEST_MAX_WORKERS);
const workerCount = Number.isFinite(requestedWorkers)
  ? Math.min(processorLimit, Math.max(1, requestedWorkers)) : processorLimit;
const env = { ...process.env, VITEST_MAX_WORKERS: String(workerCount) };
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const windows = process.platform === 'win32';
const command = windows
  ? `try { $p = Get-Process -Id $PID; $p.ProcessorAffinity = ${affinity}; $p.PriorityClass = 'BelowNormal' } ` +
    `catch { Write-Error $_; exit 1 }; & ${[executable, ...args].map(quote).join(' ')}; exit $LASTEXITCODE`
  : null;
const child = windows
  ? spawn('powershell.exe', ['-NoProfile', '-Command', command], { stdio: 'inherit', env })
  : spawn(executable, args, { stdio: 'inherit', env });
let stopping = false;
const stop = (signal) => {
  if (stopping || !child.pid) return;
  stopping = true;
  // Interrupt the whole process tree, not only the parent shell. Otherwise a
  // Vitest worker or Chrome renderer may keep using CPU after the check ends.
  if (windows) spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill(signal);
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
};
// Chrome does not keep the affinity and priority it was started with: a
// headless probe's GPU and renderer processes ran on all 24 processors at
// normal priority and took the machine to 97%. One small PowerShell loop
// puts every process under the job back on the same cores, below normal,
// every two seconds while the job lives.
const guard = windows && child.pid
  ? spawn('powershell.exe', ['-NoProfile', '-Command',
    `$root = ${child.pid}; while (Get-Process -Id $root -ErrorAction SilentlyContinue) { ` +
    `$all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId; $ids = @($root); $grew = $true; ` +
    `while ($grew) { $grew = $false; foreach ($p in $all) { if ($ids -contains $p.ParentProcessId -and -not ($ids -contains $p.ProcessId)) { $ids += $p.ProcessId; $grew = $true } } }; ` +
    `foreach ($i in $ids) { try { $q = Get-Process -Id $i -ErrorAction Stop; if ($q.ProcessorAffinity -ne ${affinity}) { $q.ProcessorAffinity = ${affinity} }; if ($q.PriorityClass -ne 'BelowNormal' -and $q.PriorityClass -ne 'Idle') { $q.PriorityClass = 'BelowNormal' } } catch {} }; ` +
    // And the memory: below 2 GB free the job and its tree are stopped at
    // once (a probe's Chrome took the machine to 0.1 GB free, 2026-10-10).
    `$free = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB; ` +
    `if ($free -lt ${process.env.RUN_LIMITED_KILL_GB ?? 2}) { [Console]::Error.WriteLine('[run-limited] stopped: free memory ' + [math]::Round($free, 1) + ' GB'); taskkill.exe /PID $root /T /F | Out-Null; break }; ` +
    `Start-Sleep -Seconds 2 }`], { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true })
  : null;
child.on('exit', () => { try { guard?.kill(); } catch { /* gone */ } });
const runaway = setTimeout(() => {
  process.stderr.write(`[run-limited] stopped after ${TIMEOUT_S} s (RUN_LIMITED_TIMEOUT_S)
`);
  stop('SIGTERM');
}, TIMEOUT_S * 1000);
child.on('exit', () => { clearTimeout(runaway); releaseLock(); });
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
child.on('error', (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.on('exit', (code, signal) => { if (!stopping) process.exitCode = code ?? (signal ? 1 : 0); });

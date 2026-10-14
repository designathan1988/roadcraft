// THE SHARE OF THE MACHINE A CONVERSATION MAY USE. The player's machine (i9-12900K, 24 logical processors,
// 32 GB, RTX 3060) runs several conversations, their agents, their tests and their headless games at once,
// besides the player's own work. Each conversation gets a Windows job object of its own, named after its
// Claude process (`CLAUDE_PID`, shared by its agents), with a hard cap on CPU and on committed memory; every
// heavy process of the conversation (`run-limited.mjs`, Vitest, `look.mjs` and the Chrome it starts) is put in
// it, and every process it starts is in it too, without anybody watching
// (learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject: "By default, all
// child processes are associated with the immediate job").
//   CPU: JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | HARD_CAP, CpuRate = percent × 100
//        (ns-winnt-jobobject_cpu_rate_control_information): past it, no thread of the job runs until the next
//        scheduling interval.
//   memory: JOB_OBJECT_LIMIT_JOB_MEMORY, JobMemoryLimit (ns-winnt-jobobject_extended_limit_information): the
//        commit of all the job's processes together; past it, an allocation fails.
// Defaults: 25 % of the CPU and 8 GB a conversation (three conversations, 75 % and 24 GB; the rest is the
// player's). ROADCRAFT_SESSION_CPU (percent) and ROADCRAFT_SESSION_MEM_GB change them.
// DO NOT wait for the machine to be free instead, nor pin every job on the same cores: a conversation runs
// at once within its share, and a game that cannot run within its share is a game to make faster.
// The GPU has no such cap in this API: one headless game per conversation (`look.mjs`), and the CPU cap
// paces the frames it submits.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CACHE = join(ROOT, 'node_modules', '.cache', 'roadcraft-job');
const DLL = join(CACHE, 'SessionJob.v1.dll');

const SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;
public static class SessionJob {
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED { public BASIC Basic; public IO Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)] struct CPU { public uint ControlFlags; public uint CpuRate; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  const int ExtendedLimitInformation = 9, CpuRateControlInformation = 15;
  const uint LIMIT_JOB_MEMORY = 0x200, CPU_ENABLE = 0x1, CPU_HARD_CAP = 0x4;
  const uint PROCESS_SET_QUOTA = 0x100, PROCESS_TERMINATE = 0x1;
  static void Set<T>(IntPtr job, int infoClass, T value) {
    int size = Marshal.SizeOf(typeof(T));
    IntPtr p = Marshal.AllocHGlobal(size);
    try { Marshal.StructureToPtr(value, p, false); if (!SetInformationJobObject(job, infoClass, p, (uint)size)) throw new Exception("SetInformationJobObject " + infoClass + ": " + Marshal.GetLastWin32Error()); }
    finally { Marshal.FreeHGlobal(p); }
  }
  // Opens (or makes) the conversation's job, sets its caps and puts the process in it.
  public static string Join(string name, uint pid, uint percent, ulong memoryBytes) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, name);
    if (job == IntPtr.Zero) throw new Exception("CreateJobObject: " + Marshal.GetLastWin32Error());
    EXTENDED limits = new EXTENDED();
    limits.Basic.LimitFlags = LIMIT_JOB_MEMORY;
    limits.JobMemoryLimit = new UIntPtr(memoryBytes);
    Set(job, ExtendedLimitInformation, limits);
    CPU cpu = new CPU(); cpu.ControlFlags = CPU_ENABLE | CPU_HARD_CAP; cpu.CpuRate = percent * 100;
    Set(job, CpuRateControlInformation, cpu);
    IntPtr process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
    if (process == IntPtr.Zero) throw new Exception("OpenProcess " + pid + ": " + Marshal.GetLastWin32Error());
    try { if (!AssignProcessToJobObject(job, process)) throw new Exception("AssignProcessToJobObject: " + Marshal.GetLastWin32Error()); }
    finally { CloseHandle(process); }
    // The job handle is left open on purpose until this helper exits; the job lives on while a process is in it.
    return name;
  }
}`;

/** The share a conversation gets: the cap's percent of the whole CPU and its memory, bytes. */
export function share(env = process.env) {
  const percent = Math.min(100, Math.max(1, Math.round(Number(env.ROADCRAFT_SESSION_CPU ?? 25))));
  const memoryGb = Math.max(1, Number(env.ROADCRAFT_SESSION_MEM_GB ?? 8));
  return { percent, memoryBytes: Math.round(memoryGb * 2 ** 30) };
}

/** The job's name: the conversation's Claude process, or one shared by everything run by hand. */
export const jobName = (env = process.env) => `Local\\roadcraft-session-${env.CLAUDE_PID ?? 'by-hand'}`;

/**
 * Puts process `pid` (this one by default) in the conversation's job, compiling the helper once.
 * Returns what was done, or why not (not Windows, or the system refused): the caller goes on either way,
 * saying so, rather than holding the work.
 */
export function joinSessionJob(pid = process.pid, env = process.env) {
  if (process.platform !== 'win32') return { joined: false, why: 'not Windows' };
  const { percent, memoryBytes } = share(env);
  const name = jobName(env);
  let build = '';
  if (!existsSync(DLL)) {
    mkdirSync(CACHE, { recursive: true });
    const part = `${DLL}.${process.pid}.tmp`;
    // Compiled to a file of its own, then renamed: two conversations compiling at once never read half a DLL.
    build = `$src = @'\n${SOURCE}\n'@; Add-Type -TypeDefinition $src -OutputAssembly '${part}' -OutputType Library; ` +
      `if (-not (Test-Path '${DLL}')) { Move-Item -Force '${part}' '${DLL}' } else { Remove-Item -Force '${part}' }; `;
  }
  const script = `$ErrorActionPreference = 'Stop'; ${build}Add-Type -Path '${DLL}'; ` +
    `[SessionJob]::Join('${name}', ${pid}, ${percent}, ${memoryBytes}) | Out-Null`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return { joined: false, why: (r.stderr || r.stdout || `exit ${r.status}`).trim().split('\n')[0] };
  return { joined: true, name, percent, memoryGb: memoryBytes / 2 ** 30 };
}

// `node scripts/sessionJob.mjs [pid]`: puts a process in the conversation's job by hand.
if (import.meta.main) {
  const pid = Number(process.argv[2] ?? process.ppid);
  const r = joinSessionJob(pid);
  process.stdout.write(`${JSON.stringify(r)}\n`);
  process.exit(r.joined ? 0 : 1);
}

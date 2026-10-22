import { spawn } from 'node:child_process';

// THE DISPLAY KEPT ON WHILE A RUN MEASURES FRAMES
// With the monitor off for idleness (Windows "Turn off the display after", 15 min here), the desktop composes at 30 Hz and every frame of
// a headless Chrome took 33.3 ms: each view's p99 read 33 ms and the flight counted two thirds of its frames over 25 ms, on any commit
// (`npm run diagnose`, 2026-10-22, 68 min idle). The run asks Windows for the display as a video player does - SetThreadExecutionState
// (ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED, Microsoft docs: "Forces the display to be on by resetting the display idle
// timer") - from a PowerShell held for the run's length; nothing of the machine's settings changes, and the request ends with the process.

const SCRIPT = `
Add-Type -Namespace RC -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
[void][RC.Power]::SetThreadExecutionState([uint32]2147483651)
while ($true) { Start-Sleep -Seconds 30; [void][RC.Power]::SetThreadExecutionState([uint32]2147483651) }
`;

/** The display held on until the function returned is called (or the run ends); none off Windows. */
export function holdDisplayAwake() {
  if (process.platform !== 'win32') return () => {};
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { stdio: 'ignore', windowsHide: true });
  const release = () => { if (!child.killed) child.kill(); };
  process.once('exit', release);
  return release;
}

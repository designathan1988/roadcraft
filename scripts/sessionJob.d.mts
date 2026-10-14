/** The conversation's share of the machine: the CPU cap, percent, and the memory cap, bytes. */
export function share(env?: NodeJS.ProcessEnv): { percent: number; memoryBytes: number };
/** The name of the conversation's job object. */
export function jobName(env?: NodeJS.ProcessEnv): string;
/** Puts a process in the conversation's job (`scripts/sessionJob.mjs`). */
export function joinSessionJob(pid?: number, env?: NodeJS.ProcessEnv):
  | { joined: true; name: string; percent: number; memoryGb: number }
  | { joined: false; why: string };

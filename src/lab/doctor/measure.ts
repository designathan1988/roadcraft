import type { LabContext, LabSample } from '../labTypes';

/** THE DIAGNOSIS'S MEASURES: one snapshot of where the frame goes (the GPU's passes, one frame's every draw, the CPU's systems and functions), and the quick A/B of one change (off, measured, back on, measured), from the other areas' probes. */

export interface PassTime { readonly pass: string; readonly label: string; readonly avg: number; readonly p95: number; readonly share: number }
export interface Draw {
  readonly object: unknown; readonly name: string; readonly layer: string; readonly material: string; readonly program: string;
  readonly triangles: number; readonly calls: number; readonly instances: number; readonly pass: string; readonly target: string;
}
export interface ProfileFn { readonly name: string; readonly where: string; readonly category: string; readonly selfMs: number; readonly totalMs: number; readonly samples: number }

export interface Snapshot {
  readonly at: number;
  /** Medians over the measuring window, ms. */
  readonly frameMs: number;
  readonly cpuMs: number;
  /** The sum of the passes' averages (the frame's GPU time), or the frame timer's median; null with no timer. */
  readonly gpuMs: number | null;
  readonly frames: number;
  readonly passes: readonly PassTime[];
  readonly draws: readonly Draw[];
  readonly systems: readonly (readonly [string, number])[];
  readonly functions: readonly ProfileFn[];
  readonly drawCalls: number;
  readonly triangles: number;
  readonly hitches: number;
}

interface GpuProbe {
  passTiming(on: boolean): void;
  passes(): PassTime[];
  capture(): Promise<{ records: readonly Draw[] }>;
  lab?: { passTiming: boolean };
}
interface CodeProbe { start(live?: boolean): void; functions(view?: string): ProfileFn[]; status(): { running: boolean } }

export const gpuProbe = (): GpuProbe | null => (window as unknown as { __labGpu?: GpuProbe }).__labGpu ?? null;
export const codeProbe = (): CodeProbe | null => (window as unknown as { __labCode?: CodeProbe }).__labCode ?? null;

export const median = (values: readonly number[]): number => {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const wait = (ms: number): Promise<void> => new Promise((resolve) => { window.setTimeout(resolve, ms); });

/** The frames drawn for `ms`, every frame asked for (the game draws on demand: a still view would give none). */
export async function framesFor(ctx: LabContext, ms: number): Promise<{ samples: LabSample[]; gpu: number[] }> {
  const samples: LabSample[] = [];
  const ring = ctx.scene.gpu.samples;
  const pushed = ring.pushed;
  const stop = ctx.onFrame((s) => { samples.push(s); ctx.requestDraw(); });
  ctx.requestDraw();
  await wait(ms);
  stop();
  const fresh = Math.min(ring.pushed - pushed, ring.size);
  const gpu: number[] = [];
  for (let back = 0; back < fresh; back++) gpu.push(ring.newest(back));
  return { samples, gpu };
}

/** Where the frame goes now: the passes timed for a while, one frame captured, the CPU sampled meanwhile. */
export async function snapshot(ctx: LabContext, progress: (text: string) => void): Promise<Snapshot> {
  const gpu = gpuProbe();
  const code = codeProbe();
  // Sampling only while asked (its tab open, or here): started for the measure if it was not running, stopped after.
  const wasRunning = code?.status().running ?? false;
  // The frame measured first, with nothing of the lab's measuring running (the CPU profile and the per-pass queries cost time themselves).
  gpu?.passTiming(false);
  progress('measuring the frames…');
  const plain = await framesFor(ctx, 2000);
  if (code && !wasRunning) code.start(true);
  let passes: PassTime[] = [];
  if (gpu && ctx.scene.gpu.supported) {
    progress('measuring every GPU pass…');
    gpu.passTiming(true);
    await framesFor(ctx, 2500);
    passes = gpu.passes().filter((p) => p.avg > 0);
    gpu.passTiming(false);
  }
  let draws: readonly Draw[] = [];
  if (gpu) {
    progress('capturing a frame…');
    try { draws = (await gpu.capture()).records; } catch (error) { console.warn('lab doctor: capture failed', error); }
  }
  // The profile's window closes a few seconds after it began: its functions read once it has.
  if (code) {
    for (let t = 0; t < 5000 && !code.functions('session').some((f) => f.category === 'game'); t += 500) {
      progress('reading the CPU profile…');
      await framesFor(ctx, 500);
    }
  }
  if (code && !wasRunning) code.start(false);
  const systems = new Map<string, number[]>();
  for (const s of plain.samples) for (const [k, v] of s.systems) (systems.get(k) ?? systems.set(k, []).get(k)!).push(v);
  const passSum = passes.reduce((a, p) => a + p.avg, 0);
  return {
    at: performance.now(),
    frameMs: median(plain.samples.map((s) => s.intervalMs).filter((v) => v > 0)),
    cpuMs: median(plain.samples.map((s) => s.cpuMs)),
    gpuMs: passSum > 0 ? passSum : plain.gpu.length ? median(plain.gpu) : null,
    frames: plain.samples.length,
    passes,
    draws,
    systems: [...systems].map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length] as const).sort((a, b) => b[1] - a[1]),
    functions: code ? code.functions('session').filter((f) => f.category === 'game').sort((a, b) => b.selfMs - a.selfMs).slice(0, 12) : [],
    drawCalls: median(plain.samples.map((s) => s.drawCalls)),
    triangles: median(plain.samples.map((s) => s.triangles)),
    hitches: plain.samples.filter((s) => s.intervalMs > 50).length,
  };
}

export interface AbResult {
  readonly gpuA: number | null; readonly gpuB: number | null;
  readonly cpuA: number; readonly cpuB: number;
  readonly drawsA: number; readonly drawsB: number;
  readonly trisA: number; readonly trisB: number;
  /** How far the two A windows differ: under it a delta is noise. */
  readonly noiseGpu: number;
  readonly noiseCpu: number;
}

/** The frames drawn until no shader program has been made for 600 ms (a change compiles them), at most 6 s. */
async function settled(ctx: LabContext): Promise<void> {
  const programs = (): number => ctx.scene.gl.info.programs?.length ?? 0;
  let count = programs(), still = 0;
  for (let t = 0; t < 6000 && still < 600; t += 200) {
    await framesFor(ctx, 200);
    const now = programs();
    still = now === count ? still + 200 : 0;
    count = now;
  }
  await framesFor(ctx, 400);
}

/** A, change, B, back, A again: B against the mean of the two A (Δ under their gap is noise). */
export async function quickAb(ctx: LabContext, change: () => void, back: () => void, progress: (text: string) => void): Promise<AbResult> {
  gpuProbe()?.passTiming(false);
  const read = async (ms: number): Promise<{ gpu: number | null; cpu: number; draws: number; tris: number }> => {
    const f = await framesFor(ctx, ms);
    return { gpu: f.gpu.length ? median(f.gpu) : null, cpu: median(f.samples.map((s) => s.cpuMs)), draws: median(f.samples.map((s) => s.drawCalls)), tris: median(f.samples.map((s) => s.triangles)) };
  };
  progress('settling…');
  await framesFor(ctx, 700);
  progress('measuring before…');
  const a1 = await read(1500);
  change();
  progress('applied: compiling and settling…');
  await settled(ctx);
  progress('measuring after…');
  const b = await read(1500);
  back();
  progress('undone: compiling and settling…');
  await settled(ctx);
  progress('measuring again…');
  const a2 = await read(1500);
  const mean = (x: number | null, y: number | null): number | null => (x === null || y === null ? x ?? y : (x + y) / 2);
  return {
    gpuA: mean(a1.gpu, a2.gpu), gpuB: b.gpu,
    cpuA: (a1.cpu + a2.cpu) / 2, cpuB: b.cpu,
    drawsA: (a1.draws + a2.draws) / 2, drawsB: b.draws,
    trisA: (a1.tris + a2.tris) / 2, trisB: b.tris,
    noiseGpu: a1.gpu !== null && a2.gpu !== null ? Math.abs(a1.gpu - a2.gpu) : 0,
    noiseCpu: Math.abs(a1.cpu - a2.cpu),
  };
}

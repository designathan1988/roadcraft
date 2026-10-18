/** A WEAKER MACHINE PLAYED ON THIS ONE, FOR A RUN ONLY (CLAUDE.md: the game proven on an Intel UHD 770 with 8 GB and few cores): set at build time (`vite.config.ts`, ROADCRAFT_WEAK, the page and every worker read the same); nothing set, the machine's own */

declare const __WEAK_MACHINE__: string | undefined;

/** What the run pretends: the threads the pool is sized by (`jobPool.ts` jobWorkers), the GPU's name (its tier and its share of the system's memory, `gpuTier.ts`, `gpuLedger.ts`), the system's memory (GB) and the display's pixel ratio. Null: the machine's own. */
export interface WeakMachine {
  readonly threads: number | null;
  readonly gpu: string | null;
  readonly memoryGB: number | null;
  readonly pixelRatio: number | null;
}

/** The player's weak machine (Intel UHD 770 with 8 GB): four threads, at a pixel ratio of 1. */
const PRESETS: Readonly<Record<string, WeakMachine>> = {
  uhd770: { threads: 4, gpu: 'ANGLE (Intel, Intel(R) UHD Graphics 770 (0x00004680) Direct3D11 vs_5_0 ps_5_0, D3D11)', memoryGB: 8, pixelRatio: 1 },
};

const NONE: WeakMachine = { threads: null, gpu: null, memoryGB: null, pixelRatio: null };

/** `uhd770`, or `threads=4,gpu=...,memory=8,dpr=1` (any of them, over a preset named first); empty: none. A value out of reach throws: a run must not pass for a weak machine it is not. */
export function parseWeakMachine(text: string | undefined): WeakMachine {
  const said = (text ?? '').trim();
  if (!said) return NONE;
  let out: { -readonly [K in keyof WeakMachine]: WeakMachine[K] } = { ...NONE };
  for (const part of said.split(',').map((p) => p.trim()).filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq < 0) {
      const preset = PRESETS[part];
      if (!preset) throw new Error(`ROADCRAFT_WEAK: no machine named ${part} (${Object.keys(PRESETS).join(', ')})`);
      out = { ...out, ...preset };
      continue;
    }
    const key = part.slice(0, eq).trim(), value = part.slice(eq + 1).trim();
    const number = (least: number, most: number): number => {
      const n = Number(value);
      if (!Number.isFinite(n) || n < least || n > most) throw new Error(`ROADCRAFT_WEAK: ${key} must be from ${least} to ${most}, not ${value}`);
      return n;
    };
    if (key === 'threads') out.threads = Math.round(number(1, 256));
    else if (key === 'gpu') out.gpu = value;
    else if (key === 'memory') out.memoryGB = number(0.25, 1024);
    else if (key === 'dpr') out.pixelRatio = number(0.5, 4);
    else throw new Error(`ROADCRAFT_WEAK: unknown key ${key} (threads, gpu, memory, dpr)`);
  }
  return out;
}

/** The machine this run pretends, or none. */
export const WEAK_MACHINE: WeakMachine = parseWeakMachine(typeof __WEAK_MACHINE__ !== 'undefined' ? __WEAK_MACHINE__ : '');

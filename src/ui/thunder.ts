/** THUNDER (`world/weather.ts`): the sound of a strike, made with the Web Audio API */

/** The longest clap (far off), in seconds: `length` below at `near` 0. */
const LONGEST = 5.6;
/** Seconds of noise kept: the longest clap, and room to start it anywhere in the first part. */
const NOISE_SECONDS = LONGEST + 4;
/** DO NOT make it per strike: that was 125 to 270 thousand samples of `Math.random` on the page at each bolt */
interface Audio {
  readonly ctx: AudioContext;
  noise: AudioBuffer | null;
  /** The claps asked before the noise was made (`playThunder`): played once it is, in an idle moment of the page. */
  waiting: (() => void)[] | null;
}
let audio: Audio | null = null;
function noiseOf(state: Audio): AudioBuffer {
  if (state.noise) return state.noise;
  const { ctx } = state;
  const frames = Math.floor(ctx.sampleRate * NOISE_SECONDS);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  // Brown noise: a random walk, the rumble of air.
  let last = 0;
  for (let i = 0; i < frames; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    data[i] = last * 3.5;
  }
  return (state.noise = buffer);
}

/** Plays a thunderclap for a strike `metres` away, at `volume` (0..1). */
export function playThunder(metres: number, volume: number): void {
  if (volume <= 0) return;
  try {
    audio ??= { ctx: new AudioContext(), noise: null, waiting: null };
  } catch {
    return;
  }
  const state = audio;
  // DO NOT make the noise in the frame of the first strike (its callback): in an idle moment, the clap played then (its sound comes late anyway, `delay`).
  const idle = (globalThis as { requestIdleCallback?: (run: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
  if (!state.noise && idle) {
    if (!state.waiting) {
      const waiting: (() => void)[] = state.waiting = [];
      idle(() => { noiseOf(state); state.waiting = null; for (const play of waiting) play(); }, { timeout: 500 });
    }
    state.waiting!.push(() => playThunder(metres, volume));
    return;
  }
  const { ctx } = state;
  // Browsers start audio only after the player has touched the page.
  if (ctx.state === 'suspended') void ctx.resume();
  const delay = Math.min(6, metres / 343);
  const near = 1 / (1 + metres / 500);
  const length = 2.6 + 3 * (1 - near);
  const source = ctx.createBufferSource();
  source.buffer = noiseOf(audio);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  // A near strike keeps its high crack; far off, only the low roll arrives.
  filter.frequency.value = 220 + 1400 * near * near;
  const gain = ctx.createGain();
  const start = ctx.currentTime + delay;
  const peak = Math.max(0.0002, volume * (0.35 + 0.65 * near));
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.03 + 0.3 * (1 - near));
  // Rolls: the sound of the far parts of the channel coming in later.
  gain.gain.setTargetAtTime(peak * 0.45, start + 0.35, 0.4);
  gain.gain.setTargetAtTime(peak * 0.7, start + 0.9 + Math.random() * 0.6, 0.25);
  gain.gain.setTargetAtTime(0.0001, start + 1.6 + Math.random(), length * 0.25);
  source.connect(filter).connect(gain).connect(ctx.destination);
  // A part of the noise of its own: no two claps the same stretch.
  source.start(start, Math.random() * (NOISE_SECONDS - length), length);
}

/**
 * THUNDER (`world/weather.ts`): the sound of a strike, made with the Web
 * Audio API - noise filtered low into a rumble, a sharp crack when the
 * strike is near and a long low roll when it is far, heard as long after the
 * flash as sound takes to come that far (343 m/s).
 */
/** The longest a clap lasts, seconds (a far strike: 2.6 + 3). */
const LONGEST = 5.6;
/**
 * The rumble, made ONCE (`createThunder`): brown noise as long as the longest clap, each clap
 * playing a stretch of it (`AudioBufferSourceNode.start(when, offset,
 * duration)`); its filter and its rolls make each one its own. DO NOT make a
 * buffer per strike: 125 to 270 thousand samples and up to a megabyte on the
 * main thread at every bolt.
 */
function rumbleOf(ctx: AudioContext): AudioBuffer {
  const frames = Math.floor(ctx.sampleRate * LONGEST);
  const rumble = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = rumble.getChannelData(0);
  // Brown noise: a random walk, the rumble of air.
  let last = 0;
  for (let i = 0; i < frames; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    data[i] = last * 3.5;
  }
  return rumble;
}

export interface Thunder {
  /** Plays a thunderclap for a strike `metres` away, at `volume` (0..1). */
  play(metres: number, volume: number): void;
}

/** The thunder of a game: its audio context and its rumble, made on the first clap. */
export function createThunder(): Thunder {
  let context: AudioContext | null = null;
  let rumble: AudioBuffer | null = null;
  return {
    play(metres, volume) {
      if (volume <= 0) return;
      try {
        context ??= new AudioContext();
      } catch {
        return;
      }
      const ctx = context;
      if (!rumble || rumble.sampleRate !== ctx.sampleRate) rumble = rumbleOf(ctx);
      playClap(ctx, rumble, metres, volume);
    },
  };
}

/** One clap on `ctx`, a stretch of `rumble`. */
function playClap(ctx: AudioContext, rumble: AudioBuffer, metres: number, volume: number): void {
  // Browsers start audio only after the player has touched the page.
  if (ctx.state === 'suspended') void ctx.resume();
  const delay = Math.min(6, metres / 343);
  const near = 1 / (1 + metres / 500);
  const length = 2.6 + 3 * (1 - near);
  const source = ctx.createBufferSource();
  source.buffer = rumble;
  // A stretch of the rumble of its own length, from anywhere it fits.
  const offset = Math.random() * Math.max(0, LONGEST - length);
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
  source.start(start, offset, length);
}

/**
 * THUNDER (`world/weather.ts`): the sound of a strike, made with the Web
 * Audio API - noise filtered low into a rumble, a sharp crack when the
 * strike is near and a long low roll when it is far, heard as long after the
 * flash as sound takes to come that far (343 m/s).
 */
let context: AudioContext | null = null;

/** Plays a thunderclap for a strike `metres` away, at `volume` (0..1). */
export function playThunder(metres: number, volume: number): void {
  if (volume <= 0) return;
  try {
    context ??= new AudioContext();
  } catch {
    return;
  }
  const ctx = context;
  // Browsers start audio only after the player has touched the page.
  if (ctx.state === 'suspended') void ctx.resume();
  const delay = Math.min(6, metres / 343);
  const near = 1 / (1 + metres / 500);
  const length = 2.6 + 3 * (1 - near);
  const frames = Math.floor(ctx.sampleRate * length);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  // Brown noise: a random walk, the rumble of air.
  let last = 0;
  for (let i = 0; i < frames; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    data[i] = last * 3.5;
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
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
  source.start(start);
  source.stop(start + length);
}

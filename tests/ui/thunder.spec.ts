import { afterEach, describe, expect, it, vi } from 'vitest';

/** THE FIRST THUNDERCLAP'S NOISE IS MADE IN AN IDLE MOMENT, NOT IN THE FRAME OF THE STRIKE (`ui/thunder.ts`, plan K6) */

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

function fakeAudio(): { made: () => number; started: () => number } {
  let made = 0, started = 0;
  const node = (extra: object = {}): object => ({ ...extra, connect: (next: object) => next });
  class FakeContext {
    sampleRate = 8000; state = 'running'; currentTime = 0; destination = node();
    createBuffer(_c: number, frames: number): object { made++; const data = new Float32Array(frames); return { getChannelData: () => data }; }
    createBufferSource(): object { return node({ buffer: null, start: () => { started++; } }); }
    createBiquadFilter(): object { return node({ type: '', frequency: { value: 0 } }); }
    createGain(): object { const p = { setValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {} }; return node({ gain: p }); }
    resume(): Promise<void> { return Promise.resolve(); }
  }
  vi.stubGlobal('AudioContext', FakeContext);
  return { made: () => made, started: () => started };
}

describe('the thunder', () => {
  it('makes its noise once, when the page is idle, and plays the claps asked meanwhile', async () => {
    const audio = fakeAudio();
    const idle: (() => void)[] = [];
    vi.stubGlobal('requestIdleCallback', (run: () => void) => { idle.push(run); return 1; });
    const { playThunder } = await import('@ui/thunder');
    playThunder(800, 1);
    playThunder(300, 1);
    expect(audio.made()).toBe(0);
    expect(audio.started()).toBe(0);
    expect(idle).toHaveLength(1);
    idle[0]!();
    expect(audio.made()).toBe(1);
    expect(audio.started()).toBe(2);
    // Made once: the next clap plays at once.
    playThunder(500, 1);
    expect(audio.made()).toBe(1);
    expect(audio.started()).toBe(3);
  });
});

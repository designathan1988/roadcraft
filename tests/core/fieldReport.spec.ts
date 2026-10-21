import { describe, expect, it, vi } from 'vitest';
import { ProblemLog } from '../../src/core/assert';
import { SampleRing } from '../../src/core/sampleRing';
import { FieldReport, SessionSummary, problemBridge, wireFieldReport, watchContext, type Problem } from '../../src/fieldReport';

/** FIELD PROBLEMS: the page's errors, failed `ensure`s and lost contexts reach the shell's local log through one funnel (`src/fieldReport.ts`). */
const fakeShell = (): { told: Problem[]; host: unknown } => {
  const told: Problem[] = [];
  return { told, host: { roadcraftDesktop: { reportProblem: (problem: Problem) => told.push(problem) } } };
};

describe('the field problem report', () => {
  it('finds the shell only when it offers the call', () => {
    expect(problemBridge({})).toBeNull();
    expect(problemBridge({ roadcraftDesktop: { state: () => null } })).toBeNull();
    expect(problemBridge(fakeShell().host)).not.toBeNull();
  });

  it("sends failed ensures, uncaught errors and rejections to the shell's log", () => {
    const { told, host } = fakeShell();
    const page = new EventTarget();
    const problems = new ProblemLog();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    wireFieldReport({ page, bridge: problemBridge(host), problems, report: new FieldReport() });
    problems.ensure(false, 'index out of step');
    const error = Object.assign(new Event('error'), { error: new TypeError('x is undefined'), message: 'x is undefined' });
    page.dispatchEvent(error);
    page.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('load failed') }));
    errorSpy.mockRestore();
    expect(told.map((p) => [p.kind, p.message])).toEqual([
      ['ensure', 'index out of step'],
      ['error', 'TypeError: x is undefined'],
      ['rejection', 'Error: load failed'],
    ]);
    expect(told[1]!.detail).toContain('TypeError');
  });

  it('goes to the console in a browser, never to a shell', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const page = new EventTarget();
    const report = wireFieldReport({ page, bridge: null, problems: new ProblemLog(), report: new FieldReport() });
    report.report({ kind: 'note', message: 'hello' });
    expect(info).toHaveBeenCalledWith('[field] note: hello', '');
    info.mockRestore();
  });

  it('tells the context lost and back, and holds back a problem repeated every frame', () => {
    const report = new FieldReport();
    const seen: Problem[] = [];
    report.addSink((p) => seen.push(p));
    const canvas = new EventTarget();
    watchContext(canvas, report);
    canvas.dispatchEvent(new Event('webglcontextlost'));
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    for (let i = 0; i < 10; i++) report.report({ kind: 'error', message: 'same' });
    expect(seen.map((p) => p.kind)).toEqual(['webgl-lost', 'webgl-restored', 'error', 'error', 'error']);
    expect(report.repeats).toBe(7);
  });

  it('keeps telling the other sinks when one throws (a remote reporter down)', () => {
    const report = new FieldReport();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: string[] = [];
    report.addSink(() => { throw new Error('offline'); });
    report.addSink((p) => seen.push(p.message));
    report.report({ kind: 'note', message: 'still here' });
    warn.mockRestore();
    expect(seen).toEqual(['still here']);
  });

  it("sums a session up once: the GPU, the tiers, the frames' percentiles, the heap's peak", () => {
    let now = 0;
    const frames = new SampleRing(100);
    for (let i = 1; i <= 100; i++) frames.push(i);
    const summary = new SessionSummary(() => now, () => frames, () => 'ANGLE (NVIDIA GeForce RTX 3060)');
    summary.level('high', 'start');
    now = 30_000;
    summary.level('medium', 'auto');
    summary.sample(200 * 1048576);
    now = 120_000;
    const report = new FieldReport();
    const seen: Problem[] = [];
    report.addSink((p) => seen.push(p));
    summary.send(report, 150 * 1048576);
    summary.send(report);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.data).toMatchObject({
      minutes: 2, gpu: 'ANGLE (NVIDIA GeForce RTX 3060)', levels: '0s high start | 30s medium auto',
      frames: 100, frameP50: 50, frameP95: 95, frameP99: 99, peakHeapMb: 200, worstP95: 95,
    });
  });
});

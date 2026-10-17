import { afterEach, describe, expect, it, vi } from 'vitest';

/** A job worker drops a lane's entry when the page lets the lane go (`JobPort.terminate`): lanes made and let go again and again leave nothing behind */

describe('a job worker', () => {
  afterEach(() => {
    vi.doUnmock('@/render/ecology.worker');
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('holds no entry for lanes opened and closed', async () => {
    const scope: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: () => void } = { onmessage: null, postMessage: () => {} };
    vi.stubGlobal('self', scope);
    vi.doMock('@/render/ecology.worker', () => ({ serve: () => {} }));
    const { openPorts } = await import('@/job.worker');
    for (let port = 1; port <= 50; port++) scope.onmessage!({ data: { port, service: 'ecology', data: { n: port } } });
    expect(openPorts()).toBe(50);
    for (let port = 1; port <= 50; port++) scope.onmessage!({ data: { close: port } });
    expect(openPorts()).toBe(0);
  });
});

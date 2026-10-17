import { describe, expect, it } from 'vitest';
import type { DataTexture, WebGLRenderer } from 'three';
import { BODY_WIDTH, createClassBodies } from '@render/people/crowdBodies';
import { bakeBodyPixels, sharedShape } from '@render/people/bodyBake';
import { serve } from '@render/people/crowdBodies.worker';

/** A renderer that records the rows sent up (`copyTextureToTexture` from data). */
function recorder(): { renderer: WebGLRenderer; sent: { row: number; data: Float32Array }[] } {
  const sent: { row: number; data: Float32Array }[] = [];
  const renderer = {
    autoClear: true, getRenderTarget: () => null, setRenderTarget: () => {}, initRenderTarget: () => {}, compile: () => {},
    copyTextureToTexture: (src: DataTexture, _dst: unknown, _region: unknown, at: { y: number }) => {
      sent.push({ row: at.y, data: (src.image as { data: Float32Array }).data });
    },
  };
  return { renderer: renderer as unknown as WebGLRenderer, sent };
}

describe("a class's bodies", () => {
  // Two vertices, two shape components: vertex v's component k at texel v * 2 + k.
  const shapePixels = Float32Array.from([1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 3, 0, 4, 0, 0, 0]);
  const jointBasis = Float32Array.from([1, 0, 0, 0, 1, 0]);

  it('bakes each body made from the shape basis and sends it up once, at its own rows, keeping no CPU image', () => {
    const bodies = createClassBodies(shapePixels, 2, 2, jointBasis, 1);
    const { renderer, sent } = recorder();
    expect(bodies.pick(Float32Array.from([1, 0])).index).toBe(0);
    expect(bodies.pick(Float32Array.from([0, 2])).index).toBe(1);
    expect(bodies.pick(Float32Array.from([1, 0])).index).toBe(0);
    bodies.flush(renderer);
    expect(sent.map((s) => s.row)).toEqual([0, 1]);
    expect(sent[0]!.data.length).toBe(BODY_WIDTH * 4);
    expect([...sent[0]!.data.subarray(0, 8)]).toEqual([1, 0, 0, 0, 0, 0, 3, 0]);
    expect([...sent[1]!.data.subarray(0, 8)]).toEqual([0, 4, 0, 0, 8, 0, 0, 0]);
    bodies.flush(renderer);
    expect(sent.length).toBe(2);
    expect(bodies.bytes).toBe(BODY_WIDTH * 16 * 16);
  });

  it('bakes every body made again after a restore', () => {
    const bodies = createClassBodies(shapePixels, 2, 2, jointBasis, 1);
    const { renderer, sent } = recorder();
    bodies.pick(Float32Array.from([1, 0]));
    bodies.pick(Float32Array.from([0, 1]));
    bodies.flush(renderer);
    bodies.restore();
    bodies.flush(renderer);
    expect(sent.map((s) => s.row)).toEqual([0, 1, 0, 1]);
  });

  it('bakes a new body in a job from the basis shared once, the same pixels as on the page, and says when it is in the texture', async () => {
    const shared = sharedShape(shapePixels);
    expect(shared.buffer instanceof SharedArrayBuffer).toBe(true);
    expect([...shared]).toEqual([...shapePixels]);
    // The job worker's service, as the pool would serve it.
    let answer: Float32Array | null = null;
    const scope = { onmessage: null as ((e: MessageEvent) => void) | null, postMessage: (data: unknown) => { answer = data as Float32Array; } };
    serve(scope as unknown as Parameters<typeof serve>[0]);
    const job = { shape: shared, vertexCount: 2, shapes: 2, stride: BODY_WIDTH, coefficients: Float32Array.from([0, 2]) };
    scope.onmessage!(new MessageEvent('message', { data: job }));
    expect([...answer!.subarray(0, 8)]).toEqual([0, 4, 0, 0, 8, 0, 0, 0]);
    expect([...answer!]).toEqual([...bakeBodyPixels(job)]);
    // Picked, its vertices are in the texture once `ready` settles (here at once: no job worker in the tests).
    const bodies = createClassBodies(shared, 2, 2, jointBasis, 1);
    await expect(bodies.pick(Float32Array.from([0, 2])).ready).resolves.toBeUndefined();
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Texture, type WebGLRenderer } from 'three';
import { cancelUploads, drainUploads, queueUpload } from '@render/uploads';

/** TEXTURES SENT TO THE GPU AHEAD OF THEIR FIRST DRAW (`uploads.ts`, R19) */
describe('textures sent ahead', () => {
  it('sends every texture queued at once, each once, none cancelled', () => {
    const sent: Texture[] = [];
    const renderer = { initTexture: (t: Texture) => { sent.push(t); } } as unknown as WebGLRenderer;
    const textures = Array.from({ length: 5 }, () => new Texture());
    queueUpload(...textures);
    cancelUploads([textures[2]!]);
    queueUpload(textures[0]);
    drainUploads(renderer);
    expect(sent).toEqual([textures[0], textures[1], textures[3], textures[4]]);
    queueUpload(textures[0]);
    drainUploads(renderer);
    expect(sent.length).toBe(4);
  });

  it('is drained before the frame draws and after it, never one a frame', () => {
    const source = readFileSync('src/render/renderer.ts', 'utf8');
    expect(source).not.toMatch(/drainUploads\(renderer, \d+\)/);
    const before = source.indexOf('drainUploads(renderer);'), render = source.indexOf('post.render(delta);');
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(render);
    expect(source.indexOf('drainUploads(renderer);', render)).toBeGreaterThan(render);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Morpher, type PeoplePacks } from '@people/body/morph';
import { HAIR_STYLES, generateHair, type HairBase } from '@people/hair/procedural';

/**
 * Every hairstyle the game hands out is grown, in finite numbers. A braid's
 * strand rooted at its tie made a card of one point (NaN corners), and the
 * grid search for the nearest head vertices never ended on a NaN point: the
 * game froze on the first girl with a braid (docs/performance.md #5).
 */
const DIR = join(__dirname, '..', '..', 'public', 'models', 'people');
const buf = (f: string): ArrayBuffer => { const b = readFileSync(join(DIR, f)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const json = <T>(f: string): T => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as T;

describe('every hairstyle', () => {
  const base = json<PeoplePacks['base'] & { sections: { name: string; byteOffset: number; count: number }[]; vertexGroups: Record<string, [number, number][]> }>('base.json');
  const baseBin = buf('base.bin');
  const morpher = new Morpher({
    base, baseBin, macro: json('targets-macro-pca.json'), macroBin: buf('targets-macro-pca.bin'),
    local: json('targets-local.json'), localBin: buf('targets-local.bin'), modifiers: json('modifiers.json'),
  });
  const skeleton = json<{ bones: { name: string }[]; weights: { layout: { joints: { byteOffset: number }; weights: { byteOffset: number } } } }>('skeleton-game-engine.json');
  const weightsBin = buf('weights-game-engine.bin');
  const faces = base.sections.find((s) => s.name === 'faceVerts')!;
  const hairBase: HairBase = {
    positions: morpher.base, vertexCount: base.vertexCount, bodyRange: base.vertexGroups['body']!,
    joints: new Uint8Array(weightsBin, skeleton.weights.layout.joints.byteOffset, base.vertexCount * 4),
    weights: new Uint16Array(weightsBin, skeleton.weights.layout.weights.byteOffset, base.vertexCount * 4),
    boneNames: skeleton.bones.map((b) => b.name),
    faces: new Uint16Array(baseBin, faces.byteOffset, faces.count * 4),
  };

  for (const style of Object.values(HAIR_STYLES)) {
    it(`${style.name} is grown in finite numbers`, () => {
      const pack = generateHair(style, hairBase);
      expect(pack.refs.length).toBeGreaterThan(0);
      for (const array of [pack.offsets, pack.weights]) {
        let bad = 0;
        for (const value of array) if (!Number.isFinite(value)) bad++;
        expect(bad).toBe(0);
      }
    }, 10_000);
  }
});

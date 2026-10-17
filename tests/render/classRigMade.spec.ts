import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { classRigMade, rigFromMade } from '@render/people/classRigMade';

import { DEFAULT_MACRO } from '@people/body/macro';
import { Morpher, type PeoplePacks } from '@people/body/morph';
import { randomPerson } from '@people/spec';
import { createPersonRig, type SkeletonMeta } from '@render/people/personRig';
import type { PersonMeshData } from '@render/people/personMesh';
import { captureBind, captureBindRotations } from '@render/citizenWalk';

const DIR = join(__dirname, '..', '..', 'public', 'models', 'people');
const buf = (f: string): ArrayBuffer => {
  const b = readFileSync(join(DIR, f));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const json = <T>(f: string): T => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as T;
const base = json<PeoplePacks['base'] & { faceGroups: string[]; sections: { name: string; byteOffset: number; count: number }[] }>('base.json');
const baseBin = buf('base.bin');
const packs: PeoplePacks = {
  base, baseBin,
  macro: json('targets-macro-pca.json'), macroBin: buf('targets-macro-pca.bin'),
  local: json('targets-local.json'), localBin: buf('targets-local.bin'),
  modifiers: json('modifiers.json'),
};
const skeleton = json<SkeletonMeta & { weights: { vertexCount: number; layout: { joints: { byteOffset: number }; weights: { byteOffset: number } } } }>('skeleton-game-engine.json');
const weightsBin = buf('weights-game-engine.bin');
const section = (name: string) => base.sections.find((s) => s.name === name)!;
const data: PersonMeshData = {
  vertexCount: base.vertexCount,
  faces: new Uint16Array(baseBin, section('faceVerts').byteOffset, section('faceVerts').count * 4),
  faceGroup: new Uint8Array(baseBin, section('faceGroup').byteOffset, section('faceGroup').count),
  faceGroups: base.faceGroups,
  vertexGroups: base.vertexGroups,
  joints: new Uint8Array(weightsBin, skeleton.weights.layout.joints.byteOffset, base.vertexCount * 4),
  weights: new Uint16Array(weightsBin, skeleton.weights.layout.weights.byteOffset, base.vertexCount * 4),
  boneNames: skeleton.bones.map((b) => b.name),
};
const morpher = new Morpher(packs);
const bodyRange = base.vertexGroups['body']!;


/** A procedural class's rig made on the people's worker comes to the page as the same body: bones, binds, vertices, where each vertex comes from, and its face moves */
describe("a class's rig from the people's worker", () => {
  it('is put together on the page as the rig it was made from', () => {
    // As a class's rig is made (`proceduralBake.ts` classRig): nude, its skin textured.
    const person = randomPerson(3, 3);
    const rig = createPersonRig({
      nude: true, texturedSkin: true, data, skeleton, bodyRange, positions: morpher.shape(person.body), look: { ...person.look, hairCut: 'none', hat: 'none', extras: [] },
      capture: captureBind('male'), captureAxes: captureBindRotations('male'),
    });
    // Where each vertex comes from, as a class wearing its eyes has it (`dressedGeometry`): one known here.
    const n = rig.mesh.geometry.getAttribute('position').count;
    rig.mesh.geometry.userData['morphSource'] = { kind: Int16Array.from({ length: n }, (_, v) => (v % 3) - 1), index: Int32Array.from({ length: n }, (_, v) => v * 2) };
    const shape = rig.deltasData!.positions;
    const { made, transfer } = classRigMade(rig, DEFAULT_MACRO, shape);
    // The worker keeps its own rig: every array sent is a copy, moved.
    expect(made.shape).not.toBe(shape);
    expect(transfer.length).toBeGreaterThan(5);
    // One copy sent for the shape and the posture's positions.
    expect(made.shape).toBe(made.deltas.positions);
    const { rig: back } = rigFromMade(made, data.weights, data.joints);
    expect(back.mesh.skeleton.bones.map((b) => b.name)).toEqual(rig.mesh.skeleton.bones.map((b) => b.name));
    back.mesh.skeleton.boneInverses.forEach((m, i) => m.elements.forEach((x, k) => expect(x === rig.mesh.skeleton.boneInverses[i]!.elements[k]).toBe(true)));
    expect(Array.from(back.mesh.geometry.getAttribute('position').array)).toEqual(Array.from(rig.mesh.geometry.getAttribute('position').array));
    const source = rig.mesh.geometry.userData['morphSource'] as { kind: Int16Array; index: Int32Array };
    const got = back.mesh.geometry.userData['morphSource'] as { kind: Int16Array; index: Int32Array };
    expect(Array.from(got.kind)).toEqual(Array.from(source.kind));
    expect(Array.from(got.index)).toEqual(Array.from(source.index));
    expect(back.height).toBe(rig.height);
    // A face's moves the same here as on the rig.
    const offset = new Float32Array(shape.length);
    for (let v = 0; v < offset.length; v += 7) offset[v] = 0.01;
    const vertices = [0, 10, 100, 1000];
    expect(Array.from(back.deltasAt!(offset, vertices))).toEqual(Array.from(rig.deltasAt!(offset, vertices)));
  });

  it('keeps one copy of its posture on an isolated page: the shared one, nothing of what the worker sent', () => {
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = true;
    try {
      const person = randomPerson(4, 4);
      const rig = createPersonRig({
        nude: true, texturedSkin: true, data, skeleton, bodyRange, positions: morpher.shape(person.body), look: { ...person.look, hairCut: 'none', hat: 'none', extras: [] },
        capture: captureBind('male'), captureAxes: captureBindRotations('male'),
      });
      const n = rig.mesh.geometry.getAttribute('position').count;
      rig.mesh.geometry.userData['morphSource'] = { kind: new Int16Array(n), index: new Int32Array(n) };
      const { made } = classRigMade(rig, DEFAULT_MACRO, rig.deltasData!.positions);
      const { rig: back, shape } = rigFromMade(made, data.weights, data.joints);
      const d = back.deltasData!;
      expect(d.positions.buffer).toBeInstanceOf(SharedArrayBuffer);
      expect(d.linear.buffer).toBeInstanceOf(SharedArrayBuffer);
      // The class's shape is the same array: one copy, and the arrays the worker sent are not referenced.
      expect(shape).toBe(d.positions);
      expect(d.positions).not.toBe(made.deltas.positions);
      expect(d.linear).not.toBe(made.deltas.linear);
      expect(Array.from(d.positions)).toEqual(Array.from(made.deltas.positions));
    } finally {
      delete (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
    }
  });
});

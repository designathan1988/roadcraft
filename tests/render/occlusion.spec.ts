import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';

import type { CameraSolids, OccluderVisit } from '@world/buildings/cameraSolids';
import { OcclusionBuffer } from '@render/occlusion';

/** A row of walls as the occluders: each an axis-aligned box in the plan, standing from 0 to `top`. */
function solidsOf(boxes: readonly (readonly [number, number, number, number, number])[]): CameraSolids {
  return {
    floorAt: () => -Infinity,
    roofAt: () => -Infinity,
    forEachIn: () => {},
    forEachInAny: () => {},
    forEachOccluder(_x0: number, _y0: number, _x1: number, _y1: number, visit: OccluderVisit) {
      for (const [x0, y0, x1, y1, top] of boxes) visit((x0 + x1) / 2, (y0 + y1) / 2, 1, 0, (x0 - x1) / 2, (y0 - y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, 0, top);
    },
  };
}

/** An eye at street height at the plan's origin, looking north (the plan's +y, three's -z). */
function streetEye(): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, 16 / 9, 1, 20000);
  camera.position.set(0, 2, 0);
  camera.lookAt(0, 2, -100);
  camera.updateMatrixWorld();
  return camera;
}

describe('occlusion culling on the page', () => {
  // A wall 40 m ahead, 200 m wide and 10 m high (11 degrees over the eye's level at its front).
  const wall = solidsOf([[-100, 40, 100, 60, 10]]);

  it('hides a box wholly behind a wall', () => {
    const buffer = new OcclusionBuffer();
    buffer.build(streetEye(), 16 / 9, wall, () => true, 1);
    expect(buffer.hidden(-10, 100, 10, 120, 0, 15)).toBe(true);
  });

  it('never hides a box in front of the wall, nor one taller than it reaches', () => {
    const buffer = new OcclusionBuffer();
    buffer.build(streetEye(), 16 / 9, wall, () => true, 1);
    expect(buffer.hidden(-10, 10, 10, 20, 0, 20)).toBe(false);
    // A tower behind it rising far over its top.
    expect(buffer.hidden(-10, 100, 10, 120, 0, 300)).toBe(false);
  });

  it('never hides a box that shows past the end of the wall', () => {
    const buffer = new OcclusionBuffer();
    buffer.build(streetEye(), 16 / 9, wall, () => true, 1);
    // A narrow wall (18-27 degrees each side); the box 35-42 degrees east of the eye's line, on the screen beside it.
    const narrow = new OcclusionBuffer();
    narrow.build(streetEye(), 16 / 9, solidsOf([[-20, 40, 20, 60, 10]]), () => true, 1);
    expect(narrow.hidden(150, 190, 170, 210, 0, 8)).toBe(false);
    expect(narrow.hidden(-5, 190, 5, 210, 0, 8)).toBe(true);
    expect(buffer.hidden(-5, 190, 5, 210, 0, 8)).toBe(true);
  });

  it('lays no wall of a cell that is not drawn: nothing hidden behind a building not on the screen', () => {
    const buffer = new OcclusionBuffer();
    buffer.build(streetEye(), 16 / 9, wall, () => false, 1);
    expect(buffer.hidden(-10, 100, 10, 120, 0, 20)).toBe(false);
  });

  it('never hides a box reaching behind the eye', () => {
    const buffer = new OcclusionBuffer();
    buffer.build(streetEye(), 16 / 9, wall, () => true, 1);
    expect(buffer.hidden(-10, -10, 10, 120, 0, 20)).toBe(false);
  });

  it('two walls side by side with a gap: a box seen through the gap is drawn', () => {
    const buffer = new OcclusionBuffer();
    buffer.build(streetEye(), 16 / 9, solidsOf([[-100, 40, -3, 60, 10], [3, 40, 100, 60, 10]]), () => true, 1);
    // Straight ahead through the 6 m street between them.
    expect(buffer.hidden(-2, 200, 2, 210, 0, 10)).toBe(false);
    // Well to the side, behind the west wall.
    expect(buffer.hidden(-60, 100, -40, 120, 0, 10)).toBe(true);
  });
});

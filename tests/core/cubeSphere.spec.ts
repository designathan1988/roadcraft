import { describe, expect, it } from 'vitest';
import {
  FACE_HALF,
  FACES,
  PLANET_RADIUS,
  SIDES,
  chartScale,
  faceOfDirection,
  faceToSphereInto,
  homeFaceOf,
  neighbourOf,
  sphereToFaceInto,
  transferInto,
  type Side,
  type Transfer,
} from '@core/cubeSphere';
import { Rng } from '@core/rng';

const unit = (rng: Rng): number => rng.u32() / 2 ** 32;
const s = { x: 0, y: 0, z: 0 };
const s2 = { x: 0, y: 0, z: 0 };
const p = { x: 0, y: 0 };
const tr: Transfer = { x: 0, y: 0, dx: 0, dy: 0, stretch: 0 };

/** A point on a face's side, `t` in -1..1 along it. */
function sidePoint(side: Side, t: number): { x: number; y: number; dx: number; dy: number } {
  const a = t * FACE_HALF;
  if (side === 'east') return { x: FACE_HALF, y: a, dx: 1, dy: 0 };
  if (side === 'west') return { x: -FACE_HALF, y: a, dx: -1, dy: 0 };
  if (side === 'north') return { x: a, y: FACE_HALF, dx: 0, dy: 1 };
  return { x: a, y: -FACE_HALF, dx: 0, dy: -1 };
}

const angleBetween = (ax: number, ay: number, bx: number, by: number): number =>
  Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by)) * (180 / Math.PI);

describe('cube-sphere charts', () => {
  it('the faces are right-handed and orthonormal', () => {
    for (const f of FACES) {
      const c = f.centre, e = f.east, n = f.north;
      expect(e.y * n.z - e.z * n.y).toBeCloseTo(c.x, 12);
      expect(e.z * n.x - e.x * n.z).toBeCloseTo(c.y, 12);
      expect(e.x * n.y - e.y * n.x).toBeCloseTo(c.z, 12);
    }
  });

  it('takes a face point to the sphere and back, exactly, on the face and past it', () => {
    const rng = new Rng(7);
    let worst = 0;
    for (let i = 0; i < 200_000; i++) {
      const face = i % 6;
      const x = (unit(rng) * 2 - 1) * FACE_HALF * 1.2;
      const y = (unit(rng) * 2 - 1) * FACE_HALF * 1.2;
      faceToSphereInto(face, x, y, s);
      expect(sphereToFaceInto(face, s, p)).not.toBeNull();
      worst = Math.max(worst, Math.abs(p.x - x), Math.abs(p.y - y));
    }
    expect(worst).toBeLessThan(1e-9 * PLANET_RADIUS);
  });

  it('gives the planet a scale of 1 along a face\'s axes through its centre', () => {
    for (let face = 0; face < 6; face++) {
      for (const t of [-0.9, -0.5, 0, 0.5, 0.9]) {
        expect(chartScale(face, t * FACE_HALF, 0, 1, 0)).toBeCloseTo(1, 9);
        expect(chartScale(face, 0, t * FACE_HALF, 0, 1)).toBeCloseTo(1, 9);
      }
    }
  });

  it('every side has one neighbour, and the neighbour has it back', () => {
    for (let face = 0; face < 6; face++) {
      const seen = new Set<number>();
      for (const side of SIDES) {
        const n = neighbourOf(face, side);
        expect(n).not.toBe(face);
        seen.add(n);
        expect(SIDES.some((back) => neighbourOf(n, back) === face)).toBe(true);
      }
      expect(seen.size).toBe(4);
    }
  });

  it('two faces give a border point the same sphere point, and a crossing keeps its heading', () => {
    let worstGap = 0;
    let worstMidTurn = 0;
    let worstTurn = 0;
    let worstStretch = 0;
    let obliqueStretch = 0;
    for (let face = 0; face < 6; face++) {
      for (const side of SIDES) {
        const n = neighbourOf(face, side);
        for (let i = 0; i <= 40; i++) {
          const t = -1 + (2 * i) / 40;
          const b = sidePoint(side, t);
          faceToSphereInto(face, b.x, b.y, s);
          sphereToFaceInto(n, s, p);
          faceToSphereInto(n, p.x, p.y, s2);
          worstGap = Math.max(worstGap, Math.hypot(s.x - s2.x, s.y - s2.y, s.z - s2.z) * PLANET_RADIUS);
          // The neighbour's point is on its own border.
          expect(Math.max(Math.abs(p.x), Math.abs(p.y))).toBeCloseTo(FACE_HALF, 6);
          // A road crossing at 30 degrees off the perpendicular.
          for (const off of [-Math.PI / 6, 0, Math.PI / 6]) {
            const dx = b.dx * Math.cos(off) - b.dy * Math.sin(off);
            const dy = b.dx * Math.sin(off) + b.dy * Math.cos(off);
            transferInto(face, b.x, b.y, dx, dy, n, tr);
            // Heading along the neighbour's own chart a hair further on.
            const ahead = 0.01;
            faceToSphereInto(face, b.x + dx * ahead, b.y + dy * ahead, s2);
            const q = sphereToFaceInto(n, s2, { x: 0, y: 0 });
            if (!q) throw new Error('no chart');
            const turn = angleBetween(tr.dx, tr.dy, q.x - tr.x, q.y - tr.y);
            worstTurn = Math.max(worstTurn, turn);
            if (Math.abs(t) <= 0.5) worstMidTurn = Math.max(worstMidTurn, turn);
            // At a side's middle the two maps meet as an unfolding: same
            // scale every way. Away from it the faces' grids are sheared
            // opposite ways, so an oblique metre is not the same metre on
            // both maps; the sphere's heading still carries on (next spec).
            if (t === 0) worstStretch = Math.max(worstStretch, Math.abs(tr.stretch - 1));
            else obliqueStretch = Math.max(obliqueStretch, Math.abs(tr.stretch - 1));
          }
        }
      }
    }
    expect(worstGap).toBeLessThan(1e-6);
    // The transfer is the chart's own derivative: it agrees with stepping.
    expect(worstTurn).toBeLessThan(0.01);
    expect(worstMidTurn).toBeLessThan(0.01);
    expect(worstStretch).toBeLessThan(1e-6);
    console.info(`cube-sphere: a 30-degree crossing changes its map metre by up to ${(obliqueStretch * 100).toFixed(1)}% (at the corners)`);
  });

  it('a straight road over a border does not bend there', () => {
    // A road on face A straight through its east border, continued on the
    // neighbour by the transfer: its heading on the sphere either side of the
    // border agrees (the charts are C1 across the border).
    let worst = 0;
    for (let face = 0; face < 6; face++) {
      for (const side of SIDES) {
        const n = neighbourOf(face, side);
        for (const t of [-0.8, -0.3, 0, 0.3, 0.8]) {
          for (const off of [-0.6, 0, 0.6]) {
            const b = sidePoint(side, t);
            const dx = b.dx * Math.cos(off) - b.dy * Math.sin(off);
            const dy = b.dx * Math.sin(off) + b.dy * Math.cos(off);
            const h = 0.5;
            // Sphere heading just before the border, on A.
            faceToSphereInto(face, b.x - dx * h, b.y - dy * h, s);
            faceToSphereInto(face, b.x, b.y, s2);
            const ax = s2.x - s.x, ay = s2.y - s.y, az = s2.z - s.z;
            // Just after, on the neighbour along the transferred heading.
            transferInto(face, b.x, b.y, dx, dy, n, tr);
            faceToSphereInto(n, tr.x + tr.dx * h, tr.y + tr.dy * h, s);
            const bx = s.x - s2.x, by = s.y - s2.y, bz = s.z - s2.z;
            const cos = (ax * bx + ay * by + az * bz) / (Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz));
            worst = Math.max(worst, Math.acos(Math.min(1, cos)) * (180 / Math.PI));
          }
        }
      }
    }
    expect(worst).toBeLessThan(0.05);
  });

  it('a face reaches past its border onto its neighbours, corners included', () => {
    for (let face = 0; face < 6; face++) {
      expect(homeFaceOf(face, 0, 0)).toBe(face);
      expect(homeFaceOf(face, FACE_HALF + 200, 0)).toBe(neighbourOf(face, 'east'));
      expect(homeFaceOf(face, 0, -FACE_HALF - 200)).toBe(neighbourOf(face, 'south'));
      // Past the corner: neither side's neighbour alone, but some face, and
      // the chart still works there.
      const corner = homeFaceOf(face, FACE_HALF + 150, FACE_HALF + 150);
      expect(corner).not.toBe(face);
      faceToSphereInto(face, FACE_HALF + 150, FACE_HALF + 150, s);
      expect(faceOfDirection(s)).toBe(corner);
    }
  });

  it('reports the distortion the sphere puts on the maps', () => {
    // Not a pass/fail figure: the numbers the plan asked to measure.
    let minScale = Infinity, maxScale = 0;
    for (let i = 0; i <= 20; i++) {
      for (let j = 0; j <= 20; j++) {
        const x = (-1 + i / 10) * FACE_HALF, y = (-1 + j / 10) * FACE_HALF;
        for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]] as const) {
          const k = chartScale(0, x, y, dx, dy);
          minScale = Math.min(minScale, k);
          maxScale = Math.max(maxScale, k);
        }
      }
    }
    // The corner of a face: its 90 degrees on the map, drawn on the sphere.
    const e = 1e-3;
    const c = FACE_HALF - 1;
    faceToSphereInto(0, c, c, s);
    const a = faceToSphereInto(0, c - e, c, { x: 0, y: 0, z: 0 });
    const b = faceToSphereInto(0, c, c - e, { x: 0, y: 0, z: 0 });
    const ux = a.x - s.x, uy = a.y - s.y, uz = a.z - s.z;
    const wx = b.x - s.x, wy = b.y - s.y, wz = b.z - s.z;
    const corner = Math.acos((ux * wx + uy * wy + uz * wz) / (Math.hypot(ux, uy, uz) * Math.hypot(wx, wy, wz))) * (180 / Math.PI);
    // Transfer over 300 m past the border, mid-side and near the corner: how
    // far the neighbour's metres drift from the unfolded map's.
    const drift = (t: number): number => {
      const x = FACE_HALF + 300, y = t * FACE_HALF;
      faceToSphereInto(0, x, y, s);
      const n = neighbourOf(0, 'east');
      sphereToFaceInto(n, s, p);
      // Unfolded: 300 m into the neighbour across its border from the same border point.
      faceToSphereInto(0, FACE_HALF, y, s2);
      const q = sphereToFaceInto(n, s2, { x: 0, y: 0 });
      if (!q) throw new Error('no chart');
      const into = Math.hypot(p.x - q.x, p.y - q.y);
      return Math.abs(into - 300);
    };
    console.info(
      `cube-sphere: R ${PLANET_RADIUS.toFixed(1)} m, map scale ${minScale.toFixed(3)}..${maxScale.toFixed(3)}, ` +
        `face corner ${corner.toFixed(2)} deg on the sphere, 300 m reach drift mid ${drift(0).toFixed(2)} m, ` +
        `at 0.9 ${drift(0.9).toFixed(2)} m`,
    );
    expect(corner).toBeGreaterThan(90);
    expect(corner).toBeLessThan(121);
  });
});

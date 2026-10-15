import { describe, expect, it } from 'vitest';
import { AA_MARGIN, LotLattice, TEXTURE_WIDTH, halfBits, type LatticeShape } from '@render/lotLattice';
import { sampleLattice } from './support/latticeSampler';

/** THE LOTS AS VECTOR SHAPES IN A LATTICE (`render/lotLattice.ts`), read the way the ground's shader reads them */

const HALF = 1024;

/** A quad turned by `turn` about its centre. */
function quad(cx: number, cy: number, w: number, d: number, turn: number): [number, number][] {
  const c = Math.cos(turn), s = Math.sin(turn);
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([x, y]) => [cx + x! * c - y! * s, cy + x! * s + y! * c]);
}

function polygon(ring: [number, number][], order: number, fill = 0x7356bb01 >>> 0, line = 0xd9ffffff >>> 0, halfWidth = 0.175): LatticeShape {
  const edges = new Float64Array(ring.length * 4);
  ring.forEach(([x, y], i) => { const [bx, by] = ring[(i + 1) % ring.length]!; edges.set([x, y, bx, by], i * 4); });
  return { edges, fill, line, halfWidth, dashed: false, butt: false, order };
}

function insideRing(ring: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!;
    if ((yi > y) !== (yj > y) && x < xi + (y - yi) / (yj - yi) * (xj - xi)) inside = !inside;
  }
  return inside;
}

function ringDistance(ring: [number, number][], x: number, y: number): number {
  let best = Infinity;
  ring.forEach(([ax, ay], i) => {
    const [bx, by] = ring[(i + 1) % ring.length]!;
    const abx = bx - ax, aby = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * abx + (y - ay) * aby) / (abx * abx + aby * aby)));
    best = Math.min(best, Math.hypot(x - ax - abx * t, y - ay - aby * t));
  });
  return best;
}

/** A small seeded random, so a failure repeats. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0; return s / 4_294_967_296; };
}

describe('lot lattice', () => {
  it('writes half floats exactly for the values it stores', () => {
    expect(halfBits(0)).toBe(0);
    expect(halfBits(1)).toBe(0x3c00);
    expect(halfBits(-2)).toBe(0xc000);
    expect(halfBits(0.5625)).toBe(0x3880);
    expect(halfBits(0.175)).toBe(0x319a);
  });

  it('knows inside and the edge distance of every lot at every point', () => {
    const lattice = new LotLattice(HALF);
    const rings: [number, number][][] = [];
    const rnd = random(7);
    // Lots of every size and turn, some on the cells' lines and centres exactly.
    for (let i = 0; i < 40; i++) rings.push(quad(-200 + (i % 8) * 47 + rnd() * 9, -150 + Math.floor(i / 8) * 61 + rnd() * 9, 12 + rnd() * 30, 20 + rnd() * 35, rnd() * 3));
    rings.push([[0, 0], [16, 0], [16, 24], [0, 24]]);
    rings.push([[4, 4], [40, 4], [40, 12], [20, 12], [20, 36], [4, 36]]);
    rings.forEach((ring, i) => lattice.add(polygon(ring, i)));
    lattice.flush();
    for (let k = 0; k < 20_000; k++) {
      const x = -230 + rnd() * 460, y = -180 + rnd() * 400;
      const hit = sampleLattice(lattice, x, y);
      rings.forEach((ring) => {
        const inside = insideRing(ring, x, y);
        const near = ringDistance(ring, x, y);
        const record = hit?.records.find((r) => r.distance <= AA_MARGIN + 0.2 ? Math.abs(r.distance - near) < 1e-3 : false);
        if (near < 0.01) return;
        if (inside) {
          // Inside: the lot is listed, inside, at its true distance (or far from all its edges).
          const found = hit?.records.some((r) => r.inside && (Math.abs(r.distance - near) < 1e-3 || (near > AA_MARGIN && r.distance > AA_MARGIN)));
          expect(found, `inside lot not found at ${x}, ${y}`).toBe(true);
        }
        if (near < AA_MARGIN) expect(record, `edge within reach not listed at ${x}, ${y}`).toBeDefined();
      });
      // Nothing listed says inside where no lot is.
      const anyInside = rings.some((ring) => insideRing(ring, x, y) && ringDistance(ring, x, y) > 0.01);
      const saysInside = hit?.records.some((r) => r.inside && r.distance > 0.01) ?? false;
      if (!anyInside) expect(saysInside, `outside said inside at ${x}, ${y}`).toBe(false);
    }
  });

  it('rewrites only the cells of the lot that changed', () => {
    const lattice = new LotLattice(HALF);
    const shapes = Array.from({ length: 300 }, (_, i) => polygon(quad(-400 + (i % 20) * 40, -300 + Math.floor(i / 20) * 40, 30, 30, 0.3), i));
    for (const s of shapes) lattice.add(s);
    lattice.flush();
    // The first upload is the whole texture.
    expect(lattice.takeUpload().whole).toBe(true);
    const all = lattice.cellsWritten;
    lattice.cellsWritten = 0;
    // One lot zoned: taken out and put back with its fill.
    lattice.remove(shapes[37]!);
    lattice.add(polygon(quad(-400 + 17 * 40, -300 + 40, 30, 30, 0.3), 37, 0x7356bb01));
    lattice.flush();
    expect(lattice.cellsWritten).toBeGreaterThan(0);
    expect(lattice.cellsWritten).toBeLessThan(all / 50);
    // The upload is the cells written, not the texture.
    const up = lattice.takeUpload();
    lattice.cellsWritten = 0;
    lattice.flush();
    expect(lattice.cellsWritten).toBe(0);
    expect(lattice.takeUpload().ranges).toEqual([]);
    expect(up.whole).toBe(false);
    expect(up.ranges.length).toBeGreaterThan(0);
    // Each range within one row of the texture (three uploads a range as part of a row).
    for (let i = 0; i < up.ranges.length; i += 2) {
      const row = Math.floor(up.ranges[i]! / 4 / TEXTURE_WIDTH);
      expect(Math.floor((up.ranges[i]! + up.ranges[i + 1]! - 1) / 4 / TEXTURE_WIDTH)).toBe(row);
    }
    // Uploaded: a few texels a cell written, not the texture.
    const texels = up.ranges.filter((_, i) => i % 2 === 1).reduce((a, b) => a + b, 0) / 4;
    expect(texels).toBeLessThan(lattice.data.length / 4 / 100);
  });

  it('keeps the same picture through compaction and growth', () => {
    const lattice = new LotLattice(HALF, 1);
    const rnd = random(3);
    const ring = (i: number): [number, number][] => quad(-300 + (i % 30) * 21, -300 + Math.floor(i / 30) * 25, 18, 22, 0.1 * (i % 7));
    let shapes = Array.from({ length: 300 }, (_, i) => polygon(ring(i), i));
    for (const s of shapes) lattice.add(s);
    lattice.flush();
    // Many edits: each lot swapped for itself again and again (garbage, then compaction).
    for (let round = 0; round < 30; round++) {
      shapes = shapes.map((s, i) => {
        if (rnd() > 0.3) return s;
        lattice.remove(s);
        const t = polygon(ring(i), i, rnd() > 0.5 ? 0x7356bb01 : 0x7dd9b254);
        lattice.add(t);
        return t;
      });
      lattice.flush();
    }
    for (let k = 0; k < 5000; k++) {
      const x = -310 + rnd() * 640, y = -310 + rnd() * 280;
      const hit = sampleLattice(lattice, x, y);
      shapes.forEach((s, i) => {
        const r = ring(i);
        if (!insideRing(r, x, y) || ringDistance(r, x, y) < 0.01) return;
        expect(hit?.records.some((rec) => rec.inside && rec.fill === s.fill), `lot ${i} at ${x}, ${y}`).toBe(true);
      });
    }
  });
});

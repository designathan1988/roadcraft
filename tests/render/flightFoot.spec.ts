import { describe, expect, it } from 'vitest';
import { emitChunk, withShellParts } from '@render/buildings/buildingMesh';
import { resolveBlocks } from '@world/buildings/blocks';
import { STEP_RUN, flightRun, floorHeight, foundationOf } from '@world/buildings/foundation';
import type { Building } from '@world/buildings/types';
import { m } from '@world/units';
import { growCity } from '../world/cityAudit';

/** THE APRON AND THE LOT'S PATHS STOP AT THE FOOT OF THE STEPS. */
const ROLLING = (x: number, y: number): number => m(0.6) * Math.sin(x * 0.05) + m(0.4) * Math.cos(y * 0.07);
const SAMPLE = 100;
const HAND = m(0.3);

interface Up { a: number[]; b: number[]; c: number[]; y: number }

function upFaces(chunk: ReturnType<typeof emitChunk>): Up[] {
  const out: Up[] = [];
  for (const shell of Object.values(chunk.shells)) {
    if (!shell) continue;
    const p = shell.position, idx = shell.index;
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const [a, b, c] = [idx[t]!, idx[t + 1]!, idx[t + 2]!].map((i) => [p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!]) as [number[], number[], number[]];
      const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!, uz = b[2]! - a[2]!, vx = c[0]! - a[0]!, vy = c[1]! - a[1]!, vz = c[2]! - a[2]!;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz);
      if (l < 1e-9 || Math.abs(ny / l) < 0.9) continue;
      out.push({ a, b, c, y: (a[1]! + b[1]! + c[1]!) / 3 });
    }
  }
  return out;
}

/** Height of a face at a point of the plan (three's x, z), or NaN off it. */
function heightAt(f: Up, x: number, z: number): number {
  const [ax, , az] = f.a as [number, number, number];
  const [bx, , bz] = f.b as [number, number, number];
  const [cx, , cz] = f.c as [number, number, number];
  const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(d) < 1e-12) return NaN;
  const w1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
  const w2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
  const w3 = 1 - w1 - w2;
  if (w1 < -1e-6 || w2 < -1e-6 || w3 < -1e-6) return NaN;
  return w1 * f.a[1]! + w2 * f.b[1]! + w3 * f.c[1]!;
}

/** The building with its lawns and the paths laid on them: no paved yards, no other lot parts. */
function pathsOnly(b: Building): Building {
  const lawns = b.volumes.filter((v) => v.open === 'grass');
  return {
    ...b,
    volumes: b.volumes.filter((v) => !v.open || v.open === 'grass'),
    elements: (b.elements ?? []).filter((el) => el.kind === 'pavement'
      && lawns.some((v) => el.x >= v.x && el.x <= v.x + v.w && el.y >= v.y && el.y <= v.y + v.d)),
  };
}

describe('flights of steps', () => {
  it('has the apron and the lot\'s paths stop at their foot', () => {
    const city = growCity({ size: 'small', seed: 1 });
    const through: string[] = [];
    let flights = 0;
    for (const whole of [...city.doc.buildings.all()].slice(0, SAMPLE)) {
      const b = pathsOnly(whole);
      const resolved = resolveBlocks(b);
      const closed = resolved.volumes.filter((v) => !v.open);
      if (closed.length === 0) continue;
      const floor = floorHeight(resolved, ROLLING);
      const f = foundationOf({ ...resolved, volumes: closed }, ROLLING, undefined, undefined, floor);
      // The paths are the shell's parts (`shellParts.ts`): laid in the shell again, as they are drawn.
      const faces = upFaces(withShellParts(emitChunk(b, ROLLING)));
      for (const x of f.entrances) {
        if (x.steps <= 0 || x.recess > 0 || x.push < 0) continue;
        flights++;
        const riser = (x.floor - x.ground) / x.steps;
        // Down the middle of the flight, a point every 5 cm, clear of each tread's edges.
        for (let d = m(0.05); d < flightRun(x.steps) - m(0.05); d += m(0.05)) {
          const j = d < 2 * STEP_RUN ? 0 : Math.floor(d / STEP_RUN) - 1;
          if (Math.abs(d - (j + 1) * STEP_RUN) < m(0.04) || Math.abs(d - (j + 2) * STEP_RUN) < m(0.04)) continue;
          const tread = x.floor - j * riser;
          const wx = x.x + x.nx * (x.push + d), wy = x.y + x.ny * (x.push + d);
          for (const face of faces) {
            if (face.y < tread - HAND || face.y > tread + HAND) continue;
            const h = heightAt(face, wx, -wy);
            if (Number.isFinite(h) && h > tread + m(0.001) && h < tread + HAND) {
              through.push(`building ${whole.id} door ${x.volume}:${x.side}:${x.index} ${(d * 100).toFixed(0)} cm out: ${((h - tread) * 100).toFixed(1)} cm over the tread`);
              break;
            }
          }
        }
      }
    }
    expect(flights).toBeGreaterThan(20);
    expect(through.slice(0, 20)).toEqual([]);
  });
});

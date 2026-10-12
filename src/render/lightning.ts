/**
 * LIGHTNING (`world/weather.ts`): a bolt from the cloud base to the ground,
 * built by midpoint displacement - each segment split and its middle kicked
 * sideways, the kick halved at every generation, so the bolt is jagged at
 * every scale - with a few branches forking off at some 30 degrees, each
 * shorter the lower it leaves the main channel (gamedev.net, "Lightning
 * Bolts"; Tuts+, "How to Generate Shockingly Good 2D Lightning Effects").
 * Drawn as screen-wide lines in a white too bright for the tone curve, it
 * flickers - a stroke, a dim, a return stroke - and fades in a third of a
 * second; while it lasts it lights the whole scene (`flash`).
 */
import { Color, Group, Vector2, Vector3 } from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';

/** Seconds a strike lasts, from the first stroke to the last glow. */
const STRIKE_LIFE = 0.45;

export interface Lightning {
  readonly group: Group;
  /** A bolt from `from` (in the cloud) to `to` (the ground), three coordinates. */
  strike(from: Vector3, to: Vector3): void;
  /** Ages the strikes; returns how bright their flash is now (0 none .. ~1). */
  update(delta: number, viewport: Vector2): number;
  dispose(): void;
}

/** The bolt's channel: midpoint displacement between two points, then branches. Pairs of points, one pair a segment. */
export function boltSegments(from: Vector3, to: Vector3, random: () => number): { main: number[]; branches: number[] } {
  const length = from.distanceTo(to);
  const split = (a: Vector3, b: Vector3, kick: number, generations: number): Vector3[] => {
    let points = [a.clone(), b.clone()];
    let offset = kick;
    for (let g = 0; g < generations; g++) {
      const next: Vector3[] = [points[0]!];
      for (let i = 1; i < points.length; i++) {
        const p = points[i - 1]!, q = points[i]!;
        const mid = p.clone().add(q).multiplyScalar(0.5);
        // Sideways, any way round the segment.
        const along = q.clone().sub(p).normalize();
        const side = new Vector3(random() - 0.5, random() - 0.5, random() - 0.5).cross(along).normalize();
        mid.addScaledVector(side, (random() * 2 - 1) * offset);
        next.push(mid, q);
      }
      points = next;
      offset *= 0.5;
    }
    return points;
  };
  const pairs = (points: Vector3[], out: number[]): void => {
    for (let i = 1; i < points.length; i++) out.push(...points[i - 1]!.toArray(), ...points[i]!.toArray());
  };
  const channel = split(from, to, length * 0.2, 7);
  const main: number[] = [];
  pairs(channel, main);
  const branches: number[] = [];
  const count = 3 + Math.floor(random() * 4);
  for (let b = 0; b < count; b++) {
    const f = 0.1 + random() * 0.6;
    const start = channel[Math.floor(f * (channel.length - 1))]!;
    const down = to.clone().sub(from).normalize();
    // Some 30 degrees off the channel, either way round.
    const side = new Vector3(random() - 0.5, 0, random() - 0.5).normalize();
    const dir = down.clone().multiplyScalar(Math.cos(0.52)).addScaledVector(side, Math.sin(0.52)).normalize();
    const reach = length * (1 - f) * (0.25 + random() * 0.3);
    const end = start.clone().addScaledVector(dir, reach);
    pairs(split(start, end, reach * 0.18, 5), branches);
  }
  return { main, branches };
}

export function createLightning(): Lightning {
  const group = new Group();
  group.name = 'lightning';
  const strikes: { age: number; meshes: LineSegments2[]; materials: LineMaterial[] }[] = [];
  // Brighter than white: past the tone curve, and into the bloom at night.
  const core = new Color(6, 6.4, 8);
  const make = (positions: number[], width: number, opacity: number): { mesh: LineSegments2; material: LineMaterial } => {
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    const material = new LineMaterial({ color: core, linewidth: width, transparent: true, opacity, depthWrite: false, toneMapped: false });
    const mesh = new LineSegments2(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;
    return { mesh, material };
  };
  return {
    group,
    strike(from, to) {
      const bolt = boltSegments(from, to, Math.random);
      const parts = [make(bolt.main, 2.6, 1), make(bolt.main, 8, 0.18), make(bolt.branches, 1.4, 0.8)];
      for (const p of parts) group.add(p.mesh);
      strikes.push({ age: 0, meshes: parts.map((p) => p.mesh), materials: parts.map((p) => p.material) });
    },
    update(delta, viewport) {
      let flash = 0;
      for (let i = strikes.length - 1; i >= 0; i--) {
        const s = strikes[i]!;
        s.age += delta;
        if (s.age >= STRIKE_LIFE) {
          for (const m of s.meshes) { group.remove(m); m.geometry.dispose(); }
          for (const m of s.materials) m.dispose();
          strikes.splice(i, 1);
          continue;
        }
        // A stroke, a dim, the return stroke, then the glow dies away.
        const t = s.age;
        const bright = t < 0.06 ? 1 : t < 0.1 ? 0.25 : t < 0.17 ? 0.9 : Math.max(0, 1 - (t - 0.17) / (STRIKE_LIFE - 0.17)) * 0.6;
        s.materials.forEach((m, k) => {
          m.resolution.copy(viewport);
          m.opacity = bright * (k === 1 ? 0.18 : k === 2 ? 0.8 : 1);
        });
        flash = Math.max(flash, bright);
      }
      return flash;
    },
    dispose() {
      for (const s of strikes) {
        for (const m of s.meshes) m.geometry.dispose();
        for (const m of s.materials) m.dispose();
      }
      strikes.length = 0;
    },
  };
}

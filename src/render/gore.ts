import {
  Color, CylinderGeometry, DynamicDrawUsage, Group, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, SphereGeometry, Vector3,
} from 'three';
import { m } from '@world/units';

/**
 * What a body opened by a bullet or a blast shows (the player, 2026-10-06:
 * organs out of a belly - hanging, falling, spread on the ground - and now
 * and then the bone of a limb torn off): a loop of gut hanging out of the
 * wound on a chain of particles (Verlet, as the ragdolls are), swinging with
 * the body and dragging on the ground, now and then torn loose to fall;
 * organs dropped on the street; a bone's end standing out of a stump. Wet
 * and dark, not bright: instanced, a draw for each.
 */

/** Three's frame (y up). */
type Ends = () => readonly [Vector3, Vector3] | null;

export interface Gore {
  readonly group: Group;
  /**
   * Guts out of an opened belly: hanging from `anchor()` (the belly's point
   * on the body, three's frame), until it returns null or the loop tears
   * loose by itself; `kick` the way they spill.
   */
  spill(anchor: () => Vector3 | null, kick: Vector3): void;
  /** Organs dropped from a point (a body torn open), thrown by `kick`. */
  scatter(at: Vector3, count: number, kick: Vector3): void;
  /** A bone's end out of a stump: drawn from `ends()` (the joint, the tip) while it returns them. */
  bone(ends: Ends): void;
  update(dt: number, groundAt: (x: number, y: number) => number): void;
  /** All of it gone. */
  clear(): void;
  dispose(): void;
}

interface Chain {
  readonly p: Vector3[];
  readonly o: Vector3[];
  anchor: (() => Vector3 | null) | null;
  /** Seconds until it tears loose by itself (Infinity: holds). */
  hold: number;
  readonly seg: number;
  readonly radius: number;
  readonly color: Color;
  age: number;
  still: number;
}

interface Organ {
  readonly p: Vector3;
  readonly v: Vector3;
  readonly q: Quaternion;
  readonly size: Vector3;
  readonly color: Color;
  rest: boolean;
}

const MAX_SEGMENTS = 1600;
const MAX_ORGANS = 400;
const MAX_BONES = 120;
const GRAVITY = m(9.8);
const LINKS = 14;

export function createGore(): Gore {
  const group = new Group();
  group.name = 'gore';
  // Wet: glossy, dark.
  const flesh = new MeshStandardMaterial({ roughness: 0.4, metalness: 0 });
  const boneMaterial = new MeshStandardMaterial({ roughness: 0.6, metalness: 0, color: 0xd9cdb6 });
  const segments = new InstancedMesh(new CylinderGeometry(1, 1, 1, 7), flesh, MAX_SEGMENTS);
  const organs = new InstancedMesh(new SphereGeometry(1, 10, 7), flesh, MAX_ORGANS);
  const bones = new InstancedMesh(new CylinderGeometry(1, 0.8, 1, 7), boneMaterial, MAX_BONES);
  // The raw flesh round a bone's end.
  const cuffs = new InstancedMesh(new CylinderGeometry(1, 1, 1, 9), flesh, MAX_BONES);
  segments.name = 'gore-guts'; organs.name = 'gore-organs'; bones.name = 'gore-bones'; cuffs.name = 'gore-cuffs';
  for (const mesh of [segments, organs, bones, cuffs]) {
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (mesh !== bones) mesh.setColorAt(0, new Color(1, 1, 1));
    group.add(mesh);
  }
  const chains: Chain[] = [];
  const loose: Organ[] = [];
  const stubs: Ends[] = [];
  const mtx = new Matrix4(), q = new Quaternion(), s = new Vector3(), up = new Vector3(0, 1, 0), d = new Vector3(), mid = new Vector3();
  const CUFF = new Color(0x4a0a0e);

  /** A cylinder from `a` to `b`, `r` round. */
  const between = (mesh: InstancedMesh, n: number, a: Vector3, b: Vector3, r: number): void => {
    d.subVectors(b, a);
    const len = d.length() || 1e-6;
    q.setFromUnitVectors(up, d.divideScalar(len));
    mid.addVectors(a, b).multiplyScalar(0.5);
    mtx.compose(mid, q, s.set(r, len, r));
    mesh.setMatrixAt(n, mtx);
  };

  return {
    group,
    spill(anchor, kick) {
      const at = anchor();
      if (!at) return;
      if (chains.length * LINKS >= MAX_SEGMENTS) chains.shift();
      const p: Vector3[] = [], o: Vector3[] = [];
      const seg = m(0.055 + Math.random() * 0.02);
      for (let i = 0; i < LINKS; i++) {
        // Coiled a little out of the wound, the way it was packed.
        const a = i * 1.3;
        const v = at.clone().add(new Vector3(Math.cos(a) * m(0.06), -i * seg * 0.3, Math.sin(a) * m(0.06)));
        p.push(v);
        o.push(v.clone().addScaledVector(kick, -(1 / 60) * (i / LINKS)));
      }
      chains.push({
        p, o, anchor, hold: Math.random() < 0.45 ? 2 + Math.random() * 6 : Infinity, seg, radius: m(0.016 + Math.random() * 0.006),
        color: new Color([0x5e2228, 0x4e1a20, 0x66282e][Math.floor(Math.random() * 3)]!), age: 0, still: 0,
      });
    },
    scatter(at, count, kick) {
      for (let i = 0; i < count; i++) {
        if (loose.length >= MAX_ORGANS) loose.shift();
        const r = m(0.025 + Math.random() * 0.035);
        loose.push({
          p: at.clone(),
          v: kick.clone().add(new Vector3((Math.random() - 0.5) * m(3), m(1 + Math.random() * 2.5), (Math.random() - 0.5) * m(3))),
          q: new Quaternion().setFromAxisAngle(new Vector3(Math.random(), Math.random(), Math.random()).normalize(), Math.random() * Math.PI),
          size: new Vector3(r * (1 + Math.random() * 0.8), r * (0.45 + Math.random() * 0.3), r),
          // Liver, kidney, stomach, lung: dark reds, purple, a pinkish grey.
          color: new Color([0x3a0a0e, 0x44121a, 0x4e1a22, 0x5a2a30, 0x2e080c][Math.floor(Math.random() * 5)]!),
          rest: false,
        });
      }
    },
    bone(ends) {
      if (stubs.length >= MAX_BONES) stubs.shift();
      stubs.push(ends);
    },
    update(dt, groundAt) {
      const step = Math.min(0.05, Math.max(0, dt));
      // Guts: Verlet, the first link held to the wound while it holds.
      for (const c of chains) {
        c.age += step;
        if (c.anchor && c.age > c.hold) c.anchor = null;
        const held = c.anchor ? c.anchor() : null;
        if (c.anchor && !held) c.anchor = null;
        if (c.still > 1.5 && !held) continue;
        let moved = 0;
        for (let i = 0; i < c.p.length; i++) {
          const v = c.p[i]!, old = c.o[i]!;
          const vx = (v.x - old.x) * 0.985, vy = (v.y - old.y) * 0.985, vz = (v.z - old.z) * 0.985;
          old.copy(v);
          v.x += vx; v.y += vy - GRAVITY * step * step; v.z += vz;
          moved = Math.max(moved, Math.abs(vx) + Math.abs(vy) + Math.abs(vz));
        }
        for (let it = 0; it < 6; it++) {
          if (held) c.p[0]!.copy(held);
          for (let i = 1; i < c.p.length; i++) {
            const a = c.p[i - 1]!, b = c.p[i]!;
            d.subVectors(b, a);
            const l = d.length() || 1e-6;
            const diff = (l - c.seg) / l;
            if (i === 1 && held) b.addScaledVector(d, -diff);
            else { a.addScaledVector(d, diff * 0.5); b.addScaledVector(d, -diff * 0.5); }
          }
          for (let i = 0; i < c.p.length; i++) {
            const v = c.p[i]!;
            const g = groundAt(v.x, -v.z) + c.radius;
            if (v.y < g) {
              v.y = g;
              const old = c.o[i]!;
              old.x = v.x - (v.x - old.x) * 0.5; old.z = v.z - (v.z - old.z) * 0.5;
            }
          }
        }
        c.still = moved < m(0.002) ? c.still + step : 0;
      }
      // Organs: thrown, landing with a flop, lying where they land.
      for (const o of loose) {
        if (o.rest) continue;
        o.v.y -= GRAVITY * step;
        o.p.addScaledVector(o.v, step);
        const g = groundAt(o.p.x, -o.p.z) + o.size.y * 0.6;
        if (o.p.y < g) {
          o.p.y = g;
          o.v.multiplyScalar(0.25);
          o.v.y = Math.abs(o.v.y) * 0.1;
          if (o.v.lengthSq() < m(0.3) ** 2) o.rest = true;
        }
      }
      let n = 0;
      for (const c of chains) {
        for (let i = 1; i < c.p.length && n < MAX_SEGMENTS; i++) {
          between(segments, n, c.p[i - 1]!, c.p[i]!, c.radius);
          segments.setColorAt(n++, c.color);
        }
      }
      segments.count = n;
      let k = 0;
      for (const o of loose) {
        mtx.compose(o.p, o.q, o.size);
        organs.setMatrixAt(k, mtx);
        organs.setColorAt(k++, o.color);
      }
      organs.count = k;
      let b = 0;
      for (let i = stubs.length - 1; i >= 0; i--) {
        const e = stubs[i]!();
        if (!e) { stubs.splice(i, 1); continue; }
        between(bones, b, e[0], e[1], m(0.018));
        // The flesh round the bone where it leaves the stump.
        d.subVectors(e[1], e[0]).normalize();
        between(cuffs, b, e[0], mid.copy(e[0]).addScaledVector(d, m(0.025)), m(0.045));
        cuffs.setColorAt(b, CUFF);
        b++;
      }
      bones.count = b;
      cuffs.count = b;
      // Only what is drawn, uploaded and drawn: three uploads a whole buffer
      // whose `needsUpdate` has no ranges (`WebGLAttributes.updateBuffer`),
      // and an empty mesh still goes through both render lists - 100 KiB a
      // frame for the guts alone, with nobody hurt.
      for (const mesh of [segments, organs, bones, cuffs]) {
        mesh.visible = mesh.count > 0;
        if (!mesh.visible) continue;
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, mesh.count * 16);
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) {
          mesh.instanceColor.clearUpdateRanges();
          mesh.instanceColor.addUpdateRange(0, mesh.count * 3);
          mesh.instanceColor.needsUpdate = true;
        }
      }
    },
    clear() {
      chains.length = 0;
      loose.length = 0;
      stubs.length = 0;
    },
    dispose() {
      for (const mesh of [segments, organs, bones, cuffs]) mesh.geometry.dispose();
      flesh.dispose();
      boneMaterial.dispose();
    },
  };
}

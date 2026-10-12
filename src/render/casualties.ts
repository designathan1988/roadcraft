import {
  CanvasTexture,
  CircleGeometry,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
  SRGBColorSpace,
} from 'three';
import { m } from '@world/units';

/** A patch of blood on the ground: where, how big at full spread, and how long it takes to spread. */
export interface BloodDecal {
  readonly x: number;
  readonly y: number;
  /** World height of the surface it lies on. */
  readonly z: number;
  readonly angle: number;
  readonly size: number;
  /** Seconds to reach full size (0: at once). */
  readonly spread: number;
  /** Seconds since it was made. */
  age: number;
}

/**
 * What a blow leaves on the ground (the player's order of 2026-10-05): a pool
 * of blood spreading from under each body over its first seconds, a darker
 * splatter where somebody was right under the blow. Instanced decals on the
 * ground, one draw for all of them.
 */

const MAX = 400;

type Variant = 'pool' | 'splat' | 'drops';
const VARIANTS: readonly Variant[] = ['pool', 'splat', 'drops'];

/**
 * Blood as it lies on a street: nearly black where it is deep, a dark
 * crimson at thin edges, never the bright red of paint (fresh blood on
 * asphalt reads maroon). Three stamps: a pool (lobed, deep in the middle,
 * with a meniscus rim), a spatter (a blot and the drops thrown out of it,
 * stretched along their flight, as forensic spatter is), and a few drops.
 */
function bloodTexture(variant: Variant): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  let seed = variant === 'pool' ? 11 : variant === 'splat' ? 23 : 37;
  const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  // Blood red: deep where it pools, brighter where it thins (near black it read as purple on the grass).
  const deep = (a: number): string => `rgba(96, 6, 9, ${a})`;
  const thin = (a: number): string => `rgba(132, 12, 16, ${a})`;
  const blob = (x: number, y: number, rad: number, core: number): void => {
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, deep(core));
    grad.addColorStop(0.75, deep(core * 0.95));
    grad.addColorStop(1, thin(0));
    g.fillStyle = grad;
    g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
  };
  const drop = (x: number, y: number, r: number, along: number, stretch: number): void => {
    g.save();
    g.translate(x, y); g.rotate(along); g.scale(stretch, 1);
    g.fillStyle = deep(0.95);
    g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
    g.restore();
  };
  const mid = size / 2;
  if (variant === 'pool') {
    for (let i = 0; i < 18; i++) {
      const a = rnd() * Math.PI * 2, r = rnd() * size * 0.17;
      blob(mid + Math.cos(a) * r, mid + Math.sin(a) * r, size * (0.1 + rnd() * 0.15), 0.97);
    }
    for (let i = 0; i < 10; i++) {
      const a = rnd() * Math.PI * 2, r = size * (0.33 + rnd() * 0.12);
      drop(mid + Math.cos(a) * r, mid + Math.sin(a) * r, 1.5 + rnd() * 3, a, 1 + rnd());
    }
  } else if (variant === 'splat') {
    blob(mid, mid, size * 0.13, 0.95);
    blob(mid + size * 0.05, mid - size * 0.03, size * 0.08, 0.95);
    // Thrown out of it: the further, the smaller and the more stretched.
    for (let i = 0; i < 46; i++) {
      const a = rnd() * Math.PI * 2, f = rnd();
      const r = size * (0.14 + f * 0.33);
      drop(mid + Math.cos(a) * r, mid + Math.sin(a) * r, (1 - f) * 5 + 1, a, 1 + f * 2.5);
    }
  } else {
    for (let i = 0; i < 6; i++) {
      const a = rnd() * Math.PI * 2, r = rnd() * size * 0.28;
      blob(mid + Math.cos(a) * r, mid + Math.sin(a) * r, size * (0.04 + rnd() * 0.07), 0.95);
    }
    for (let i = 0; i < 14; i++) {
      const a = rnd() * Math.PI * 2, r = rnd() * size * 0.42;
      drop(mid + Math.cos(a) * r, mid + Math.sin(a) * r, 1 + rnd() * 2.5, a, 1 + rnd() * 1.5);
    }
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export interface CasualtyLayer {
  readonly group: Group;
  sync(list: readonly BloodDecal[]): void;
  dispose(): void;
}

export function createCasualties(): CasualtyLayer {
  const group = new Group();
  group.name = 'casualties';
  const geometry = new CircleGeometry(0.5, 20).rotateX(-Math.PI / 2);
  const stamps = VARIANTS.map((variant) => {
    // Wet: a sheen (low roughness) over a colour near black.
    const material = new MeshStandardMaterial({
      map: bloodTexture(variant), transparent: true, depthWrite: false, roughness: 0.18, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    });
    const mesh = new InstancedMesh(geometry, material, MAX);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = 4;
    group.add(mesh);
    return { variant, material, mesh };
  });
  const o = new Object3D();
  return {
    group,
    sync(list) {
      const n = stamps.map(() => 0);
      for (const c of list) {
        // A spreading patch is a pool; a small one a few drops; else spatter.
        const k = c.spread > 0 ? 0 : c.size < m(0.45) ? 2 : 1;
        if (n[k]! >= MAX) continue;
        const grow = c.spread > 0 ? Math.min(1, 0.2 + c.age / c.spread) : 1;
        const size = c.size * grow * (k === 0 ? 1 : 1.6);
        o.position.set(c.x, c.z + 0.02, -c.y);
        o.rotation.set(0, c.angle, 0);
        o.scale.set(size, 1, size * 0.85);
        o.updateMatrix();
        stamps[k]!.mesh.setMatrixAt(n[k]!++, o.matrix);
      }
      // Only the stains there are: an empty mesh is not drawn (three's
      // `projectObject` skips what is not visible) and a buffer is uploaded up
      // to its last stain, not whole every frame (75 KiB with no blood at all).
      stamps.forEach((s, k) => {
        const count = n[k]!;
        s.mesh.count = count;
        s.mesh.visible = count > 0;
        if (!count) return;
        s.mesh.instanceMatrix.clearUpdateRanges();
        s.mesh.instanceMatrix.addUpdateRange(0, count * 16);
        s.mesh.instanceMatrix.needsUpdate = true;
      });
    },
    dispose() {
      geometry.dispose();
      for (const s of stamps) { s.material.map?.dispose(); s.material.dispose(); }
    },
  };
}

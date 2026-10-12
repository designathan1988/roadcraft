import { BufferAttribute, BufferGeometry, Group, Matrix3, Mesh, Sphere, Vector3, type Material } from 'three';

import type { Building } from '@world/buildings/types';
import { localToWorld, volumeElevation } from '@world/buildings/geometry';
import { resolveBlocks } from '@world/buildings/blocks';
import { m } from '@world/units';
import type { Exhaust } from './exhaust';
import type { BuildingChunk } from './buildings/buildingMesh';
import type { BuildingKit } from './buildings/kit';
import { fragmentGeometry, prepareFracture, type Fragment, type StillData } from './buildings/fracture';
import { interiorFurniture } from './buildings/buildingMesh';

/**
 * Buildings that break for real (the player's order of 2026-10-05): the
 * building's own meshes, pre-fractured into Voronoi fragments
 * (`buildings/fracture.ts`), stand in for it from the first blow - looking
 * exactly like it. A blow knocks the fragments within its reach out of the
 * building, thrown away from the impact; then every fragment no longer joined
 * to the ground through the others falls (the chunk graph's support check), so
 * a building cut low comes down on itself. Pieces tumble, land, settle as a
 * heap of the building's own walls, roof and floors, and sink away after a
 * while. Dust rises where pieces break off and where they land.
 */

const GRAVITY = m(9.8);
/** Milliseconds a frame for cutting out and sending off the pieces of a blow (`release`), and the fewest a frame. */
const RELEASE_SLICE_MS = 4;
const RELEASE_MIN = 6;
/** Share of the fragments left standing below which the rest comes down. */
const COLLAPSE_BELOW = 0.35;

interface Piece {
  readonly fragment: Fragment;
  /** Its index among its ruin's fragments (`StillData.slots`, `fragments`). */
  readonly index: number;
  /**
   * Its own mesh, in the scene only while it moves (else drawn in its ruin's
   * `still`), with a geometry of its own only then (`fragmentGeometry`).
   */
  readonly mesh: Mesh;
  readonly floor: number;
  falling: boolean;
  settled: boolean;
  gone: boolean;
  /** Its ranges in the ruin's `still` mesh: (start, vertex count, material) triples. */
  readonly slots: Int32Array;
  v: Vector3;
  w: Vector3;
  age: number;
}

interface Ruin {
  readonly pieces: Piece[];
  readonly floor: number;
  /** Every piece that does not move (standing, or landed), in one mesh; a piece in the air is blanked in it. */
  readonly still: Mesh;
  /** The buffer the still mesh draws: a piece's own geometry is cut from it when it flies. */
  readonly data: StillData;
  standing: number;
}

/** What a piece's mesh holds while it is not flying: nothing. */
const NO_GEOMETRY = new BufferGeometry();

export interface Destruction {
  readonly group: Group;
  /** Buildings now drawn as fragments here (and not by the building layer). */
  readonly ruined: ReadonlySet<number>;
  /**
   * A blow on building `b` (its floor at `floor`) at world (x, y, z), force
   * 1..10. Returns true when the building has come down.
   */
  hit(b: Building, floor: number, x: number, y: number, z: number, strength: number, eye?: Vector3): boolean;
  /** Called when a building comes down later than its blow (its pieces were still being made in the worker). */
  onDown: ((id: number) => void) | null;
  /** Called when a building's pieces are ready and stand in for it (the layer stops drawing it). */
  onRuined: (() => void) | null;
  update(dt: number): void;
  dispose(): void;
}

export function createDestruction(
  exhaust: Exhaust,
  chunkOf: (b: Building) => { chunk: BuildingChunk; kit: BuildingKit } | null,
): Destruction {
  const group = new Group();
  group.name = 'destruction';
  const ruins = new Map<number, Ruin>();
  const ruined = new Set<number>();
  const loose: Piece[] = [];
  const owner = new WeakMap<Piece, Ruin>();

  // The fracture runs in a worker (`buildings/fracture.worker.ts`): a building
  // is struck at once and broken when its pieces are ready, a frame or a few
  // later, the blows meanwhile kept - a big one froze the game for a second.
  // A few workers, so the buildings a big blow reaches break together, not
  // one after another for seconds.
  const workers: Worker[] = [];
  let nextWorker = 0;
  let nextJob = 1;
  const jobs = new Map<number, { b: Building; floor: number; materials: Material[]; hits: [number, number, number, number, Vector3 | undefined][] }>();
  const pending = new Map<number, number>();
  const api: { onDown: ((id: number) => void) | null; onRuined: (() => void) | null } = { onDown: null, onRuined: null };
  const workerOf = (): Worker => {
    const size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency ?? 4) - 1));
    if (workers.length < size) {
      const worker = new Worker(new URL('./buildings/fracture.worker.ts', import.meta.url), { type: 'module' });
      workers.push(worker);
      worker.onmessage = (e: MessageEvent<{ id: number; still: StillData }>) => {
        const job = jobs.get(e.data.id);
        jobs.delete(e.data.id);
        if (!job) return;
        pending.delete(job.b.id);
        const ruin = place(e.data.still, job.materials, job.floor);
        ruins.set(job.b.id, ruin);
        ruined.add(job.b.id);
        api.onRuined?.();
        let down = false;
        for (const [x, y, z, strength, eye] of job.hits) down = strike(ruin, job.floor, x, y, z, strength, eye) || down;
        if (down) api.onDown?.(job.b.id);
      };
      return worker;
    }
    return workers[nextWorker++ % workers.length]!;
  };

  /**
   * Static batching (Unity's manual, "Draw call batching": meshes that do not
   * move and share a material, combined into one buffer in world space): the
   * pieces of a ruin standing or landed are drawn in one mesh, a group per
   * material - a draw call per material, not one per piece and material. A
   * building broken into a few hundred pieces cost as many draws, every frame,
   * for good (the rubble stays), and each bomb made the game slower. The
   * buffer is made in the worker (`fracture.ts` `mergeFragments`); a piece
   * knocked loose is blanked in it and drawn on its own while it flies, and
   * written back where it landed: only its own ranges are uploaded (three's
   * `BufferAttribute.addUpdateRange`).
   */
  const place = (data: StillData, materials: Material[], floor: number): Ruin => {
    const fragments = data.fragments;
    // The worker's arrays as they are (`Float32BufferAttribute` would copy
    // them), bounded by the fragments' own spheres, not a pass over them all.
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(data.position, 3));
    geometry.setAttribute('normal', new BufferAttribute(data.normal, 3));
    geometry.setAttribute('color', new BufferAttribute(data.colour, 3));
    geometry.setAttribute('uv', new BufferAttribute(data.uv, 2));
    geometry.setAttribute('aDecay', new BufferAttribute(data.decay, 1));
    for (const g of data.groups) geometry.addGroup(g.start, g.count, g.material);
    const bounds = new Sphere();
    for (const f of fragments) {
      const own = reach.set(scratch.set(f.centre[0], f.centre[1], f.centre[2]), f.radius);
      if (bounds.isEmpty()) bounds.copy(own); else bounds.union(own);
    }
    geometry.boundingSphere = bounds;
    const still = new Mesh(geometry, materials);
    still.castShadow = true;
    still.receiveShadow = true;
    still.matrixAutoUpdate = false;
    group.add(still);
    const pieces: Piece[] = fragments.map((fragment, i) => {
      const mesh = new Mesh(NO_GEOMETRY, materials);
      mesh.position.set(fragment.centre[0], fragment.centre[1], fragment.centre[2]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      return { fragment, index: i, mesh, floor, falling: false, settled: false, gone: false, slots: data.slots[i] ?? new Int32Array(0), v: new Vector3(), w: new Vector3(), age: 0 };
    });
    const ruin: Ruin = { pieces, floor, still, data, standing: pieces.length };
    for (const piece of pieces) owner.set(piece, ruin);
    return ruin;
  };

  /** A piece out of its ruin's still mesh: its triangles collapsed to a point, drawing nothing. */
  const blank = (ruin: Ruin, piece: Piece): void => {
    const position = ruin.still.geometry.getAttribute('position') as BufferAttribute;
    const array = position.array as Float32Array;
    const { x, y, z } = piece.mesh.position;
    for (let s = 0; s < piece.slots.length; s += 3) {
      const start = piece.slots[s]!, count = piece.slots[s + 1]!;
      for (let i = start; i < start + count; i++) { array[i * 3] = x; array[i * 3 + 1] = y; array[i * 3 + 2] = z; }
      position.addUpdateRange(start * 3, count * 3);
    }
    position.needsUpdate = true;
  };

  /** A piece landed, written into its ruin's still mesh where it lies. */
  const land = (ruin: Ruin, piece: Piece): void => {
    const geometry = ruin.still.geometry;
    const position = geometry.getAttribute('position') as BufferAttribute, normal = geometry.getAttribute('normal') as BufferAttribute;
    const pa = position.array as Float32Array, na = normal.array as Float32Array;
    const mesh = piece.mesh;
    const source = mesh.geometry;
    const sp = source.getAttribute('position').array, sn = source.getAttribute('normal').array;
    mesh.updateMatrix();
    normalMatrix.getNormalMatrix(mesh.matrix);
    // Its own geometry holds its ranges one after another (`fragmentGeometry`).
    let from = 0;
    for (let s = 0; s < piece.slots.length; s += 3) {
      const start = piece.slots[s]!, count = piece.slots[s + 1]!;
      for (let k = 0; k < count; k++) {
        const i = from + k, o = start + k;
        scratch.set(sp[i * 3]!, sp[i * 3 + 1]!, sp[i * 3 + 2]!).applyMatrix4(mesh.matrix);
        pa[o * 3] = scratch.x; pa[o * 3 + 1] = scratch.y; pa[o * 3 + 2] = scratch.z;
        scratch.set(sn[i * 3]!, sn[i * 3 + 1]!, sn[i * 3 + 2]!).applyMatrix3(normalMatrix).normalize();
        na[o * 3] = scratch.x; na[o * 3 + 1] = scratch.y; na[o * 3 + 2] = scratch.z;
      }
      position.addUpdateRange(start * 3, count * 3);
      normal.addUpdateRange(start * 3, count * 3);
      from += count;
    }
    position.needsUpdate = true;
    normal.needsUpdate = true;
    // It may have landed outside the building's bounds: the ruin is culled by them.
    geometry.boundingSphere?.union(reach.set(mesh.position, piece.fragment.radius));
    group.remove(mesh);
    // It never moves again (a blow passes over what has fallen): its own
    // geometry, on the GPU and in memory, is let go (three: `dispose`).
    source.dispose();
    mesh.geometry = NO_GEOMETRY;
  };
  const scratch = new Vector3(), normalMatrix = new Matrix3(), reach = new Sphere();

  const make = (b: Building, floor: number): number | null => {
    const source = chunkOf(b);
    if (!source) return null;
    // Floor slabs inside every volume, storey by storey.
    const slabs: { corners: Vector3[]; y: number }[] = [];
    for (const v of resolveBlocks(b).volumes) {
      if (v.open) continue;
      const corners = [[v.x, v.y], [v.x + v.w, v.y], [v.x + v.w, v.y + v.d], [v.x, v.y + v.d]].map(([lx, ly]) => {
        const p = localToWorld(b, lx!, ly!);
        return new Vector3(p.x, 0, -p.y);
      });
      // At each block's own floors (a split level stands at its own, `Volume.lift`).
      for (let level = v.base + 1; level < v.base + v.storeys.length; level++) slabs.push({ corners, y: floor + volumeElevation(b, v, level) });
    }
    const { input, materials } = prepareFracture(source.chunk, source.kit, slabs, b.id * 2654435761, interiorFurniture(b, floor));
    const id = nextJob++;
    jobs.set(id, { b, floor, materials, hits: [] });
    workerOf().postMessage({ id, input });
    return id;
  };

  /**
   * Pieces knocked loose, waiting to be cut out and sent flying. A blow is
   * decided at once (what falls, what collapses), but each piece costs its own
   * geometry, a buffer upload and a vertex array on its first draw: a bomb on
   * a block let a few hundred go in one frame, 465 ms of it on the RTX
   * (2026-10-09). They go a slice of milliseconds a frame (`update`), the
   * nearest first, as the game spreads its other uploads (`uploads.ts`
   * `WARM_SLICE_MS`); the rest stand in the still mesh a frame or two longer,
   * the blast running through the building.
   */
  const queued: { ruin: Ruin; piece: Piece; from: Vector3; power: number }[] = [];
  let queuedAt = 0;
  const release = (ruin: Ruin, piece: Piece, from: Vector3, power: number): void => {
    if (piece.falling) return;
    piece.falling = true;
    ruin.standing--;
    queued.push({ ruin, piece, from, power });
  };
  const loosen = (ruin: Ruin, piece: Piece, from: Vector3, power: number): void => {
    // Out of the ruin's still mesh, drawn on its own while it flies: its
    // geometry cut from its ranges first, while they still hold it.
    piece.mesh.geometry = fragmentGeometry(ruin.data, piece.index);
    blank(ruin, piece);
    group.add(piece.mesh);
    const away = piece.mesh.position.clone().sub(from);
    const d = away.length() || 1;
    away.divideScalar(d);
    piece.v.copy(away).multiplyScalar(power * (0.5 + Math.random() * 0.6));
    piece.v.y += power * 0.25 * Math.random();
    piece.w.set((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3).multiplyScalar(0.4 + power / m(10));
    loose.push(piece);
    // Dust where it breaks off.
    if (Math.random() < 0.5) {
      const p = piece.mesh.position;
      exhaust.burst(p.x, -p.z, p.y, 3, 3, piece.fragment.radius * 0.6, m(2.5), 3.5);
    }
  };

  const strike = (ruin: Ruin, floor: number, x: number, y: number, z: number, strength: number, eye?: Vector3): boolean => {
      let impact = new Vector3(x, z, -y);
      // Once broken, the blow lands on the first standing piece along the line
      // of sight through the point: what is left of the building, not the air
      // where the rest of it was.
      if (eye) {
        // `eye` is the camera's looking direction (an orthographic camera's rays are parallel).
        const dir = eye.clone().normalize();
        eye = impact.clone().addScaledVector(dir, -m(2000));
        let best: Vector3 | null = null, bestT = Infinity;
        const to = new Vector3();
        for (const p of ruin.pieces) {
          if (p.falling) continue;
          to.copy(p.mesh.position).sub(eye);
          const t = to.dot(dir);
          if (t <= 0) continue;
          const off = to.clone().addScaledVector(dir, -t).length();
          if (off < p.fragment.radius * 0.8 + m(1.5) && t < bestT) { bestT = t; best = p.mesh.position.clone(); }
        }
        // Nothing on the line: the standing piece nearest the point aimed at.
        if (!best) {
          let bd = Infinity;
          for (const p of ruin.pieces) {
            if (p.falling || p.fragment.centre[1] < floor + m(0.6)) continue;
            const d = p.mesh.position.distanceTo(impact);
            if (d < bd) { bd = d; best = p.mesh.position.clone(); }
          }
        }
        if (best) impact = best;
      }
      const reach = m(1.4 + strength * 0.55);
      const power = m(2 + strength * 1.1);
      for (const piece of ruin.pieces) {
        if (piece.falling) continue;
        const d = piece.mesh.position.distanceTo(impact) - piece.fragment.radius * 0.5;
        if (d < reach) release(ruin, piece, impact, power * Math.max(0.3, 1 - d / reach));
      }
      exhaust.burst(impact.x, -impact.z, impact.y, 10 + strength * 2, 3, reach * 0.6, m(2.5 + strength * 0.2), 4);
      exhaust.burst(impact.x, -impact.z, impact.y, 20 + strength * 4, 9, reach * 0.4, m(0.3), 18);
      // What hangs on nothing now comes down: it falls, it is not thrown.
      for (const piece of unsupported(ruin)) release(ruin, piece, piece.mesh.position.clone().add(new Vector3(0, m(1), 0)), m(0.5));
      // Counted over what stands above the ground: the lot's paving and the
      // plinth are never knocked down by blows above them.
      const upper = ruin.pieces.filter((p) => p.fragment.centre[1] > floor + m(0.6));
      if (upper.filter((p) => !p.falling).length < upper.length * COLLAPSE_BELOW) {
        for (const piece of ruin.pieces) {
          // What lies on the ground (the lot's paving, the plinth) stays as it
          // is in the still mesh, and goes with the rubble later.
          if (piece.fragment.centre[1] < floor + m(0.6)) {
            if (!piece.falling) { piece.falling = true; piece.settled = true; ruin.standing--; }
          } else release(ruin, piece, impact, m(0.6));
        }
        exhaust.burst(x, y, floor, 60, 3, m(10), m(5), 6);
        // Papers from the offices and homes, fluttering over the street for a while.
        exhaust.burst(x, y, z, 120, 9, m(8), m(0.35), 22);
        return true;
      }
      return false;
  };

  /** Every standing piece not joined to the ground through standing pieces. */
  const unsupported = (ruin: Ruin): Piece[] => {
    const held = new Uint8Array(ruin.pieces.length);
    const stack: number[] = [];
    ruin.pieces.forEach((p, i) => {
      if (!p.falling && p.fragment.low <= ruin.floor + m(0.6)) { held[i] = 1; stack.push(i); }
    });
    while (stack.length) {
      const i = stack.pop()!;
      for (const j of ruin.pieces[i]!.fragment.neighbours) {
        if (!held[j] && !ruin.pieces[j]!.falling) { held[j] = 1; stack.push(j); }
      }
    }
    return ruin.pieces.filter((p, i) => !p.falling && !held[i]);
  };

  return {
    group,
    ruined,
    get onDown() { return api.onDown; },
    set onDown(f) { api.onDown = f; },
    get onRuined() { return api.onRuined; },
    set onRuined(f) { api.onRuined = f; },
    hit(b, floor, x, y, z, strength, eye) {
      const ruin = ruins.get(b.id);
      if (!ruin) {
        let job = pending.get(b.id);
        if (job === undefined) {
          const made = make(b, floor);
          if (made === null) return false;
          job = made;
          pending.set(b.id, job);
        }
        jobs.get(job)?.hits.push([x, y, z, strength, eye?.clone()]);
        // Dust where it was struck, at once, while its pieces are being made.
        exhaust.burst(x, y, z, 12 + strength * 2, 3, m(2 + strength * 0.4), m(2.5 + strength * 0.2), 4);
        return false;
      }
      return strike(ruin, floor, x, y, z, strength, eye);
    },
    update(dt) {
      // The pieces of the last blows, a few milliseconds a frame (`release`).
      if (queuedAt < queued.length) {
        const until = performance.now() + RELEASE_SLICE_MS;
        let done = 0;
        while (queuedAt < queued.length && (done < RELEASE_MIN || performance.now() < until)) {
          const job = queued[queuedAt++]!;
          loosen(job.ruin, job.piece, job.from, job.power);
          done++;
        }
        if (queuedAt >= queued.length) { queued.length = 0; queuedAt = 0; }
      }
      for (let i = loose.length - 1; i >= 0; i--) {
        const p = loose[i]!;
        const mesh = p.mesh;
        p.age += dt;
        if (!p.settled) {
          p.v.y -= GRAVITY * dt;
          mesh.position.addScaledVector(p.v, dt);
          mesh.rotation.x += p.w.x * dt; mesh.rotation.y += p.w.y * dt; mesh.rotation.z += p.w.z * dt;
          const rest = p.floor + p.fragment.radius * 0.3;
          if (mesh.position.y <= rest) {
            mesh.position.y = rest;
            if (p.v.y < -m(3)) {
              p.v.multiplyScalar(0.3); p.v.y = Math.abs(p.v.y) * 0.5; p.w.multiplyScalar(0.4);
              if (p.fragment.radius > m(1.2) && Math.random() < 0.3) exhaust.burst(mesh.position.x, -mesh.position.z, p.floor, 3, 3, m(1.5), m(3), 4);
            } else {
              // Settled: it stays where it fell, a heap of the building, for
              // good (the player: "não faça os escombros sumirem"); no longer
              // stepped, and drawn with its ruin again.
              p.settled = true;
              p.v.set(0, 0, 0);
              p.age = 0;
              loose.splice(i, 1);
              const ruin = owner.get(p);
              if (ruin) land(ruin, p);
            }
          }
        }
      }
      // A ruin whose pieces are all gone is forgotten; its geometry is released.
      for (const [id, ruin] of ruins) {
        if (!ruin.pieces.every((p) => p.gone)) continue;
        for (const p of ruin.pieces) if (p.mesh.geometry !== NO_GEOMETRY) p.mesh.geometry.dispose();
        ruin.still.geometry.dispose();
        ruins.delete(id);
        ruined.delete(id);
      }
    },
    dispose() {
      for (const ruin of ruins.values()) {
        for (const p of ruin.pieces) if (p.mesh.geometry !== NO_GEOMETRY) p.mesh.geometry.dispose();
        ruin.still.geometry.dispose();
      }
      group.clear();
    },
  };
}

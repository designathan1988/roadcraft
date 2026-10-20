import { Group, type Material, type Mesh, type Object3D, type ShaderMaterial } from 'three';
import { compileAhead, compileAheadWith, compileCopy, compilesQuiet, shadowStandIns } from './uploads';

/** THE PROGRAMS COMPILED AT LOAD: a closed catalogue of what the game draws with, built before the curtain lifts */

/** The families of the catalogue, every one compiled before the town is shown. */
export const PROGRAM_FAMILIES = ['world', 'people'] as const;
type ProgramFamily = typeof PROGRAM_FAMILIES[number];

/** A family's stand-ins: drawn lit into the frame's target, and cast into the sun's shadow (`uploads.ts` shadowStandIn). */
interface FamilyStandIns {
  readonly lit: Object3D;
  readonly shadow: Object3D;
}

/** The debug counter of one family: its stand-ins, and whether their programs are built. */
interface FamilyCount {
  readonly lit: number;
  readonly shadow: number;
  readonly compiled: boolean;
}

interface ShaderCatalogue {
  /** Settles once every family of this opening compiled (the loading curtain waits for it, `main.ts`). */
  readonly ready: Promise<void>;
  /** A map is being opened (`SceneHandle.beginLoad`): its world is compiled again when it is in. */
  begin(): void;
  /** The town is in (`RevealGate` warm or show): every family compiled, once an opening. */
  compile(scene: Object3D): void;
  /** Each family's stand-ins and whether they compiled: null for one not compiled yet. */
  counts(): Readonly<Record<ProgramFamily, FamilyCount | null>>;
}

/** Meshes under `root`, the stand-ins counted. */
function meshesIn(root: Object3D): number {
  let n = 0;
  root.traverse((o) => { if ((o as { isMesh?: boolean }).isMesh) n++; });
  return n;
}

/** Whether a material is drawn with the scene's lights: its program changes with their number. */
const isLit = (material: Material): boolean => {
  const m = material as Material & { isMeshStandardMaterial?: boolean; isMeshLambertMaterial?: boolean; isMeshPhongMaterial?: boolean; isMeshToonMaterial?: boolean };
  return !!(m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial || m.isMeshToonMaterial || (material as ShaderMaterial).lights);
};

/** One stand-in for each lit program the meshes under `roots` are drawn with (its material and what of the mesh is in the program's key): what a light variant compiles, not the whole scene again. */
export function litStandIns(roots: readonly Object3D[]): Group {
  const group = new Group();
  const seen = new Set<string>();
  for (const root of roots) {
    root.traverse((object) => {
      const mesh = object as Mesh & { isInstancedMesh?: boolean; isSkinnedMesh?: boolean; isBatchedMesh?: boolean; instanceColor?: unknown; morphTexture?: unknown };
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (!materials.some(isLit)) return;
      const g = mesh.geometry;
      const key = [materials.map((m) => m.uuid).join(','), !!mesh.isInstancedMesh, !!mesh.instanceColor, !!mesh.morphTexture, !!mesh.isSkinnedMesh, !!mesh.isBatchedMesh,
        mesh.receiveShadow, Object.keys(g.attributes).sort().join(','), Object.keys(g.morphAttributes).sort().join(',')].join('/');
      if (seen.has(key)) return;
      seen.add(key);
      const copy = compileCopy(mesh);
      copy.visible = true;
      group.add(copy);
    });
  }
  return group;
}

/** `people`: every program a person can be drawn with (`people/proceduralCrowd.ts` personProgramStandIns), built without a body. `lightVariants`: the sets of the scene's lights a light switched on or off makes (`renderer.ts`), each compiled before the curtain lifts, one at a time and when nothing else compiles (`compilesQuiet`): a program first used in play waits for its link in the frame (three's WebGLRenderer.compileAsync: precompile before the first render). */
export function createShaderCatalogue(people: () => FamilyStandIns, lightVariants: () => readonly (readonly Object3D[])[] = () => []): ShaderCatalogue {
  const counts = Object.fromEntries(PROGRAM_FAMILIES.map((name) => [name, null])) as Record<ProgramFamily, FamilyCount | null>;
  let settle: () => void = () => {};
  let ready = new Promise<void>((done) => { settle = done; });
  let compiled = false;
  let peopleDone: Promise<void> | null = null;
  /** The people's lit stand-ins, kept for the light variants. */
  let peopleLit: Object3D | null = null;

  /** One family's stand-ins compiled ahead, lit and in the shadow; counted when done. A family that cannot be built is said, never awaited for ever. */
  const family = (name: ProgramFamily, build: () => FamilyStandIns): Promise<void> => {
    let standIns: FamilyStandIns;
    try {
      standIns = build();
    } catch (error) {
      console.error(`[programs] the ${name} family could not be built`, error);
      return Promise.resolve();
    }
    const lit = meshesIn(standIns.lit), shadow = meshesIn(standIns.shadow);
    counts[name] = { lit, shadow, compiled: false };
    // DO NOT let a failed compile hold the curtain for ever: said, and the family left counted as not compiled.
    return Promise.all([compileAhead(standIns.lit), compileAhead(standIns.shadow, true)]).then(() => {
      counts[name] = { lit, shadow, compiled: true };
    }, (error: unknown) => { console.error(`[programs] the ${name} family did not compile`, error); });
  };

  return {
    get ready() {
      return ready;
    },
    begin() {
      if (!compiled) return;
      compiled = false;
      ready = new Promise<void>((done) => { settle = done; });
    },
    /** @rebuild Once an opening; every later call returns at its first check. */
    compile(scene) {
      if (compiled) return;
      compiled = true;
      const done = settle;
      // The world as it stands, hidden things too (`compileAsync` walks every mesh), and each of its casters' shadow programs once.
      const world = family('world', () => ({ lit: scene, shadow: shadowStandIns(scene) }));
      // The people come after the town is shown: their programs, every one of them, now (`personVariants.ts`).
      peopleDone ??= family('people', () => { const made = people(); peopleLit = made.lit; return made; });
      void Promise.all([world, peopleDone]).then(async () => {
        // The variants of the lights switched on or off (the room and effect lights, the fill at night): built now, before the curtain
        // lifts and the first switch draws with one. DO NOT leave them to a quiet moment during play (they waited minutes, then every
        // lit material of the view was built in one frame). They are still asked one set at a time: four sets at once held the driver
        // 12-15 s after the opening (`__compileLog`, prova motor-compilacao, 2026-10-18).
        const sets = lightVariants();
        const standIns = sets.length ? litStandIns(peopleLit ? [scene, peopleLit] : [scene]) : null;
        if (standIns) for (const lights of sets) {
          await compilesQuiet();
          await compileAheadWith(standIns, lights);
        }
        standIns?.clear();
        performance.mark('programs:compiled', { detail: counts });
        done();
      });
    },
    counts() {
      return counts;
    },
  };
}

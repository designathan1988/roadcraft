import { Group, type Material, type Mesh, type Object3D, type ShaderMaterial } from 'three';
import { compileAhead, compileAheadWith, compileCopy, shadowStandIns, warmPending } from './uploads';

/** THE PROGRAMS COMPILED AT LOAD: a closed catalogue of what the game draws with, built before the curtain lifts */

/** The families of the catalogue, every one compiled before the town is shown. */
export const PROGRAM_FAMILIES = ['world', 'people'] as const;
/** The name of the world's stand-ins (`compile`): what the tests tell apart from a light variant's. */
export const WORLD_STAND_INS = 'program-stand-ins-world';
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
  /** The curtain lifted: the light variants the opening did not wait for are asked now, once the uploads that came with the town are in (`warmPending`), never while they hold the driver. */
  afterReveal(): void;
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

/** One stand-in for each lit program the meshes under `roots` are drawn with (its material and what of the mesh is in the program's key): what a light variant compiles, not the whole scene again. `lit` false: every program, lit or not (the world's own, `compile`). */
export function litStandIns(roots: readonly Object3D[], lit = true): Group {
  const group = new Group();
  const seen = new Set<string>();
  for (const root of roots) {
    root.traverse((object) => {
      const mesh = object as Mesh & { isInstancedMesh?: boolean; isSkinnedMesh?: boolean; isBatchedMesh?: boolean; instanceColor?: unknown; morphTexture?: unknown };
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (lit && !materials.some(isLit)) return;
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
  /** The light variants the curtain did not wait for, asked once the curtain lifts and the town's uploads are in (`afterReveal`). */
  let deferred: (() => Promise<void>) | null = null;

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
      deferred = null;
      ready = new Promise<void>((done) => { settle = done; });
    },
    /** @rebuild Once an opening; every later call returns at its first check. */
    compile(scene) {
      if (compiled) return;
      compiled = true;
      const done = settle;
      // The world as it stands, hidden things too (`compileAsync` walks every mesh), and each of its casters' shadow programs once.
      // DO NOT hand three the scene itself: its compile works out every mesh's program parameters and key, thousands of meshes for a few
      // hundred programs - 3 to 7 s of the page frozen creating a city of 8,102 buildings (`npm run diagnose`, 2026-10-22). One stand-in a
      // program (its material and what of the mesh is in the program's key, as the light variants are), let go once compiled.
      let worldLit: Group | null = null;
      const world = family('world', () => { worldLit = litStandIns([scene], false); worldLit.name = WORLD_STAND_INS; return { lit: worldLit, shadow: shadowStandIns(scene) }; })
        .finally(() => { worldLit?.clear(); });
      // The people come after the town is shown: their programs, every one of them, now (`personVariants.ts`).
      peopleDone ??= family('people', () => { const made = people(); peopleLit = made.lit; return made; });
      void Promise.all([world, peopleDone]).then(async () => {
        // The variants of the lights switched on or off (the room and effect lights, the fill at night), the set the town opens under
        // FIRST (`renderer.ts` lightVariants): only that one holds the curtain. The others are asked right after it lifts, one set at a
        // time: no pixel of the opening shows them, and waiting for them held the driver half the opening's compile time (measured 2026-10-20).
        try {
          const sets = lightVariants();
          const standIns = sets.length ? litStandIns(peopleLit ? [scene, peopleLit] : [scene]) : null;
          if (standIns) {
            await compileAheadWith(standIns, sets[0]!);
            const rest = sets.slice(1);
            if (rest.length) deferred = async () => { try { for (const lights of rest) await compileAheadWith(standIns, lights); } finally { standIns.clear(); } };
            else standIns.clear();
          }
        } catch (error) {
          // Said, the curtain let go: a variant that cannot be built is built at its first draw, as before.
          console.error('[programs] the light variants did not compile', error);
        }
        performance.mark('programs:compiled', { detail: counts });
        done();
      });
    },
    afterReveal() {
      if (!deferred) return;
      const job = deferred;
      deferred = null;
      void (async () => {
        // Never while the town's buffers go up (`warmPending`): the driver builds the variants and uploads at once, and the first frames
        // of play waited seconds for both (measured 2026-10-20). Waited on the frame's cadence, not a timer, and never for ever.
        for (let until = performance.now() + 30_000; warmPending() && performance.now() < until;) {
          await new Promise<void>((done) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => done()) : setTimeout(done, 500)));
        }
        await job();
      })();
    },
    counts() {
      return counts;
    },
  };
}

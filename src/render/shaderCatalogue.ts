import type { Object3D } from 'three';
import { compileAhead, shadowStandIns } from './uploads';

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

/** `people`: every program a person can be drawn with (`people/proceduralCrowd.ts` personProgramStandIns), built without a body. */
export function createShaderCatalogue(people: () => FamilyStandIns): ShaderCatalogue {
  const counts = Object.fromEntries(PROGRAM_FAMILIES.map((name) => [name, null])) as Record<ProgramFamily, FamilyCount | null>;
  let settle: () => void = () => {};
  let ready = new Promise<void>((done) => { settle = done; });
  let compiled = false;
  let peopleDone: Promise<void> | null = null;

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
      peopleDone ??= family('people', people);
      void Promise.all([world, peopleDone]).then(() => {
        performance.mark('programs:compiled', { detail: counts });
        done();
      });
    },
    counts() {
      return counts;
    },
  };
}

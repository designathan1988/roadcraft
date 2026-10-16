import type { Finish } from '@world/buildings/materials';
import type { WholeMapOptions } from '@world/cityGen/wholeMap';
import type { TileRecords } from '@world/tiles';
import { canQueueJobs, focusDistance, jobWorkers, submitJob } from '../../jobs/jobPool';
import { forgetOtherDerived } from '../derivedCache';
import { type FarKind, FarTree, type FarTreeRun } from '../farTree';
import type { SharedGroundData } from '../sharedGround';
import type { CellMass } from './cellArrays';
import { TIER_SPAN } from './cellPool';
import { type FarJob, type FarReply, derivedFarCache, farNode, levelDrop, nodeSide, runFarJob } from './farTiles';
import type { BuildingKit } from './kit';
import { FAR_ERROR, cellMesh } from './massCells';

/** THE BUILDINGS OF THE TILES NOT IN THE PAGE'S DOCUMENT (CLAUDE.md "Streaming world"): a quadtree of levels baked per tile in workers from the tile store (`farTiles.ts`), and from the generator's plan where no tile was made (`farPlan.ts`) */
/** Chosen top down by their error on the screen (`farTree.ts`, the walk the far roads share), as the cells' tiles and plates are (`massCells.ts`); the tiles the document holds are drawn by `massCells.ts`, never here */

declare const __FAR_MASS_HASH__: string | undefined;
/** The fingerprint of the code the far levels are baked by (`cook-plugin.ts`): bakes are kept under it; none (tests): nothing kept. */
const FAR_HASH = typeof __FAR_MASS_HASH__ !== 'undefined' && __FAR_MASS_HASH__ ? __FAR_MASS_HASH__ : null;
const FAR_PREFIX = FAR_HASH ? `farMass:${FAR_HASH}:` : null;
/** The far jobs' band in the queue: after the cells' tiles and plates, before the summaries (`cellPool.ts` `TIER`). */
const FAR_TIER = 2.9;
/** The finest level drawn from the plan: the boxes' (levels 0 and 1, a tile's and a plate's masses, only from made tiles). */
const PLAN_LEVEL = 2;

/** Where the far levels read the tile store (the coordinator wires it) */
export interface FarTileSource {
  /** A tile as the store keeps it; null when it has none. */
  records(key: number): Promise<TileRecords | null>;
  /** The world's generator options: what stands where no tile was made yet (drawn from the plan, `farPlan.ts`); null: nothing past the stored tiles. */
  readonly plan: WholeMapOptions | null;
}

/** What the coordinator tells the buildings' far levels (`BuildingLayer.far`). */
export interface FarTiles {
  /** The store to read (and the world's plan) and which tiles the page's document holds now (the streamer's region): those are drawn by the cells, never here. */
  setSource(source: FarTileSource | null, isLoaded: (tileKey: number) => boolean): void;
  /** A tile written by the store at a version (made, changed), or gone (null): it and its ancestors baked again when wanted, nothing else. */
  stored(tileKey: number, version: number | null): void;
  /** A tile loaded into the page's document or unloaded from it: `isLoaded` read again for it. */
  loadedChanged(tileKey: number): void;
}

/** What the far jobs read of the page: the shared ground, whether the natural ground is the drawn one, each finish's colour from afar. */
interface FarEnv {
  readonly ground: SharedGroundData | null;
  readonly naturalIsGround: boolean;
  readonly tone?: Readonly<Record<Finish, readonly [number, number, number]>>;
}

/** Runs a far job and answers once; gives back its cancel (an answer cancelled is never given). */
export type FarRun = (job: FarJob, done: (reply: FarReply) => void) => () => void;

/** DO NOT bake on the page: the far jobs go to the job system's queue (the cells' service), the page only when no worker can run (tests) */
export function farRunner(env: () => FarEnv): FarRun {
  return (job, done) => {
    const full = (): FarJob => {
      const e = env();
      return { ...job, ground: e.ground, naturalIsGround: e.naturalIsGround, ...(e.tone ? { tone: e.tone } : {}) };
    };
    if (!canQueueJobs()) {
      let live = true;
      void runFarJob(full(), derivedFarCache).then(
        (reply) => { if (live) done(reply); },
        (error: unknown) => { if (live) done({ kind: 'farError', node: job.node, sig: job.sig, message: String(error) }); },
      );
      return () => { live = false; };
    }
    const { k, i, j } = farNode(job.node);
    const side = nodeSide(k);
    const ticket = submitJob({
      service: 'cells',
      key: `far:${job.node}`,
      priority: FAR_TIER * TIER_SPAN + focusDistance((i + 0.5) * side, (j + 0.5) * side),
      write: () => ({ data: full(), transfer: [] }),
      done: (answer) => done(answer as FarReply),
      failed: (message) => done({ kind: 'farError', node: job.node, sig: job.sig, message }),
    });
    return () => ticket.cancel();
  };
}

/** The tree's jobs as the buildings' far jobs (`farTiles.ts` `runFarJob`), their masses its payload. */
function asTreeRun(run: FarRun): FarTreeRun<CellMass> {
  return (job, done) => run({
    far: true, node: job.node, sig: job.sig, want: job.want, prefix: job.prefix,
    ...(job.children ? { children: job.children } : {}),
    ...(job.records ? { records: job.records } : {}),
    ...(job.plan ? { plan: job.plan } : {}),
  }, (reply) => done(reply.kind === 'far' ? { kind: 'far', node: reply.node, sig: reply.sig, payload: reply.mass } : reply));
}

/** THE BUILDINGS' FAR LEVELS: the shared tree (`farTree.ts`) over their masses, drawn from the plan from the boxes' levels up */
export class FarLevels extends FarTree<CellMass> {
  /** `run`: where its jobs go (`farRunner`); `prefix`: the bakes' key in the store (null: nothing kept); `lanes`: the records read at once. */
  constructor(kit: BuildingKit, run: FarRun, prefix: string | null = FAR_PREFIX, lanes = canQueueJobs() ? jobWorkers() : 1) {
    const kind: FarKind<CellMass> = {
      name: 'buildings',
      land: (mass) => {
        const mesh = cellMesh(mass, kit, 'building-massing-far');
        const box = mesh.geometry.boundingBox!;
        // A building over the node's edge: its box is its masses' (plan y is three's -z).
        return { mesh, x0: box.min.x, x1: box.max.x, y0: -box.max.z, y1: -box.min.z, top: mass.top, error: Math.max(FAR_ERROR, mass.error) };
      },
      levelError: (k) => Math.max(FAR_ERROR, levelDrop(k)),
      planFrom: PLAN_LEVEL,
    };
    super(kind, asTreeRun(run), prefix, lanes);
    // The bakes of an older build of this code: let go.
    if (prefix !== null && prefix === FAR_PREFIX && FAR_HASH) forgetOtherDerived('farMass', FAR_HASH);
  }
}

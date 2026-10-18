import { canQueueJobs, jobWorkers, submitJob } from '../../jobs/jobPool';
import { forgetOtherDerived } from '../derivedCache';
import { type FarKind, FarTree, type FarTreeJob, type FarTreeRun } from '../farTree';
import { type FarMass, isBoxMass } from './cellArrays';
import { FAR_TIER, TIER_SPAN } from './cellPool';
import { type FarGroundEnv, type FarJob, type FarReply, derivedFarCache, farNode, levelDrop, nodeSide, runFarJob, tileRows } from './farTiles';
import type { BuildingKit } from './kit';
import { boxesMesh } from './massBoxes';
import { FAR_ERROR, cellMesh } from './massCells';

/** THE BUILDINGS OF THE TILES NOT IN THE PAGE'S DOCUMENT (CLAUDE.md "Streaming world"): a quadtree of levels baked per tile in workers from the tile store (`farTiles.ts`), every tile of the map made before the city is shown */
/** Chosen top down by their error on the screen (`farTree.ts`, the walk the far roads share), as the cells' tiles and plates are (`massCells.ts`); the tiles the document holds are drawn by `massCells.ts`, never here */

declare const __FAR_MASS_HASH__: string | undefined;
/** The fingerprint of the code the far levels are baked by (`cook-plugin.ts`): bakes are kept under it; none (tests): nothing kept. */
const FAR_HASH = typeof __FAR_MASS_HASH__ !== 'undefined' && __FAR_MASS_HASH__ ? __FAR_MASS_HASH__ : null;
const FAR_PREFIX = FAR_HASH ? `farMass:${FAR_HASH}:` : null;
/** DO NOT draw a box level's merged boxes smaller than this on the screen, px: at 2 px of error the plan's 32 m squares came out 1.6 px wide in the map view, a million boxes and five triangles a pixel over 16 km (2026-10-16); a level whose squares would span less gives way to its parent, so the boxes drawn are bounded by the screen, not by the world. */
const BOX_PIXELS = 4;

/** The first level drawn as boxes (levels 0 and 1 are a tile's and a plate's masses). */
const BOX_LEVEL = 2;

export type { FarTileSource, FarTiles } from '../farTree';

/** What the far jobs read of the page: the shared ground, whether the natural ground is the drawn one, each finish's colour from afar. */
/** What the far jobs read besides the buildings (`farTiles.ts` `FarGroundEnv`). */
type FarEnv = FarGroundEnv;

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
      priority: FAR_TIER * TIER_SPAN,
      at: [(i + 0.5) * side, (j + 0.5) * side],
      write: () => ({ data: full(), transfer: [] }),
      done: (answer) => done(answer as FarReply),
      failed: (message) => done({ kind: 'farError', node: job.node, sig: job.sig, message }),
    });
    return () => ticket.cancel();
  };
}

/** A tree's job as the buildings' far job (`farTiles.ts` `runFarJob`): DO NOT drop the store's map (dropped here, every far tile's buildings went store -> page -> worker though the worker reads the store itself), nor post the tile the page read (the desktop's store) but its buildings' rows in their shared tables (`tileRows`). */
export function farJobOf(job: FarTreeJob): FarJob {
  return {
    far: true, node: job.node, sig: job.sig, want: job.want, prefix: job.prefix,
    ...(job.children ? { children: job.children } : {}),
    ...(job.records ? { buildings: tileRows(job.records.buildings) } : {}),
    ...(job.store !== undefined ? { store: job.store } : {}),
    ...(job.plan ? { plan: job.plan } : {}),
  };
}

/** The tree's jobs as the buildings' far jobs, their masses its payload. */
function asTreeRun(run: FarRun): FarTreeRun<FarMass> {
  return (job, done) => run(farJobOf(job), (reply) => done(reply.kind === 'far' ? { kind: 'far', node: reply.node, sig: reply.sig, payload: reply.mass } : reply));
}

/** THE BUILDINGS' FAR LEVELS: the shared tree (`farTree.ts`) over their masses, drawn from the plan from the boxes' levels up */
export class FarLevels extends FarTree<FarMass> {
  /** `run`: where its jobs go (`farRunner`); `prefix`: the bakes' key in the store (null: nothing kept); `lanes`: the records read at once. */
  constructor(kit: BuildingKit, run: FarRun, prefix: string | null = FAR_PREFIX, lanes = canQueueJobs() ? jobWorkers() : 1) {
    const kind: FarKind<FarMass> = {
      name: 'buildings',
      land: (mass) => {
        // A box level's boxes as instances of the kit's unit box (`massBoxes.ts`); a tile's and a plate's masses as they came.
        const mesh = isBoxMass(mass) ? boxesMesh(mass, kit) : cellMesh(mass, kit, 'building-massing-far');
        const box = mesh.geometry.boundingBox!;
        // A building over the node's edge: its box is its masses' (plan y is three's -z).
        return { mesh, x0: box.min.x, x1: box.max.x, y0: -box.max.z, y1: -box.min.z, top: mass.top, error: Math.max(FAR_ERROR, mass.error) };
      },
      levelError: (k) => Math.max(FAR_ERROR, levelDrop(k)),
      // A box level's error is its square's diagonal (`levelDrop`): a square `BOX_PIXELS` wide on the screen at the least.
      levelPixels: (k) => (k >= BOX_LEVEL ? BOX_PIXELS * Math.SQRT2 : 0),
      // Where no tile is made yet, the plan's boxes from the boxes' levels up (`farPlan.ts`): never a hole while the map is made.
      planFrom: BOX_LEVEL,
    };
    super(kind, asTreeRun(run), prefix, lanes);
    // The bakes of an older build of this code: let go.
    if (prefix !== null && prefix === FAR_PREFIX && FAR_HASH) forgetOtherDerived('farMass', FAR_HASH);
  }
}

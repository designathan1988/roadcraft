import { type NearBaker, type NearKind, type NearPart, type NearTileCache, type NearTileJob, type NearTileReply, nearReplyBuffers, runNearTileJob } from './nearTileBake';
import { furnitureBaker } from './furnitureTiles';
import { poleBaker } from './poleTiles';
import { signBaker } from './signTiles';

/** EVERY KIND OF NEAR PRODUCT'S BAKE (`nearTileBake.ts`), one module each, all in this file's closure: their code is the bakes' fingerprint (`cook-plugin.ts`), a change of any making the kept bakes stale */
const BAKERS: Readonly<Record<NearKind, NearBaker<unknown>>> = {
  poles: poleBaker as NearBaker<unknown>,
  furniture: furnitureBaker as NearBaker<unknown>,
  signs: signBaker as NearBaker<unknown>,
};

/** The parts a kind reads (what the page posts of a tile it holds edited). */
export const nearParts = (kind: NearKind): readonly NearPart[] => BAKERS[kind].parts;
/** Whether a kind reads the tiles round its tile. */
export const nearReadsAround = (kind: NearKind): boolean => BAKERS[kind].around;

/** A near job run by its kind's bake. */
export const runNearJob = (job: NearTileJob, cache: NearTileCache): Promise<NearTileReply> => runNearTileJob(job, cache, BAKERS[job.kind]);

/** An answer's buffers, by its kind's bake. */
export const nearJobBuffers = (job: NearTileJob, reply: NearTileReply): ArrayBuffer[] => nearReplyBuffers(BAKERS[job.kind], reply);

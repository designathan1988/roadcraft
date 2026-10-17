import { type NearBaker, type NearKind, type NearPart, type NearTileCache, type NearTileJob, type NearTileReply, nearReplyBuffers, runNearTileJob } from './nearTileBake';
import { barrierBaker } from './barrierTiles';
import { coverBaker } from './coverTiles';
import { furnitureBaker } from './furnitureTiles';
import { gardenBaker } from './gardenTiles';
import { plantedBaker } from './plantedTiles';
import { poleBaker } from './poleTiles';
import { signBaker } from './signTiles';
import { structureBaker } from './structureTiles';

/** EVERY KIND OF NEAR PRODUCT'S BAKE (`nearTileBake.ts`), one module each, all in this file's closure: their code is the bakes' fingerprint (`cook-plugin.ts`), a change of any making the kept bakes stale */
const BAKERS: Readonly<Record<NearKind, NearBaker<unknown>>> = {
  poles: poleBaker as NearBaker<unknown>,
  furniture: furnitureBaker as NearBaker<unknown>,
  signs: signBaker as NearBaker<unknown>,
  barriers: barrierBaker as NearBaker<unknown>,
  planted: plantedBaker as NearBaker<unknown>,
  structures: structureBaker as NearBaker<unknown>,
  gardens: gardenBaker as NearBaker<unknown>,
  covers: coverBaker as NearBaker<unknown>,
};

/** The parts a kind reads (what the page posts of a tile it holds edited). */
export const nearParts = (kind: NearKind): readonly NearPart[] => [...BAKERS[kind].parts, ...(BAKERS[kind].more ?? [])];
/** The parts a kind always reads (not those it reads only where the tile has something of it, `more`): what an edited tile is named by for it. */
export const nearReadParts = (kind: NearKind): readonly NearPart[] => BAKERS[kind].parts;
/** Whether a kind reads the tiles round its tile. */
export const nearReadsAround = (kind: NearKind): boolean => BAKERS[kind].around;

/** A kind's bake. */
const bakerOf = (kind: NearKind): NearBaker<unknown> => BAKERS[kind];

/** A near job run by its kinds' bakes. */
export const runNearJob = (job: NearTileJob, cache: NearTileCache): Promise<NearTileReply> => runNearTileJob(job, cache, bakerOf);

/** An answer's buffers, by its kinds' bakes. */
export const nearJobBuffers = (reply: NearTileReply): ArrayBuffer[] => nearReplyBuffers(bakerOf, reply);

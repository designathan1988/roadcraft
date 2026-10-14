import { workUntil } from '@core/frameWork';
import { Group, type InstancedMesh, type Mesh, type Object3D } from 'three';
import { warmLooseAhead } from '../uploads';

import type { RoadDoc } from '@world/doc';
import type { GroundAt, PavedAt } from '@world/buildings/foundation';
import { buildingBounds } from '@world/buildings/geometry';
import type { Building, BuildingId } from '@world/buildings/types';
import { cutOpen } from '@world/buildings/interior';
import { type BuildingChunk, type BuildingMeshes, assembleBuildingMeshes, assembleBuildingMeshesSteps, buildBuildingMeshes, emitChunk, fliesFlag, signatureFloorOf } from './buildingMesh';
import {
  BATCH_CELL, CHUNK_CACHE_BYTES, COARSE_PARTS, type CellCache, DETAIL_CELL, DETAIL_HYSTERESIS, DETAIL_PARTS, EMPTY_PARTS, FRAME_SIDE, FULL_DETAIL_PIXELS,
  HIDDEN_SLICE_MS, LOADING_COUNT, LOADING_SLICE_MS, RELEASE_FRAMES, STREAM_CELLS_PER_FRAME, WARM_SLICE_MS, assembleByCell, chunkBytes, chunksByCell, createCoverIndex, detailKeysOf, dropCell, groundDigest, groupByCell, sameChunks,
} from './layerCells';
import { createFlagLayer } from './flagLayer';
import { buildSignature, disposeSignature, drawsSignature } from './signature';
import { emitMassing, type MassingChunk } from './massing';
import { createMassCells } from './massCells';
import { type BuildingKit, type PartKind, createBuildingKit } from './kit';

/**
 * The buildings layer: the stored buildings and the editor's preview, each
 * rebuilt only when what it depends on moves (CLAUDE.md (Execution flow)).
 *
 * The stored buildings depend on `doc.buildings.revision`, on the ground
 * (`groundKey`: the serial of the last ground change that reached a building,
 * `render/groundChanges.ts`) and on which one the preview is standing in for.
 * A building samples its ground again only when `groundTouched` says a change
 * since its last sample reached it. The preview depends on its own serial.
 *
 * HLOD WITH STREAMING: a cell's detail (`BATCH_CELL`) exists only while the
 * cell is drawn near by the error on the screen (`massCells.ts`); far, only its
 * masses stand. A cell coming near is put together a few ms a frame and sent to
 * the GPU before it shows (`streamCells`); far for `RELEASE_FRAMES` its meshes
 * go, its arrays as the cache allows (`slim`). Unreal's World Partition HLOD and
 * 3D Tiles' REPLACE refinement. NÃO voltar a montar o detalhe de todas as células.
 */
export interface BuildingPreviewInput {
  readonly building: Building;
  readonly valid: boolean;
  readonly hides: BuildingId | null;
  readonly serial: number;
  /** Drawn in the building's own materials, not as a ghost (the interior view). */
  readonly solid?: boolean;
}

export interface BuildingLayer {
  readonly group: Group;
  readonly triangles: number;
  /** Bumped whenever the stored buildings are rebuilt. */
  readonly version: number;
  /** A change is still being emitted (`update` keeps the town as it was until it is done). */
  readonly pending: boolean;
  /**
   * Nothing is being shown (a map loading behind its curtain, `SceneHandle.opening`):
   * a load then takes `HIDDEN_SLICE_MS` a frame, there being no frame to keep smooth.
   */
  hidden: boolean;
  /**
   * Rebuilds what is stale. Returns true if the stored buildings were rebuilt.
   * `pavedAt` is the paving (footways, carriageways) entrances open onto.
   */
  update(doc: RoadDoc, groundAt: GroundAt, groundKey: string, pavedAt?: PavedAt, naturalAt?: GroundAt,
    groundTouched?: (b: Building, sinceKey: string) => boolean): boolean;
  setPreview(preview: BuildingPreviewInput | null): void;
  /**
   * "See inside": every building within `radius` of (x, y) is drawn cut open
   * at `level`, its rooms and furniture showing; null draws them whole.
   */
  setCutaway(spec: CutawaySpec | null): void;
  /** Windows lit from inside at night, as many as are awake at `hour` (see `BuildingKit.setNight`). */
  setNight(dark: number, hour?: number): void;
  /** From afar (true) the frames and railings are drawn by their street faces only. */
  setFar(far: boolean): void;
  /** Thin facade parts stop casting shadows when their shadow width is subpixel. */
  setShadowFar(far: boolean): void;
  /**
   * The frames, railings and louvres of each cell: drawn while its buildings
   * are (their far level decides, `levelOfDetail`, by the error on the
   * screen), whole where a frame's side spans enough pixels and by their
   * street faces beyond. The eye and the screen as `levelOfDetail` takes them.
   */
  cullDetails(eyeX: number, eyeY: number, eyeZ: number, pxAtMetre: number, orthoPx: number | null): void;
  /**
   * Each cell of buildings drawn near (in detail) or far (its buildings'
   * masses, `massCells.ts`) by the error on the screen: from the eye (map
   * x/y and height), `pxAtMetre` the pixels a metre spans a metre away in a
   * perspective view, or `orthoPx` the pixels a metre spans in an
   * orthographic one (null in perspective); `reach` how far from the eye,
   * on the map, a cell may still be near (the ground the screen takes in,
   * with a margin; Infinity for no limit). Before `cullDetails`.
   */
  levelOfDetail(eyeX: number, eyeY: number, eyeZ: number, pxAtMetre: number, orthoPx: number | null, reach?: number): void;
  /**
   * "Ocultar outros": undefined draws every building solid, null fades them
   * all, and an id fades every building but that one.
   */
  setDimmed(except: BuildingId | null | undefined): void;
  /** Buildings drawn by someone else (a ruin being knocked down, `destruction.ts`): left out here. */
  setRuined(ids: ReadonlySet<number>): void;
  /** A building's meshes as drawn (world space), with the kit they are drawn with: what a ruin is cut from. */
  chunkOf(b: Building): { chunk: BuildingChunk; kit: BuildingKit } | null;
  /** The kit its buildings are drawn with (for warming the shaders broken buildings use). */
  readonly kit: BuildingKit;
  /** Whether a world point is under a building (for the scenery's plant cull). */
  covers(x: number, y: number): boolean;
  /** Bumped when what `covers` answers changes (a footprint or a lot moved, came or went). */
  readonly coversVersion: number;
  /**
   * Height of a building's lot or parking bay as drawn at a world point, NaN
   * off them: what a resident's parked car stands on (`render/agents.ts`).
   */
  lotHeightAt(building: BuildingId, x: number, y: number): number;
  /** The drawn height of whichever building's lot is at a point, NaN off every lot. */
  anyLotHeightAt(x: number, y: number): number;
  dispose(): void;
}

export interface CutawaySpec {
  readonly level: number;
  /** The way the camera looks, world and horizontal: the walls facing it come down. */
  readonly view: { readonly x: number; readonly y: number };
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  /** Only this building is cut open (the one the player clicked); the rest stand whole. */
  readonly only?: BuildingId;
}

/**
 * Each record's text, written once per record object (MDN, WeakMap: a result
 * kept per object while the object lives). The store never changes a record in
 * place - `put` stores a copy (`BuildingStore.toText` keeps its text the same
 * way) - so the text of a record seen before is the text it has now.
 */
const RECORD_TEXT = new WeakMap<Building, string>();
const recordText = (b: Building): string => {
  let text = RECORD_TEXT.get(b);
  if (text === undefined) {
    text = JSON.stringify(b);
    RECORD_TEXT.set(b, text);
  }
  return text;
};

export function createBuildingLayer(): BuildingLayer {
  const kit: BuildingKit = createBuildingKit();
  void kit.farReady.then(() => applyFacadeDetail()); // every batch takes its geometry and shadow detail again
  const group = new Group();
  group.name = 'buildings-layer';
  // Every flag in the city, waving: one instanced draw (`flagLayer.ts`).
  const flagLayer = createFlagLayer();
  group.add(flagLayer.group);
  /** The buildings from afar, a mesh a cell (`massCells.ts`). */
  const massCells = createMassCells(kit, BATCH_CELL);
  group.add(massCells.group);
  const signatureRoot = new Group();
  signatureRoot.name = 'signature-buildings';
  group.add(signatureRoot);
  const signatures = new Map<BuildingId, { key: string; group: Group }>();
  group.matrixAutoUpdate = false;
  group.updateMatrix();
  let stored: BuildingMeshes | null = null;
  let ruined: ReadonlySet<number> = new Set();
  let lastGround: { groundAt: GroundAt; groundKey: string; pavedAt: PavedAt | undefined; naturalAt: GroundAt } | null = null;
  /** Each cell's batch as last assembled, and from which buildings' meshes (`assembleByCell`). */
  const cells: CellCache = new Map();
  const detailCells: CellCache = new Map();
  let details: BuildingMeshes | null = null;
  let faded: BuildingMeshes | null = null;
  let dimmed: BuildingId | null | undefined = undefined;
  let ghost: BuildingMeshes | null = null;
  let storedKey = '';
  /** The buildings of a change being emitted ahead of the cells, a slice a frame. */
  let warming: { key: string; queue: Building[]; at: number; uploads?: number;
    /** A whole town to put together (the opening, a map opened): worked at the loading priority. */
    loading: boolean;
    /** The masses of the queue are made and the far level chosen: the detail of the near cells comes next. */
    massed: boolean;
    cells?: { stage: CellCache; cell: string; list: BuildingChunk[]; kinds: ReadonlySet<PartKind> }[];
    /** The cell being put together, a part kind a step. */
    assembling?: { stage: CellCache; cell: string; list: BuildingChunk[]; steps: Generator<void, BuildingMeshes, void> } | null } | null = null;
  /** Cells put together ahead of the swap (`update`), taken by `assembleByCell`. */
  const stagedCells: CellCache = new Map();
  const stagedDetails: CellCache = new Map();
  let ghostKey = '';
  let preview: BuildingPreviewInput | null = null;
  let cutaway: CutawaySpec | null = null;
  let version = 0;
  let far = false;
  let shadowFar = false;
  /**
   * HLOD streaming (see the file's comment). The eye as `levelOfDetail` last
   * had it says which cells are near; until it is known, every cell is.
   */
  const eyeNow = { x: 0, y: 0, z: 0, pxAtMetre: 0, orthoPx: null as number | null, reach: Infinity };
  let eye: typeof eyeNow | null = null;
  const cellOf = (b: Building): string => `${Math.floor(b.x / BATCH_CELL)},${Math.floor(b.y / BATCH_CELL)}`;
  /** Cells held near whatever the eye says: the building cut open, the one being edited. */
  let forcedNear: ReadonlySet<string> = new Set();
  const cellNear = (key: string): boolean => eye === null || forcedNear.has(key) || massCells.near(key);
  const chooseNow = (): void => {
    if (eye) massCells.choose(eye.x, eye.y, eye.z, eye.pxAtMetre, eye.orthoPx, forcedNear, eye.reach);
  };
  /** The shown buildings by coarse cell, as last put together (`update`): what a cell streamed in is made of. */
  let townCells = new Map<string, Building[]>();
  /** Frames each assembled cell has been far (`levelOfDetail`); let go at `RELEASE_FRAMES`. */
  const farSince = new Map<string, number>();
  /** The cell being streamed in: its buildings emitted, then its coarse and detail batches put together, a step a frame. */
  let streaming: {
    cell: string; queue: readonly Building[]; at: number; uploads: number;
    todo: { stage: CellCache; cell: string; list: BuildingChunk[]; kinds: ReadonlySet<PartKind> }[] | null;
    assembling: { stage: CellCache; cell: string; list: BuildingChunk[]; steps: Generator<void, BuildingMeshes, void> } | null;
    made: { stage: CellCache; cell: string; list: BuildingChunk[]; part: BuildingMeshes }[];
  } | null = null;
  /**
   * Each detail cell's centre (map x/y) and whether it is drawn by the far
   * versions of its parts (`cullDetails`): kept per batch, so the key is read
   * once, not every frame.
   */
  const detailState = new WeakMap<BuildingMeshes, { x: number; y: number; far: boolean; parent: string }>();
  /** The detail being applied by `applyDetail` (a closure made once, not a frame). */
  let lighterNow = false;
  const applyDetail = (o: Object3D): void => {
    const mesh = o as InstancedMesh;
    if (!mesh.isInstancedMesh) return;
    const kind = mesh.name.startsWith('building-') ? (mesh.name.slice(9) as PartKind) : null;
    const lighter = kind ? kit.far[kind] : undefined;
    if (!kind || !lighter) return;
    mesh.geometry = lighterNow ? lighter : kit.geometry[kind];
    if (kit.farShadows.has(kind)) mesh.castShadow = !shadowFar && kit.castsShadow.has(kind);
  };
  const applyFacadeDetail = (): void => {
    for (const batch of [stored, faded]) {
      lighterNow = far;
      batch?.group.traverse(applyDetail);
    }
    for (const cell of detailCells.values()) {
      lighterNow = far || (detailState.get(cell.part)?.far ?? false);
      cell.part.group.traverse(applyDetail);
    }
  };
  /** The buildings drawn cut open, by id and floor: only those near the camera, kept while they stay. */
  const cutChunks = new Map<string, { record: string; digest: string; chunk: BuildingChunk }>();
  /** An edit to one building must not resample the ground under every other building. */
  const groundDigests = new Map<BuildingId, { record: string; groundKey: string; digest: string }>();
  /** Whether a ground change since a key reached a building; without one, any new key did. */
  let touched: ((b: Building, sinceKey: string) => boolean) | undefined;
  const digestFor = (b: Building, record: string, groundKey: string, groundAt: GroundAt, pavedAt?: PavedAt): string => {
    const known = groundDigests.get(b.id);
    if (known && known.record === record && known.groundKey === groundKey) return known.digest;
    // The ground changed somewhere, not under this building: what it sampled stands.
    if (known && known.record === record && touched && !touched(b, known.groundKey)) {
      groundDigests.set(b.id, { ...known, groundKey });
      return known.digest;
    }
    const digest = groundDigest(b, groundAt, pavedAt);
    groundDigests.set(b.id, { record, groundKey, digest });
    return digest;
  };
  const cutChunkFor = (b: Building, level: number, groundAt: GroundAt, groundKey: string, pavedAt?: PavedAt,
    naturalAt: GroundAt = groundAt): BuildingChunk => {
    const dir = cutaway ? Math.round(Math.atan2(cutaway.view.y, cutaway.view.x) / (Math.PI / 4)) : 0;
    const id = `${b.id}|${level}|${dir}`;
    const record = recordText(b);
    const digest = digestFor(b, record, groundKey, groundAt, pavedAt);
    const known = cutChunks.get(id);
    if (known && known.record === record && known.digest === digest) return known.chunk;
    // The view snapped to eighths of a turn: the walls that come down change
    // only when the camera has really turned.
    const a = dir * (Math.PI / 4);
    // Opened, a signature building is drawn by the shared kit with its rooms and furniture.
    const { blueprint: _sig, ...plain } = cutOpen(b, level, { x: Math.cos(a), y: Math.sin(a) });
    const chunk = emitChunk(plain as Building, groundAt, pavedAt, naturalAt);
    cutChunks.set(id, { record, digest, chunk });
    return chunk;
  };
  const near = (b: Building): boolean => {
    if (!cutaway) return false;
    if (cutaway.only !== undefined) return b.id === cutaway.only;
    const box = buildingBounds(b);
    const dx = Math.max(box.minX - cutaway.x, 0, cutaway.x - box.maxX);
    const dy = Math.max(box.minY - cutaway.y, 0, cutaway.y - box.maxY);
    return Math.hypot(dx, dy) <= cutaway.radius;
  };
  /** `allowSlim`: a far building's slimmed chunk will do (its flags, its lots' ground, its signature floor). */
  const drawn = (b: Building, groundAt: GroundAt, groundKey: string, pavedAt?: PavedAt, naturalAt: GroundAt = groundAt, allowSlim = false): BuildingChunk =>
    cutaway && near(b) ? cutChunkFor(b, cutaway.level, groundAt, groundKey, pavedAt, naturalAt)
      : chunkFor(b, groundAt, groundKey, pavedAt, naturalAt, allowSlim);
  /**
   * Each building's emitted meshes, keyed by its record and by the ground
   * around it: an edit re-emits one building, a terrain dab only the ones
   * whose ground it moved; everything else is concatenated from here.
   */
  // The record and the ground digest compared apart: the record text is the
  // same string object while the record is (`recordText`), compared by
  // reference; joined into one key, every lookup copied it whole.
  const chunks = new Map<BuildingId, { record: string; digest: string; chunk: BuildingChunk; slim: boolean; bytes: number }>();
  /** Bytes of the full chunks held (`CHUNK_CACHE_BYTES`, `trimChunkCache`). */
  let fullBytes = 0;
  /** A chunk entry let go (replaced, slimmed, its building gone): its bytes out of the cache's count. */
  const forget = (known: { slim: boolean; bytes: number } | undefined): void => {
    if (known && !known.slim) fullBytes -= known.bytes;
  };
  /**
   * A far building keeps only what the whole town reads of it (flags, lots'
   * ground, signature floor); the arrays go, emitted again if its cell comes
   * near. Only past the cache budget (`trimChunkCache`), least recently near
   * first: slimmed at once, a return of the camera cost seconds of re-emission.
   */
  const slim = (id: BuildingId): void => {
    const known = chunks.get(id);
    if (!known || known.slim) return;
    forget(known);
    const { shells: _shells, parts: _parts, furniture: _furniture, ...kept } = known.chunk;
    chunks.set(id, { ...known, chunk: { ...kept, shells: {}, parts: EMPTY_PARTS }, slim: true, bytes: 0 });
  };
  /**
   * The far buildings not emitted yet: emitted in the frames' spare slices
   * (`streamCells`) while the cache has room, so a camera move finds them
   * made and their flags fly; the opening emits only the cells near (the
   * whole town emitted at the opening was most of its wait).
   */
  let backlog: Building[] = [];
  /** The buildings shown, as last put together (`update`): the flags are read from their chunks. */
  let lastShown: readonly Building[] = [];
  const flyFlags = (): void => {
    const flags = [];
    for (const b of lastShown) { const f = chunks.get(b.id)?.chunk.flags; if (f) flags.push(...f); }
    flagLayer.set(flags);
  };
  const cellSeen = new Map<string, number>(); // the frame each cell was last near: the cache's LRU order
  let frameNo = 0;
  /** Over the budget, the far cells' buildings are slimmed, least recently near first; the cells in detail are never. */
  const trimChunkCache = (): void => {
    if (fullBytes <= CHUNK_CACHE_BYTES) return;
    const far = [...townCells.keys()].filter((key) => !cells.has(key) && !cellNear(key));
    far.sort((a, b) => (cellSeen.get(a) ?? -1) - (cellSeen.get(b) ?? -1));
    for (const key of far) {
      for (const b of townCells.get(key) ?? []) slim(b.id);
      if (fullBytes <= CHUNK_CACHE_BYTES) return;
    }
  };
  /** Each building's mass from afar (`massing.ts`), kept as its chunk is: by its record and the ground under it. */
  const masses = new Map<BuildingId, { record: string; digest: string; mass: MassingChunk | null }>();
  const massFor = (b: Building, groundAt: GroundAt, groundKey: string, pavedAt?: PavedAt, naturalAt: GroundAt = groundAt): MassingChunk | null => {
    const record = recordText(b);
    const digest = digestFor(b, record, groundKey, groundAt, pavedAt);
    const known = masses.get(b.id);
    if (known && known.record === record && known.digest === digest) return known.mass;
    const mass = emitMassing(b, groundAt, pavedAt, naturalAt, drawsSignature(b), kit.finishTone);
    masses.set(b.id, { record, digest, mass });
    return mass;
  };
  const chunkFor = (b: Building, groundAt: GroundAt, groundKey: string, pavedAt?: PavedAt,
    naturalAt: GroundAt = groundAt, allowSlim = false): BuildingChunk => {
    const record = recordText(b);
    const digest = digestFor(b, record, groundKey, groundAt, pavedAt);
    const known = chunks.get(b.id);
    if (known && known.record === record && known.digest === digest && (allowSlim || !known.slim)) return known.chunk;
    const chunk = emitChunk(b, groundAt, pavedAt, naturalAt);
    forget(known);
    const bytes = chunkBytes(chunk);
    fullBytes += bytes;
    chunks.set(b.id, { record, digest, chunk, slim: false, bytes });
    return chunk;
  };
  /** The masses of these buildings by coarse cell, for `massCells.update`. */
  const massesByCell = (list: readonly Building[], groundAt: GroundAt, groundKey: string, pavedAt?: PavedAt,
    naturalAt: GroundAt = groundAt): Map<string, MassingChunk[]> =>
    groupByCell(list, cellOf, (b) => massFor(b, groundAt, groundKey, pavedAt, naturalAt));
  /** The cells held near whatever the eye says: the building cut open (`near`), the one being edited (`dimmed`). */
  const forcedCells = (shown: readonly Building[]): ReadonlySet<string> =>
    new Set(shown.filter((b) => (dimmed !== undefined && b.id === dimmed) || (cutaway !== null && near(b))).map(cellOf));
  /** A cell's detail let go: its batches and its detail cells' batches (its buildings' arrays stay for the cache). */
  const releaseCell = (key: string): void => {
    dropCell(cells, key, stored);
    for (const sub of detailKeysOf(key)) dropCell(detailCells, sub, details);
    farSince.delete(key);
  };
  /**
   * One frame's share of the HLOD streaming: cells far for `RELEASE_FRAMES`
   * let their detail go; the nearest cell drawn near with no detail yet has its
   * buildings emitted and its batches put together a few milliseconds a frame,
   * sent to the GPU (`warmLooseAhead`) and only then shown, whole. True when a
   * cell came in or went out.
   */
  const streamCells = (groundAt: GroundAt, groundKey: string, pavedAt: PavedAt | undefined, naturalAt: GroundAt): boolean => {
    let changed = false;
    if (eye && !streaming) {
      for (const [key, frames] of farSince) {
        if (frames < RELEASE_FRAMES) continue;
        releaseCell(key);
        changed = true;
      }
      if (changed) trimChunkCache();
      let best: string | null = null, bestDistance = Infinity;
      for (const key of townCells.keys()) {
        if (cells.has(key) || !cellNear(key)) continue;
        const comma = key.indexOf(',');
        const cx = (Number(key.slice(0, comma)) + 0.5) * BATCH_CELL, cy = (Number(key.slice(comma + 1)) + 0.5) * BATCH_CELL;
        const distance = Math.hypot(cx - eye.x, cy - eye.y);
        if (distance < bestDistance) { bestDistance = distance; best = key; }
      }
      if (best !== null) streaming = { cell: best, queue: townCells.get(best)!, at: 0, uploads: 0, todo: null, assembling: null, made: [] };
    }
    const job = streaming;
    if (!job) {
      // Nothing to stream: the far buildings not made yet, while the cache has room.
      if (backlog.length === 0) return changed;
      const until = workUntil(WARM_SLICE_MS);
      if (!until) return changed;
      let made = 0;
      while (backlog.length && performance.now() < until) {
        const b = backlog.pop()!;
        // Emitted for what the town reads of it (flags, lot ground), slimmed at
        // once: a far building's arrays never sit in the heap. Kept whole, the
        // town's far buildings filled the heap to its limit (4.4-5.1 GB,
        // 2026-10-14) and the collector stalled every frame.
        if (!chunks.has(b.id)) { drawn(b, groundAt, groundKey, pavedAt, naturalAt, true); slim(b.id); made++; }
      }
      if (made && (backlog.length === 0 || (backlog.length & 63) === 0)) flyFlags();
      return changed;
    }
    const until = workUntil(WARM_SLICE_MS);
    if (!until) return changed;
    while (job.at < job.queue.length && performance.now() < until) drawn(job.queue[job.at++]!, groundAt, groundKey, pavedAt, naturalAt);
    if (job.at < job.queue.length) return changed;
    if (!job.todo) {
      const chunkOf = (b: Building): BuildingChunk => drawn(b, groundAt, groundKey, pavedAt, naturalAt);
      job.todo = [];
      for (const [stage, size, kinds] of [[cells, BATCH_CELL, COARSE_PARTS], [detailCells, DETAIL_CELL, DETAIL_PARTS]] as const) {
        for (const [cell, list] of chunksByCell(job.queue, chunkOf, size)) job.todo.push({ stage, cell, list, kinds });
      }
    }
    while ((job.todo.length || job.assembling) && performance.now() < until) {
      if (!job.assembling) {
        const next = job.todo.shift()!;
        job.assembling = { ...next, steps: assembleBuildingMeshesSteps(next.list, kit, false, false,
          { parts: next.kinds, shells: next.kinds === COARSE_PARTS, furniture: next.kinds === COARSE_PARTS }) };
      }
      const step = job.assembling.steps.next();
      if (!step.done) continue;
      job.made.push({ stage: job.assembling.stage, cell: job.assembling.cell, list: job.assembling.list, part: step.value });
      job.assembling = null;
      const meshes: Mesh[] = [];
      step.value.group.traverse((o) => { if ((o as Mesh).isMesh) meshes.push(o as Mesh); });
      const sent = warmLooseAhead(meshes);
      if (sent) { job.uploads++; void sent.then(() => { job.uploads--; }); }
    }
    if (job.todo.length || job.assembling || job.uploads > 0) return changed;
    // Into the scene whole: the coarse batch under the cells' group, the detail batches under theirs.
    for (const made of job.made) {
      made.stage.get(made.cell)?.part.dispose();
      made.stage.set(made.cell, { chunks: made.list, part: made.part });
      if (made.stage === cells) {
        stored?.group.add(made.part.group);
        lighterNow = far;
        made.part.group.traverse(applyDetail);
        made.part.setVisible(cellNear(made.cell));
      } else details?.group.add(made.part.group);
    }
    streaming = null;
    return true;
  };
  /** Where the buildings stand, for the scenery's plant cull (`covers`, `coversVersion`). */
  const cover = createCoverIndex();

  return {
    group,
    get triangles() {
      return (stored?.triangles ?? 0) + (details?.triangles ?? 0) + (ghost?.triangles ?? 0);
    },
    get version() {
      return version;
    },
    get pending() {
      return warming !== null;
    },
    hidden: false,
    kit,
    chunkOf(b) {
      if (!lastGround) return null;
      const { groundAt, groundKey, pavedAt, naturalAt } = lastGround;
      return { chunk: chunkFor(b, groundAt, groundKey, pavedAt, naturalAt), kit };
    },
    update(doc, groundAt, groundKey, pavedAt, naturalAt = groundAt, groundTouched) {
      lastGround = { groundAt, groundKey, pavedAt, naturalAt };
      touched = groundTouched;
      const hides = preview?.hides ?? null;
      const dimKey = dimmed === undefined ? 'off' : String(dimmed ?? 'all');
      const cutKey = cutaway
        ? `${cutaway.only ?? ''}:${cutaway.level}@${Math.round(cutaway.x)},${Math.round(cutaway.y)}/${Math.round(Math.atan2(cutaway.view.y, cutaway.view.x) / (Math.PI / 4))}`
        : 'whole';
      const key = `${doc.buildings.revision}|${groundKey}|${hides}|${dimKey}|${cutKey}|${[...ruined].join(',')}`;
      let rebuilt = false;
      // The buildings an edit changed (or whose ground it moved) are emitted a
      // few milliseconds a frame first, the town as it was staying drawn; the
      // cells are put together once every one is ready - a copy of what is
      // made. Emitted in the frame of the edit, they and the cells were a
      // stall of 100-500 ms when a road took buildings away or reshaped the
      // ground beside them (docs/performance.md #16).
      // The first town too (the opening, a map loaded): built in one frame it
      // was the longest task of the opening.
      // A building cut open or the others faded takes the same road (its cells
      // are held near, `forcedCells`): put together whole in the frame, the
      // town's every cell was emitted and assembled at once for it.
      if (key !== storedKey) {
        if (!warming || warming.key !== key) {
          const queue = [...doc.buildings.all()].filter((b) => b.id !== hides && !ruined.has(b.id));
          // A town none of whose buildings is made yet - the opening, a map opened - is a load, not an edit of
          // a running game: it takes the loading budget (Unity's backgroundLoadingPriority High, 50 ms a frame)
          // instead of the 6 ms an edit may take. At 6 ms a frame the 761 buildings of the default town came
          // 10-20 s after its roads. Made = has its mass; NOT its chunk, which a far one never keeps (every
          // edit was a load: AUDITORIA A2).
          const unmade = stored === null ? queue.length : queue.reduce((n, b) => n + (masses.has(b.id) ? 0 : 1), 0);
          warming = { key, queue, at: 0, loading: unmade > LOADING_COUNT, massed: false };
          // A change overtakes the cell being streamed in: made again from the new records; what it made is on the GPU, in no scene (AUDITORIA A7).
          for (const made of streaming?.made ?? []) made.part.dispose();
          streaming = null;
          forcedNear = forcedCells(queue);
        }
        // A load's time is its own (Unity: the most loading may take in a frame), not what the frame's other work
        // left: shared, it got nothing while the traffic's topology took every frame's allowance, and the town
        // stood without buildings for over 20 s.
        const until = warming.loading ? performance.now() + (this.hidden ? HIDDEN_SLICE_MS : LOADING_SLICE_MS) : workUntil(WARM_SLICE_MS);
        if (!until) return false;
        while (warming.at < warming.queue.length && performance.now() < until) {
          const b = warming.queue[warming.at++]!;
          if (!warming.massed) { massFor(b, groundAt, groundKey, pavedAt, naturalAt); continue; }
          // The detail of the cells near; the far buildings wait in the
          // backlog, emitted in the spare slices after the swap.
          if (cellNear(cellOf(b))) drawn(b, groundAt, groundKey, pavedAt, naturalAt);
        }
        if (warming.at < warming.queue.length) return false;
        if (!warming.massed) {
          // The far level first, so the eye can say which cells need their detail.
          massCells.update(massesByCell(warming.queue, groundAt, groundKey, pavedAt, naturalAt));
          chooseNow();
          townCells = groupByCell(warming.queue, cellOf, (b) => b); // the masses show at once (`holdMass`)
          warming.massed = true;
          warming.at = 0;
          return false;
        }
        // Then the cells whose buildings changed, a cell at a time.
        if (!warming.cells) {
          const chunkOf = (b: Building): BuildingChunk => drawn(b, groundAt, groundKey, pavedAt, naturalAt);
          const nearQueue = warming.queue.filter((b) => cellNear(cellOf(b)));
          warming.cells = [];
          for (const [cache, size, kinds, stage] of [[cells, BATCH_CELL, COARSE_PARTS, stagedCells], [detailCells, DETAIL_CELL, DETAIL_PARTS, stagedDetails]] as const) {
            for (const [cell, list] of chunksByCell(nearQueue, chunkOf, size)) {
              const known = cache.get(cell);
              if (!known || !sameChunks(known.chunks, list)) warming.cells.push({ stage, cell, list, kinds });
            }
          }
        }
        while ((warming.cells.length || warming.assembling) && performance.now() < until) {
          if (!warming.assembling) {
            const next = warming.cells.shift()!;
            const old = next.stage.get(next.cell);
            if (old && sameChunks(old.chunks, next.list)) continue;
            warming.assembling = { ...next, steps: assembleBuildingMeshesSteps(next.list, kit, false, false,
              { parts: next.kinds, shells: next.kinds === COARSE_PARTS, furniture: next.kinds === COARSE_PARTS }) };
          }
          const job = warming.assembling;
          const step = job.steps.next();
          if (!step.done) continue;
          job.stage.get(job.cell)?.part.dispose();
          job.stage.set(job.cell, { chunks: job.list, part: step.value });
          warming.assembling = null;
          // An edit's cell goes to the GPU a mesh a frame before the swap
          // (`warmLooseAhead`); a load's is sent by the frame drawn unseen.
          if (!warming.loading) {
            const meshes: Mesh[] = [];
            step.value.group.traverse((o) => { if ((o as Mesh).isMesh) meshes.push(o as Mesh); });
            const w = warming;
            const sent = warmLooseAhead(meshes);
            if (sent) {
              w.uploads = (w.uploads ?? 0) + 1;
              void sent.then(() => { w.uploads = (w.uploads ?? 1) - 1; });
            }
          }
        }
        if (warming.cells.length || warming.assembling || (warming.uploads ?? 0) > 0) return false;
      }
      warming = null;
      if (key !== storedKey) {
        storedKey = key;
        for (const batch of [stored, details, faded]) {
          if (!batch) continue;
          group.remove(batch.group);
          batch.dispose();
        }
        const shown = [...doc.buildings.all()].filter((b) => b.id !== hides && !ruined.has(b.id));
        for (const [id, known] of chunks) if (!doc.buildings.has(id)) {
          forget(known);
          chunks.delete(id);
          groundDigests.delete(id);
        }
        for (const id of masses.keys()) if (!doc.buildings.has(id)) masses.delete(id);
        const solid = dimmed === undefined ? shown : shown.filter((b) => b.id === dimmed);
        const others = dimmed === undefined ? [] : shown.filter((b) => b.id !== dimmed);
        if (cutChunks.size > 64) cutChunks.clear();
        // Only the cells drawn near have their detail; the rest stand as their
        // masses (`massCells`) and come in by `streamCells` when the eye nears.
        const nearSolid = solid.filter((b) => cellNear(cellOf(b)));
        stored = assembleByCell(nearSolid, (b) => drawn(b, groundAt, groundKey, pavedAt, naturalAt), kit, cells, BATCH_CELL, COARSE_PARTS, stagedCells);
        details = assembleByCell(nearSolid, (b) => drawn(b, groundAt, groundKey, pavedAt, naturalAt), kit, detailCells, DETAIL_CELL, DETAIL_PARTS, stagedDetails);
        // Staged for a change overtaken by another: not used.
        for (const stage of [stagedCells, stagedDetails]) {
          for (const { part } of stage.values()) part.dispose();
          stage.clear();
        }
        group.add(stored.group, details.group);
        // The far level of every cell, from the masses of its buildings.
        massCells.update(massesByCell(shown, groundAt, groundKey, pavedAt, naturalAt));
        townCells = new Map();
        for (const b of solid) {
          const cell = cellOf(b);
          const list = townCells.get(cell);
          if (list) list.push(b);
          else townCells.set(cell, [b]);
        }
        farSince.clear();
        trimChunkCache();
        const nearOthers = others.filter((b) => cellNear(cellOf(b)));
        faded = nearOthers.length > 0
          ? assembleBuildingMeshes(nearOthers.map((b) => drawn(b, groundAt, groundKey, pavedAt, naturalAt)), kit, false, true)
          : null;
        if (faded) {
          faded.group.renderOrder = 1;
          group.add(faded.group);
        }
        // Signature buildings: their bodies, drawn with parts of their own (`signature.ts`).
        const keep = new Set<BuildingId>();
        for (const b of solid) {
          const floor = chunks.get(b.id)?.chunk.signatureFloor ?? signatureFloorOf(b, naturalAt, pavedAt);
          if (floor === undefined) continue;
          keep.add(b.id);
          const sigKey = `${JSON.stringify(b)}|${floor}`;
          const known = signatures.get(b.id);
          if (known?.key === sigKey) continue;
          if (known) { signatureRoot.remove(known.group); disposeSignature(known.group); }
          const built = buildSignature(b, floor);
          if (built) { signatureRoot.add(built); signatures.set(b.id, { key: sigKey, group: built }); } else signatures.delete(b.id);
        }
        for (const [id, known] of signatures) {
          if (keep.has(id)) continue;
          signatureRoot.remove(known.group);
          disposeSignature(known.group);
          signatures.delete(id);
        }
        cover.index(doc.buildings.all());
        lastShown = shown;
        // Far buildings flying a flag only (all: ~7 ms a frame for 40 s, 2026-10-14).
        backlog = shown.filter((b) => !chunks.has(b.id) && fliesFlag(b));
        flyFlags();
        applyFacadeDetail();
        version++;
        rebuilt = true;
      }
      // The cells the eye neared since, in; those long far, out (HLOD streaming).
      if (!warming && stored && details) {
        for (let landed = 0; landed < STREAM_CELLS_PER_FRAME && streamCells(groundAt, groundKey, pavedAt, naturalAt); landed++) {
          version++;
          rebuilt = true;
        }
      }
      const wanted = preview ? `${preview.serial}|${groundKey}` : '';
      if (wanted !== ghostKey) {
        ghostKey = wanted;
        if (ghost) {
          group.remove(ghost.group);
          ghost.dispose();
          ghost = null;
        }
        if (preview) {
          if (!preview.solid) kit.setGhostValid(preview.valid);
          // A signature building being edited shows its floors and rooms in the shared kit (the floor ghost).
          const { blueprint: _sig, ...edited } = preview.building;
          ghost = buildBuildingMeshes([edited as Building], groundAt, kit, !preview.solid, pavedAt, naturalAt);
          ghost.group.renderOrder = 2;
          group.add(ghost.group);
        }
      }
      return rebuilt;
    },
    setRuined(ids) {
      ruined = new Set(ids);
    },
    setDimmed(except) {
      dimmed = except;
    },
    setPreview(next) {
      preview = next;
    },
    setNight(dark, hour) {
      kit.setNight(dark, hour);
    },
    setFar(next) {
      if (next === far) return;
      far = next;
      applyFacadeDetail();
    },
    levelOfDetail(eyeX, eyeY, eyeZ, pxAtMetre, orthoPx, reach = Infinity) {
      eyeNow.x = eyeX; eyeNow.y = eyeY; eyeNow.z = eyeZ; eyeNow.pxAtMetre = pxAtMetre; eyeNow.orthoPx = orthoPx; eyeNow.reach = reach;
      eye = eyeNow;
      // The building cut open and the one being edited stay in detail whatever the eye says.
      massCells.choose(eyeX, eyeY, eyeZ, pxAtMetre, orthoPx, forcedNear, reach);
      frameNo++;
      for (const key of townCells.keys()) {
        const isNear = cellNear(key);
        // A cell near with no detail yet (coming by `streamCells`) keeps its mass until the detail lands.
        massCells.holdMass(key, isNear && !cells.has(key));
        if (isNear) cellSeen.set(key, frameNo);
      }
      for (const [key, cell] of cells) {
        const isNear = cellNear(key);
        cell.part.setVisible(isNear);
        // How long a cell has been far: its detail is let go at `RELEASE_FRAMES` (`streamCells`).
        if (isNear) farSince.delete(key);
        else farSince.set(key, (farSince.get(key) ?? 0) + 1);
      }
    },
    cullDetails(eyeX, eyeY, eyeZ, pxAtMetre, orthoPx) {
      for (const [key, cell] of detailCells) {
        let state = detailState.get(cell.part);
        // A cell new since the last frame is put to its detail whatever it is.
        const fresh = !state;
        if (!state) {
          const comma = key.indexOf(',');
          const i = Number(key.slice(0, comma)), j = Number(key.slice(comma + 1));
          // Its cell of the coarse grid (two of these a side), read once.
          const parent = `${Math.floor((i * DETAIL_CELL) / BATCH_CELL)},${Math.floor((j * DETAIL_CELL) / BATCH_CELL)}`;
          state = { x: (i + 0.5) * DETAIL_CELL, y: (j + 0.5) * DETAIL_CELL, far: false, parent };
          detailState.set(cell.part, state);
        }
        const cx = state.x - eyeX, cy = state.y - eyeY;
        // Drawn while its coarse cell is drawn in detail: the far level takes
        // over by the error on the screen (\`massCells.ts\`). A fixed reach of
        // 500 m from the eye, its height counted, took every frame, railing and
        // shutter off the town in any overview - windows as dark holes, the
        // detail only with the camera at the wall (the player, 2026-10-13).
        cell.part.group.visible = massCells.near(state.parent);
        // Its frames and railings whole while a frame's side spans
        // \`FULL_DETAIL_PIXELS\` or more, by their street faces (\`kit.far\`)
        // beyond - the projected size, as the far level is chosen, and back
        // nearer by \`DETAIL_HYSTERESIS\` (three's \`LOD.update\`).
        const nx = Math.max(Math.abs(cx) - DETAIL_CELL / 2, 0), ny = Math.max(Math.abs(cy) - DETAIL_CELL / 2, 0);
        const near = Math.max(Math.hypot(nx, ny, eyeZ), 1);
        const pixels = orthoPx !== null ? FRAME_SIDE * orthoPx : (FRAME_SIDE * pxAtMetre) / near;
        const nextFar = pixels < FULL_DETAIL_PIXELS * (state.far ? 1 : 1 - DETAIL_HYSTERESIS);
        if (fresh || nextFar !== state.far) {
          state.far = nextFar;
          lighterNow = far || nextFar;
          cell.part.group.traverse(applyDetail);
        }
      }
    },
    setShadowFar(next) {
      if (next === shadowFar) return;
      shadowFar = next;
      applyFacadeDetail();
    },
    setCutaway(next) {
      cutaway = next;
    },
    get coversVersion() {
      return cover.version;
    },
    covers(x, y) {
      return cover.covers(x, y);
    },
    lotHeightAt(building, x, y) {
      return chunks.get(building)?.chunk.lotGround?.heightAt(x, y) ?? NaN;
    },
    anyLotHeightAt(x, y) {
      for (const { chunk } of chunks.values()) {
        const h = chunk.lotGround?.heightAt(x, y);
        if (h !== undefined && Number.isFinite(h)) return h;
      }
      return NaN;
    },
    dispose() {
      flagLayer.dispose();
      massCells.dispose();
      stored?.dispose();
      details?.dispose();
      faded?.dispose();
      for (const cell of cells.values()) cell.part.dispose();
      cells.clear();
      for (const cell of detailCells.values()) cell.part.dispose();
      detailCells.clear();
      groundDigests.clear();
      ghost?.dispose();
      kit.dispose();
      group.clear();
    },
  };
}

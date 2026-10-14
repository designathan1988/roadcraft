import { workUntil } from '@core/frameWork';
import { Group, type InstancedMesh, type Object3D } from 'three';

import type { RoadDoc } from '@world/doc';
import type { GroundAt, PavedAt } from '@world/buildings/foundation';
import { buildingBounds } from '@world/buildings/geometry';
import type { Building, BuildingId } from '@world/buildings/types';
import { cutOpen } from '@world/buildings/interior';
import { CellFiling } from '@world/cells';
import { type BuildingChunk, type BuildingMeshes, type LotGround, buildBuildingMeshes, emitChunk, fliesFlag, kitBoxes, lotGroundAgain, signatureFloorOf } from './buildingMesh';
import {
  BATCH_CELL, CHUNK_CACHE_BYTES, type CellCache, type DetailState, cullDetailCells,
  HIDDEN_SLICE_MS, LOADING_COUNT, LOADING_SLICE_MS, RELEASE_FRAMES, STREAM_AHEAD, STREAM_CELLS_PER_FRAME, WARM_SLICE_MS, cellGroup, createCoverIndex, detailKeysOf, dropCell, groundDigest, groupByCell,
} from './layerCells';
import { type FlagInstance, createFlagLayer } from './flagLayer';
import { drawsSignature } from './signature';
import { TownIndex, patchCell, signatureBodies } from './townIndex';
import { emitMassing, type MassingChunk } from './massing';
import { createMassCells } from './massCells';
import { type BuildingKit, type PartKind, createBuildingKit } from './kit';
import { type CellEnv, CellPool } from './cellPool';
import { CellRequests, sameEntries } from './cellRequests';
import type { CellEntry, ChunkSummary } from './cellWork';

/**
 * The buildings layer: the stored buildings and the editor's preview, each rebuilt only when what it
 * depends on moves (CLAUDE.md (Execution flow)). The stored buildings depend on their changes in the
 * diary (`townIndex.ts`), on the ground (`groundKey`, `render/groundChanges.ts`) and on which one the
 * preview stands in for; a building samples its ground again only when `groundTouched` says a change
 * reached it. The preview depends on its own serial.
 *
 * HLOD WITH STREAMING: a cell's detail (`BATCH_CELL`) exists only while the cell is drawn near by the
 * error on the screen (`massCells.ts`); far, only its masses stand. A cell coming near is asked of the
 * cell workers (`cellRequests.ts`), sent to the GPU when it lands and only then shown, whole; far for
 * `RELEASE_FRAMES` its meshes go, its chunks as the workers' cache allows. Unreal's World Partition HLOD,
 * 3D Tiles' REPLACE refinement. DO NOT put the detail of every cell together again.
 *
 * THE CELLS ARE MADE IN WORKERS (`cellWork.ts`): the page sends each building's record and ground and gets
 * the cell's batches back as arrays. DO NOT emit or join buildings here: it was most of a big city's lost
 * frames (11.6 of 114 s in the 2,560 m city, frames of up to 1.4 s, 2026-10-14). A building asked for at
 * once (`chunkOf`, a ruin) and the preview are the only ones emitted on the page.
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
  /** A change is still being made (`update` keeps the town as it was until it is done). */
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
  /** A WebGL context restored (`mesh/gpuOnly.ts`): every cell made again, its arrays having been let go. */
  refill(): void;
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

/** What the page keeps of a building emitted in a worker: by the record and ground it was made for. */
interface Kept { readonly record: string; readonly digest: string; readonly b: Building; readonly summary: ChunkSummary; readonly pavedAt?: PavedAt; lot?: LotGround | null }

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
  const signatures = signatureBodies(signatureRoot, recordText);
  group.matrixAutoUpdate = false;
  group.updateMatrix();
  let stored: BuildingMeshes | null = null;
  let ruined: ReadonlySet<number> = new Set();
  let lastGround: { groundAt: GroundAt; groundKey: string; pavedAt: PavedAt | undefined; naturalAt: GroundAt } | null = null;
  /** Each cell's batch as shown, and the buildings it was made of. */
  const cells: CellCache = new Map();
  const detailCells: CellCache = new Map();
  /** The buildings faded ("hide the others"), a batch a cell. */
  const fadedCells: CellCache = new Map();
  let details: BuildingMeshes | null = null;
  let faded: BuildingMeshes | null = null;
  let dimmed: BuildingId | null | undefined = undefined;
  let ghost: BuildingMeshes | null = null;
  let storedKey = '';
  /** A change being made, the town as it was staying drawn: its masses a slice a frame, then its cells from the workers. */
  let warming: { key: string; queue: Building[]; at: number;
    /** A whole town to put together (the opening, a map opened): worked at the loading priority. */
    loading: boolean;
    /** The masses of the queue are made and the far level chosen: the detail of the near cells comes next. */
    massed: boolean;
    /** A change of some buildings only (`townIndex.ts`): the cells it touched and the buildings, by id. */
    dirty?: Set<string>; ids?: Set<BuildingId> } | null = null;
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
  /** The shown town by cell, kept between changes, as of the diary's `townSeen` in `townDoc`; `storedRest`: the key but the buildings. */
  const town = new TownIndex(cellOf);
  let townSeen = -1, townDoc: RoadDoc | null = null, storedRest = '';
  /** Cells held near whatever the eye says: the building cut open, the one being edited. */
  let forcedNear: ReadonlySet<string> = new Set();
  const cellNear = (key: string): boolean => eye === null || forcedNear.has(key) || massCells.near(key);
  const chooseNow = (): void => {
    if (eye) massCells.choose(eye.x, eye.y, eye.z, eye.pxAtMetre, eye.orthoPx, forcedNear, eye.reach);
  };
  /** The shown buildings by coarse cell, as last put together (`update`): what a cell streamed in is made of. */
  let townCells = new Map<string, Building[]>();
  /** The buildings faded ("hide the others") by coarse cell. */
  let othersByCell = new Map<string, Building[]>();
  /** The cells whose batches must be made for the town as it is now, shown as they land (`landCells`). */
  const pendingCells = new Set<string>();
  /** Frames each assembled cell has been far (`levelOfDetail`); let go at `RELEASE_FRAMES`. */
  const farSince = new Map<string, number>();
  /**
   * Each detail cell's centre (map x/y) and whether it is drawn by the far
   * versions of its parts (`cullDetails`): kept per batch, so the key is read
   * once, not every frame.
   */
  const detailState = new WeakMap<BuildingMeshes, DetailState>();
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
  const near = (b: Building): boolean => {
    if (!cutaway) return false;
    if (cutaway.only !== undefined) return b.id === cutaway.only;
    const box = buildingBounds(b);
    const dx = Math.max(box.minX - cutaway.x, 0, cutaway.x - box.maxX);
    const dy = Math.max(box.minY - cutaway.y, 0, cutaway.y - box.maxY);
    return Math.hypot(dx, dy) <= cutaway.radius;
  };
  /** The buildings drawn cut open, by id, floor and side: the record cut open as text, kept while the record is. */
  const cutTexts = new Map<string, { record: string; text: string }>();
  /** Each building as last sent to the workers, by its entry's key: what a summary that comes back is of. */
  const sent = new Map<string, Building>();
  /**
   * A building as the workers are sent it: its key, its record as text and the
   * ground under it. One cut open sends its record cut open, under a key of its
   * own (by floor and the side the camera looks from, snapped to eighths of a
   * turn: the walls that come down change only when the camera has really turned).
   */
  const entryFor = (b: Building, groundAt: GroundAt, groundKey: string, pavedAt?: PavedAt): CellEntry => {
    const record = recordText(b);
    const digest = digestFor(b, record, groundKey, groundAt, pavedAt);
    if (!(cutaway && near(b))) { sent.set(String(b.id), b); return { key: String(b.id), record, digest }; }
    const dir = Math.round(Math.atan2(cutaway.view.y, cutaway.view.x) / (Math.PI / 4));
    const key = `${b.id}|${cutaway.level}|${dir}`;
    return { key, record: cutTextOf(b, record, key, cutaway.level, dir), digest };
  };
  /** @rebuild A building's record cut open, as text: worked out once per record, floor and side. */
  const cutTextOf = (b: Building, record: string, key: string, level: number, dir: number): string => {
    const cut = cutTexts.get(key);
    if (cut && cut.record === record) return cut.text;
    const a = dir * (Math.PI / 4);
    // Opened, a signature building is drawn by the shared kit with its rooms and furniture.
    const { blueprint: _sig, ...plain } = cutOpen(b, level, { x: Math.cos(a), y: Math.sin(a) });
    const text = JSON.stringify(plain);
    cutTexts.set(key, { record, text });
    return text;
  };
  const entriesOf = (list: readonly Building[], groundAt: GroundAt, groundKey: string, pavedAt?: PavedAt): CellEntry[] =>
    list.map((b) => entryFor(b, groundAt, groundKey, pavedAt));
  /**
   * What the page keeps of each building the workers emitted (flags, how its
   * lots' ground is made, its signature floor), by id, for the record and
   * ground it was made for; its lots' ground made again when first read.
   */
  const kept = new Map<BuildingId, Kept>();
  /**
   * The kept buildings that have lots or bays, filed by their bounds in the world's cells
   * (`world/cells.ts`): what a walker stands on is asked of the buildings round it. DO NOT walk
   * `kept` for a point: `anyLotHeightAt` is asked for every walker every frame, and every building
   * of the town was walked for each (O(walkers x buildings) a frame).
   */
  const lotFiling = new CellFiling<BuildingId, Kept>();
  const putKept = (id: BuildingId, k: Kept): void => {
    kept.set(id, k);
    flagsFor(id);
    if (!k.summary.lot) { lotFiling.remove(id); return; }
    const box = buildingBounds(k.b);
    lotFiling.file(id, k, [box.minX, box.minY, box.maxX, box.maxY]);
  };
  const dropKept = (id: BuildingId): void => {
    kept.delete(id);
    flagsFor(id);
    lotFiling.remove(id);
  };
  let flagsMoved = false;
  /**
   * The flags of the shown buildings, by id, kept as what is kept of them and what is shown changes
   * (`flagsFor`): the flag layer is given these. DO NOT walk every shown building for its flags at
   * each summary that lands: the town was walked once a landing while it streamed in.
   */
  const flagsOf = new Map<BuildingId, readonly FlagInstance[]>();
  const flagsFor = (id: BuildingId): void => {
    const flags = lastShown.has(id) ? kept.get(id)?.summary.flags : undefined;
    if (flags === flagsOf.get(id)) return;
    if (flags) flagsOf.set(id, flags); else flagsOf.delete(id);
    flagsMoved = true;
  };
  const keep = (summaries: readonly ChunkSummary[], entries: readonly CellEntry[], env: CellEnv): void => {
    const byKey = new Map(entries.map((e) => [e.key, e]));
    for (const s of summaries) {
      const b = sent.get(s.key);
      const entry = byKey.get(s.key);
      // A building cut open: its flags and lots are those of the whole one.
      if (!b || !entry || s.key.includes('|')) continue;
      putKept(b.id, { record: entry.record, digest: entry.digest, b, summary: s, ...(env.pavedAt ? { pavedAt: env.pavedAt } : {}) });
    }
  };
  const keptFor = (b: Building): Kept | undefined => {
    const k = kept.get(b.id);
    return k && k.record === recordText(b) ? k : undefined;
  };
  const pool = new CellPool(() => kitBoxes(kit), CHUNK_CACHE_BYTES);
  pool.warm();
  const requests = new CellRequests(pool, kit, keep);
  /**
   * The far buildings flying a flag not emitted yet: their summaries asked of
   * the workers in the frames' spare slices (`landCells`), so a camera move
   * finds their flags flying; the opening asks only the cells near.
   */
  let backlog: Building[] = [];
  /** The buildings shown, as last put together (`update`): the flags are read from what is kept of them. */
  const lastShown = new Map<BuildingId, Building>();
  const flyFlags = (): void => {
    const flags: FlagInstance[] = [];
    for (const list of flagsOf.values()) flags.push(...list);
    flagLayer.set(flags);
    flagsMoved = false;
  };
  /** Each building's mass from afar (`massing.ts`), kept by its record and the ground under it. */
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
  /** The masses of these buildings by coarse cell, for `massCells.update`. */
  const massesByCell = (list: readonly Building[], groundAt: GroundAt, groundKey: string, pavedAt?: PavedAt,
    naturalAt: GroundAt = groundAt): Map<string, MassingChunk[]> =>
    groupByCell(list, cellOf, (b) => massFor(b, groundAt, groundKey, pavedAt, naturalAt));
  /** The cells held near whatever the eye says: the building cut open (`near`), the one being edited (`dimmed`). */
  const forcedCells = (shown: readonly Building[]): ReadonlySet<string> =>
    new Set(shown.filter((b) => (dimmed !== undefined && b.id === dimmed) || (cutaway !== null && near(b))).map(cellOf));
  /** A cell's detail let go: its batches and its detail cells', its buildings' chunks left to the workers' cache. */
  const releaseCell = (key: string): void => {
    dropCell(cells, key, stored);
    for (const sub of detailKeysOf(key)) dropCell(detailCells, sub, details);
    farSince.delete(key);
    requests.release(key);
  };
  /** Where the batches are shown, for `patchCell`. */
  const shownAt = () => ({ cells, details: detailCells, stored: stored!, detailed: details! });
  /** A cell landed shown: its coarse batch at the detail the eye has, its detail cells under theirs. */
  const show = (key: string, landed: Parameters<typeof patchCell>[1]): void => {
    patchCell(key, landed, shownAt());
    const part = cells.get(key)?.part;
    if (!part) return;
    lighterNow = far;
    part.group.traverse(applyDetail);
    part.setVisible(cellNear(key));
  };
  /**
   * One frame's share of the cells: those far for `RELEASE_FRAMES` let their
   * detail go; those drawn near with no detail become pending (HLOD
   * streaming); the pending ones are asked of the workers nearest first, a few
   * at once (a far one asked first would keep a near one waiting behind it in
   * its worker), and each is shown whole, once on the GPU, as it lands - its old
   * batch, or its masses, shown till then. A pending cell drawn far gives up its
   * request. True when a cell came in or went out.
   */
  const landCells = (env: CellEnv, groundAt: GroundAt, groundKey: string, pavedAt: PavedAt | undefined): boolean => {
    let changed = false;
    if (eye) {
      for (const [key, frames] of farSince) {
        if (frames < RELEASE_FRAMES) continue;
        releaseCell(key);
        changed = true;
      }
      for (const key of townCells.keys()) if (!cells.has(key) && cellNear(key)) pendingCells.add(key);
    }
    const order = [...pendingCells];
    if (eye) {
      const at = eye;
      const away = (key: string): number => {
        const comma = key.indexOf(',');
        return Math.hypot((Number(key.slice(0, comma)) + 0.5) * BATCH_CELL - at.x, (Number(key.slice(comma + 1)) + 0.5) * BATCH_CELL - at.y);
      };
      order.sort((a, b) => away(a) - away(b));
    }
    let landed = 0;
    for (const cell of order) {
      if (!cellNear(cell)) {
        patchCell(cell, null, shownAt());
        dropCell(fadedCells, cell, faded);
        requests.drop('cell', cell);
        requests.drop('faded', cell);
        pendingCells.delete(cell);
        changed = true;
        continue;
      }
      let done = true;
      for (const [kind, list, cache] of [['cell', townCells.get(cell) ?? [], cells], ['faded', othersByCell.get(cell) ?? [], fadedCells]] as const) {
        // A cell whose shown batch is what the town is now (or that has no buildings left) wants nothing
        // asked: a request still out for another state of it is dropped. DO NOT leave it: it landed and was
        // never taken, its meshes sent to the GPU and kept until the cell was asked again (`cellRequests.ts`).
        if (list.length === 0) {
          requests.drop(kind, cell);
          if (!cache.has(cell)) continue;
          if (kind === 'cell') patchCell(cell, null, shownAt()); else dropCell(cache, cell, faded);
          changed = true;
          continue;
        }
        const entries = entriesOf(list, groundAt, groundKey, pavedAt);
        const known = cache.get(cell);
        if (known && sameEntries(known.entries, entries)) { requests.drop(kind, cell); continue; }
        done = false;
        if (!requests.isAsked(kind, cell) && requests.asking >= STREAM_AHEAD) continue;
        const got = requests.want(kind, cell, entries, env, true);
        if (!got || landed >= STREAM_CELLS_PER_FRAME) continue;
        requests.take(kind, cell);
        if (kind === 'cell') show(cell, got);
        else {
          dropCell(cache, cell, faded);
          if (got.batch) { cache.set(cell, { entries, part: got.batch }); faded?.group.add(got.batch.group); }
        }
        landed++;
        changed = true;
      }
      if (done) pendingCells.delete(cell);
    }
    // Nothing near to make: the far buildings' flags, while the frame has room.
    if (pendingCells.size === 0 && backlog.length) {
      const until = workUntil(WARM_SLICE_MS);
      const byCell = new Map<string, Building[]>();
      while (until && backlog.length && performance.now() < until) {
        const b = backlog.pop()!;
        if (keptFor(b)) continue;
        const cell = cellOf(b);
        const list = byCell.get(cell);
        if (list) list.push(b); else byCell.set(cell, [b]);
      }
      for (const [cell, list] of byCell) requests.summarize(cell, entriesOf(list, groundAt, groundKey, pavedAt), env);
    }
    if (flagsMoved && (backlog.length === 0 || requests.waiting === 0)) flyFlags();
    return changed;
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
      return warming !== null || pendingCells.size > 0;
    },
    hidden: false,
    kit,
    chunkOf(b) {
      if (!lastGround) return null;
      const { groundAt, pavedAt, naturalAt } = lastGround;
      // One building asked for at once (a ruin): emitted here.
      return { chunk: emitChunk(b, groundAt, pavedAt, naturalAt), kit };
    },
    update(doc, groundAt, groundKey, pavedAt, naturalAt = groundAt, groundTouched) {
      lastGround = { groundAt, groundKey, pavedAt, naturalAt };
      touched = groundTouched;
      const env: CellEnv = { groundAt, naturalAt, ...(pavedAt ? { pavedAt } : {}) };
      const hides = preview?.hides ?? null;
      const dimKey = dimmed === undefined ? 'off' : String(dimmed ?? 'all');
      const cutKey = cutaway
        ? `${cutaway.only ?? ''}:${cutaway.level}@${Math.round(cutaway.x)},${Math.round(cutaway.y)}/${Math.round(Math.atan2(cutaway.view.y, cutaway.view.x) / (Math.PI / 4))}`
        : 'whole';
      const rest = `${groundKey}|${hides}|${dimKey}|${cutKey}|${[...ruined].join(',')}`;
      // The buildings' shape and their wear (`BuildingStore.wear`): a building drawn shows both.
      const key = `${doc.buildings.revision}:${doc.buildings.wearRevision}|${rest}`;
      let rebuilt = false;
      // The masses of the buildings an edit changed (or whose ground it moved) are made a few
      // milliseconds a frame first, then their cells asked of the workers, the town as it was
      // staying drawn; the cells are swapped once every one has landed. Made in the frame of
      // the edit, they were a stall of 100-500 ms when a road took buildings away or reshaped
      // the ground beside them (docs/performance.md #16). The first town too (the opening, a
      // map loaded). A building cut open or the others faded takes the same road (its cells
      // are held near, `forcedCells`).
      if (key !== storedKey) {
        // Only buildings changed since the town was put together, each with its id in the diary, nothing else of the key:
        // their cells, from the town kept by cell (`townIndex.ts`). NOT the town again for one building (AUDITORIA A1).
        const since = stored && details && doc === townDoc && rest === storedRest && dimmed === undefined && cutaway === null
          && (!warming || warming.dirty) && warming?.key !== key ? doc.changes.since(townSeen, ['buildings', 'buildingWear']) : null;
        const changed = since?.every((e) => e.ids) ? since : null;
        if (changed || !warming || warming.key !== key) {
          let queue: Building[], loading = false;
          const dirty = warming?.dirty ?? new Set<string>(), ids = warming?.ids ?? new Set<BuildingId>();
          if (changed) {
            for (const id of changed.flatMap((e) => e.ids!) as BuildingId[]) {
              const b = doc.buildings.get(id);
              town.take(id, b && b.id !== hides && !ruined.has(b.id) ? b : undefined, dirty);
              ids.add(id);
            }
            townSeen = doc.changes.version;
            queue = [...dirty].flatMap((cell) => town.byCell.get(cell) ?? []);
          } else {
            queue = [...doc.buildings.all()].filter((b) => b.id !== hides && !ruined.has(b.id));
            // A town none of whose buildings is made yet - the opening, a map opened - is a load, not an edit of
            // a running game: it takes the loading budget (Unity's backgroundLoadingPriority High, 50 ms a frame)
            // instead of the 6 ms an edit may take. At 6 ms a frame the 761 buildings of the default town came
            // 10-20 s after its roads. Made = has its mass (every edit was a load: AUDITORIA A2).
            loading = (stored === null ? queue.length : queue.reduce((n, b) => n + (masses.has(b.id) ? 0 : 1), 0)) > LOADING_COUNT;
          }
          warming = { key, queue, at: 0, loading, massed: false, ...(changed ? { dirty, ids } : {}) };
          forcedNear = forcedCells(queue);
        }
        // A load's time is its own (Unity: the most loading may take in a frame), not what the frame's other work
        // left: shared, it got nothing while the traffic's topology took every frame's allowance, and the town
        // stood without buildings for over 20 s.
        warming = warming!;
        const until = warming.loading ? performance.now() + (this.hidden ? HIDDEN_SLICE_MS : LOADING_SLICE_MS) : workUntil(WARM_SLICE_MS);
        if (!until) return false;
        while (!warming.massed && warming.at < warming.queue.length && performance.now() < until) massFor(warming.queue[warming.at++]!, groundAt, groundKey, pavedAt, naturalAt);
        if (!warming.massed && warming.at < warming.queue.length) return false;
        // The far level first, so the eye can say which cells need their detail.
        const byCell = massesByCell(warming.queue, groundAt, groundKey, pavedAt, naturalAt);
        if (warming.dirty) for (const cell of warming.dirty) byCell.set(cell, byCell.get(cell) ?? []);
        if (warming.dirty) massCells.patch(byCell); else massCells.update(byCell);
        chooseNow();
        const done = warming;
        warming = null;
        if (done.dirty && stored && details) {
          // Some buildings changed: their cells made again, each shown as it lands (`landCells`), the rest of the
          // town as it is (AUDITORIA A1).
          for (const cell of done.dirty) pendingCells.add(cell);
          for (const id of done.ids!) {
            const b = doc.buildings.get(id);
            if (b) cover.set(b);
            else { cover.remove(id); dropKept(id); sent.delete(String(id)); groundDigests.delete(id); masses.delete(id); }
            const shown = b && town.has(id) ? b : undefined;
            if (!shown) { lastShown.delete(id); flagsFor(id); signatures.remove(id); continue; }
            lastShown.set(id, shown);
            flagsFor(id);
            const k = keptFor(shown);
            if (!k && fliesFlag(shown)) backlog.push(shown);
            signatures.set(shown, k?.summary.signatureFloor ?? signatureFloorOf(shown, naturalAt, pavedAt));
          }
        } else {
          // The whole town filed again; its near cells made again, each shown as it lands - until then a cell
          // keeps the batch it had, or its masses. NOT the town held until every cell has landed: one change
          // after another kept it waiting, and the streaming with it (2026-10-14).
          for (const batch of [stored, details, faded]) {
            if (!batch) continue;
            group.remove(batch.group);
            batch.dispose();
          }
          const shown = done.queue;
          for (const id of [...kept.keys()]) if (!doc.buildings.has(id)) dropKept(id);
          for (const [k, b] of sent) if (!doc.buildings.has(b.id)) sent.delete(k);
          for (const id of groundDigests.keys()) if (!doc.buildings.has(id)) groundDigests.delete(id);
          for (const id of masses.keys()) if (!doc.buildings.has(id)) masses.delete(id);
          const solid = dimmed === undefined ? shown : shown.filter((b) => b.id === dimmed);
          const others = dimmed === undefined ? [] : shown.filter((b) => b.id !== dimmed);
          if (cutTexts.size > 64) cutTexts.clear();
          town.reset(solid);
          townCells = town.byCell;
          othersByCell = groupByCell(others, cellOf, (b) => b);
          [townSeen, townDoc, storedRest] = [doc.changes.version, doc, rest];
          farSince.clear();
          // Only the cells drawn near have their detail; the rest stand as their masses (`massCells`) and come in
          // by `landCells` when the eye nears.
          for (const cell of [...cells.keys()]) {
            if (townCells.has(cell) && cellNear(cell)) continue;
            dropCell(cells, cell, null);
            for (const sub of detailKeysOf(cell)) dropCell(detailCells, sub, null);
          }
          for (const cell of [...fadedCells.keys()]) if (!othersByCell.has(cell) || !cellNear(cell)) dropCell(fadedCells, cell, null);
          stored = cellGroup(cells);
          details = cellGroup(detailCells);
          group.add(stored.group, details.group);
          faded = cellGroup(fadedCells);
          faded.group.renderOrder = 1;
          group.add(faded.group);
          // The cells pending for the town as it was and no longer: their requests dropped. DO NOT only
          // clear the set: the requests stayed asked, held `STREAM_AHEAD`, and what landed was never taken.
          const wanted = new Set([...townCells.keys(), ...othersByCell.keys()].filter(cellNear));
          for (const cell of pendingCells) if (!wanted.has(cell)) { requests.drop('cell', cell); requests.drop('faded', cell); }
          pendingCells.clear();
          for (const cell of wanted) pendingCells.add(cell);
          // Signature buildings: their bodies, drawn with parts of their own (`signature.ts`).
          for (const b of solid) signatures.set(b, keptFor(b)?.summary.signatureFloor ?? signatureFloorOf(b, naturalAt, pavedAt));
          signatures.keepOnly(new Set(solid.map((b) => b.id)));
          cover.index(doc.buildings.all());
          lastShown.clear();
          for (const b of shown) lastShown.set(b.id, b);
          for (const id of [...flagsOf.keys()]) flagsFor(id);
          for (const b of shown) flagsFor(b.id);
          // Far buildings flying a flag only (all: ~7 ms a frame for 40 s, 2026-10-14).
          backlog = shown.filter((b) => !keptFor(b) && fliesFlag(b));
        }
        storedKey = key;
        flyFlags();
        applyFacadeDetail();
        version++;
        rebuilt = true;
      }
      // The cells pending land as they come back from the workers; those the eye neared since are asked; those long far go out (HLOD streaming).
      if (!warming && stored && details && landCells(env, groundAt, groundKey, pavedAt)) {
        version++;
        rebuilt = true;
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
      for (const key of townCells.keys()) {
        // A cell near with no detail yet (coming by `landCells`) keeps its mass until the detail lands.
        massCells.holdMass(key, cellNear(key) && !cells.has(key));
      }
      for (const [key, cell] of cells) {
        const isNear = cellNear(key);
        cell.part.setVisible(isNear);
        // How long a cell has been far: its detail is let go at `RELEASE_FRAMES` (`landCells`).
        if (isNear) farSince.delete(key);
        else farSince.set(key, (farSince.get(key) ?? 0) + 1);
      }
    },
    cullDetails(eyeX, eyeY, eyeZ, pxAtMetre, orthoPx) {
      cullDetailCells(detailCells, detailState, (key) => massCells.near(key), eyeX, eyeY, eyeZ, pxAtMetre, orthoPx, (part, cellFar) => {
        lighterNow = far || cellFar;
        part.group.traverse(applyDetail);
      });
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
      const k = kept.get(building);
      if (!k?.summary.lot) return NaN;
      if (k.lot === undefined) k.lot = lotGroundAgain(k.b, k.summary.lot, k.pavedAt) ?? null;
      return k.lot?.heightAt(x, y) ?? NaN;
    },
    anyLotHeightAt(x, y) {
      // The buildings filed round the point, in increasing id (`CellFiling.idsMeeting`).
      for (const id of lotFiling.idsMeeting([x, y, x, y])) {
        const k = kept.get(id)!;
        // Filed only with a lot (`putKept`).
        if (k.lot === undefined) k.lot = lotGroundAgain(k.b, k.summary.lot!, k.pavedAt) ?? null;
        const h = k.lot?.heightAt(x, y);
        if (h !== undefined && Number.isFinite(h)) return h;
      }
      return NaN;
    },
    refill() {
      // The cells' arrays were let go once on the GPU (`gpuOnly.ts`) and live in the workers: every cell asked again.
      requests.clear();
      pendingCells.clear();
      for (const cache of [cells, detailCells, fadedCells]) {
        for (const { part } of cache.values()) part.dispose();
        cache.clear();
      }
      storedKey = '';
      townDoc = null;
    },
    dispose() {
      requests.clear();
      pool.dispose();
      flagLayer.dispose();
      massCells.dispose();
      stored?.dispose();
      details?.dispose();
      faded?.dispose();
      for (const cache of [cells, detailCells, fadedCells]) {
        for (const cell of cache.values()) cell.part.dispose();
        cache.clear();
      }
      groundDigests.clear();
      ghost?.dispose();
      kit.dispose();
      group.clear();
    },
  };
}

import { workUntil } from '@core/frameWork';
import { Digest } from '@core/digest';
import { Group, type InstancedMesh, type Mesh } from 'three';
import { warmLooseAhead } from '../uploads';

import { pointInPolygon } from '@core/polygon';
import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from '@world/doc';
import type { GroundAt, PavedAt } from '@world/buildings/foundation';
import { buildingBounds, footprintRects, solidFootprints } from '@world/buildings/geometry';
import type { Building, BuildingId } from '@world/buildings/types';
import { m } from '@world/units';
import { cutOpen } from '@world/buildings/interior';
import { type BuildingChunk, type BuildingMeshes, assembleBuildingMeshes, assembleBuildingMeshesSteps, buildBuildingMeshes, emitChunk } from './buildingMesh';
import { createFlagLayer } from './flagLayer';
import { buildSignature, disposeSignature } from './signature';
import { type BuildingKit, PART_KINDS, type PartKind, createBuildingKit } from './kit';

/**
 * The buildings layer: the stored buildings and the editor's preview, each
 * rebuilt only when what it depends on moves (CLAUDE.md (Execution flow)).
 *
 * The stored buildings depend on `doc.buildings.revision`, on the ground
 * (`groundKey`: the serial of the last ground change that reached a building,
 * `render/groundChanges.ts`) and on which one the preview is standing in for.
 * A building samples its ground again only when `groundTouched` says a change
 * since its last sample reached it. The preview depends on its own serial.
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
   * The frames, railings and louvres of the cells farther than `reach` from
   * the eye (world units, map x/y and height) are not drawn: there a 6 cm
   * frame is far under a pixel, and they were the bulk of a large city's
   * triangles drawn in every frame of the overview.
   */
  cullDetails(eyeX: number, eyeY: number, eyeZ: number, reach: number): void;
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

/** How far past a wall a plant is still considered under the building. */
const PLANT_MARGIN = m(1);
const CELL = m(25.6);

/**
 * Each record's text, written once per record object (MDN, WeakMap: a result
 * kept per object while the object lives). The store never changes a record in
 * place - `put` stores a copy (`BuildingStore.toText` keeps its text the same
 * way) - so the text of a record seen before is the text it has now. Written
 * for every building at every chunk lookup, a decay tick or a grown lot cost
 * some 50 ms of `JSON.stringify` over the 761 buildings of the test city.
 */
const RECORD_TEXT = new WeakMap<Building, string>();
/** Each record's footprints for the plants (`index`), kept the same way. */
const RECORD_FOOTPRINTS = new WeakMap<Building, Vec2[][]>();
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
  const group = new Group();
  group.name = 'buildings-layer';
  // Every flag in the city, waving: one instanced draw (`flagLayer.ts`).
  const flagLayer = createFlagLayer();
  group.add(flagLayer.group);
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
  /** Applies geometry and shadow detail to every stored facade batch. */
  const applyFacadeDetail = (): void => {
    for (const batch of [stored, details, faded]) {
      batch?.group.traverse((o) => {
        const mesh = o as InstancedMesh;
        if (!mesh.isInstancedMesh) return;
        const kind = mesh.name.startsWith('building-') ? (mesh.name.slice(9) as PartKind) : null;
        const lighter = kind ? kit.far[kind] : undefined;
        if (!kind || !lighter) return;
        mesh.geometry = far ? lighter : kit.geometry[kind];
        mesh.castShadow = !shadowFar && kit.castsShadow.has(kind);
      });
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
  const drawn = (b: Building, groundAt: GroundAt, groundKey: string, pavedAt?: PavedAt, naturalAt: GroundAt = groundAt): BuildingChunk =>
    cutaway && near(b) ? cutChunkFor(b, cutaway.level, groundAt, groundKey, pavedAt, naturalAt)
      : chunkFor(b, groundAt, groundKey, pavedAt, naturalAt);
  /**
   * Each building's emitted meshes, keyed by its record and by the ground
   * around it: an edit re-emits one building, a terrain dab only the ones
   * whose ground it moved; everything else is concatenated from here.
   */
  // The record and the ground digest compared apart: the record text is the
  // same string object while the record is (`recordText`), compared by
  // reference; joined into one key, every lookup copied it whole.
  const chunks = new Map<BuildingId, { record: string; digest: string; chunk: BuildingChunk }>();
  const chunkFor = (b: Building, groundAt: GroundAt, groundKey: string, pavedAt?: PavedAt,
    naturalAt: GroundAt = groundAt): BuildingChunk => {
    const record = recordText(b);
    const digest = digestFor(b, record, groundKey, groundAt, pavedAt);
    const known = chunks.get(b.id);
    if (known && known.record === record && known.digest === digest) return known.chunk;
    const chunk = emitChunk(b, groundAt, pavedAt, naturalAt);
    chunks.set(b.id, { record, digest, chunk });
    return chunk;
  };
  /** Footprints bucketed on a coarse grid, for `covers` (a cell as one number: a string per query was most of a plant pass). */
  let buckets = new Map<number, Vec2[][]>();
  const bucketKey = (i: number, j: number): number => i * 100_003 + j;
  /** What the footprints were last indexed from, and how many times they changed (`coversVersion`). */
  let coversDigest = -1;
  let coversVersion = 0;

  const index = (buildings: Iterable<Building>): void => {
    buckets = new Map();
    const digest = new Digest();
    for (const b of buildings) {
      // The built parts with a margin for the crowns, and the open lots as
      // they are: grown round the lots too, every street tree on a pavement a
      // facade stands on was taken away and left its pit empty. Worked out
      // once per record (`RECORD_FOOTPRINTS`), not for the whole town at
      // every change of one building.
      let rects = RECORD_FOOTPRINTS.get(b);
      if (!rects) {
        rects = [...solidFootprints(b, PLANT_MARGIN), ...footprintRects(b)];
        RECORD_FOOTPRINTS.set(b, rects);
      }
      for (const rect of rects) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of rect) {
          minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
          digest.add(p.x).add(p.y);
        }
        digest.add(rect.length);
        for (let i = Math.floor(minX / CELL); i <= Math.floor(maxX / CELL); i++) {
          for (let j = Math.floor(minY / CELL); j <= Math.floor(maxY / CELL); j++) {
            const key = bucketKey(i, j);
            const list = buckets.get(key);
            if (list) list.push(rect);
            else buckets.set(key, [rect]);
          }
        }
      }
    }
    // Only a change of the ground the buildings take moves it: a building
    // drawn again for its paint or its age leaves the plants round it alone.
    const value = digest.value();
    if (value !== coversDigest) {
      coversDigest = value;
      coversVersion++;
    }
  };

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
      if (key !== storedKey && dimmed === undefined && !cutaway) {
        if (!warming || warming.key !== key) {
          const queue = [...doc.buildings.all()].filter((b) => b.id !== hides && !ruined.has(b.id));
          // A town none of whose buildings is made yet - the opening, a map
          // opened - is a load, not an edit of a running game: it takes the
          // loading budget (Unity's backgroundLoadingPriority High, 50 ms a
          // frame) instead of the 6 ms an edit may take. At 6 ms a frame the
          // 761 buildings of the default town came 10-20 s after its roads.
          const unmade = stored === null ? queue.length : queue.reduce((n, b) => n + (chunks.has(b.id) ? 0 : 1), 0);
          warming = { key, queue, at: 0, loading: unmade > LOADING_COUNT };
        }
        // A load's time is its own (Unity: the most loading may take in a
        // frame), not what the frame's other work left: shared, it got
        // nothing while the traffic's topology took every frame's allowance,
        // and the town stood without buildings for over 20 s.
        const until = warming.loading ? performance.now() + (this.hidden ? HIDDEN_SLICE_MS : LOADING_SLICE_MS) : workUntil(WARM_SLICE_MS);
        if (!until) return false;
        while (warming.at < warming.queue.length && performance.now() < until) {
          drawn(warming.queue[warming.at++]!, groundAt, groundKey, pavedAt, naturalAt);
        }
        if (warming.at < warming.queue.length) return false;
        // Then the cells whose buildings changed, a cell at a time.
        if (!warming.cells) {
          const chunkOf = (b: Building): BuildingChunk => drawn(b, groundAt, groundKey, pavedAt, naturalAt);
          warming.cells = [];
          for (const [cache, size, kinds, stage] of [[cells, BATCH_CELL, COARSE_PARTS, stagedCells], [detailCells, DETAIL_CELL, DETAIL_PARTS, stagedDetails]] as const) {
            for (const [cell, list] of chunksByCell(warming.queue, chunkOf, size)) {
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
        for (const id of chunks.keys()) if (!doc.buildings.has(id)) {
          chunks.delete(id);
          groundDigests.delete(id);
        }
        const solid = dimmed === undefined ? shown : shown.filter((b) => b.id === dimmed);
        const others = dimmed === undefined ? [] : shown.filter((b) => b.id !== dimmed);
        if (cutChunks.size > 64) cutChunks.clear();
        stored = assembleByCell(solid, (b) => drawn(b, groundAt, groundKey, pavedAt, naturalAt), kit, cells, BATCH_CELL, COARSE_PARTS, stagedCells);
        details = assembleByCell(solid, (b) => drawn(b, groundAt, groundKey, pavedAt, naturalAt), kit, detailCells, DETAIL_CELL, DETAIL_PARTS, stagedDetails);
        // Staged for a change overtaken by another: not used.
        for (const stage of [stagedCells, stagedDetails]) {
          for (const { part } of stage.values()) part.dispose();
          stage.clear();
        }
        group.add(stored.group, details.group);
        faded = others.length > 0
          ? assembleBuildingMeshes(others.map((b) => drawn(b, groundAt, groundKey, pavedAt, naturalAt)), kit, false, true)
          : null;
        if (faded) {
          faded.group.renderOrder = 1;
          group.add(faded.group);
        }
        // Signature buildings: their bodies, drawn with parts of their own (`signature.ts`).
        const keep = new Set<BuildingId>();
        for (const b of solid) {
          const floor = drawn(b, groundAt, groundKey, pavedAt, naturalAt).signatureFloor;
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
        index(doc.buildings.all());
        flagLayer.set(shown.flatMap((b) => drawn(b, groundAt, groundKey, pavedAt, naturalAt).flags ?? []));
        applyFacadeDetail();
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
    cullDetails(eyeX, eyeY, eyeZ, reach) {
      const r2 = reach * reach;
      for (const [key, cell] of detailCells) {
        const comma = key.indexOf(',');
        const cx = (Number(key.slice(0, comma)) + 0.5) * DETAIL_CELL - eyeX;
        const cy = (Number(key.slice(comma + 1)) + 0.5) * DETAIL_CELL - eyeY;
        cell.part.group.visible = cx * cx + cy * cy + eyeZ * eyeZ < r2;
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
      return coversVersion;
    },
    covers(x, y) {
      const list = buckets.get(bucketKey(Math.floor(x / CELL), Math.floor(y / CELL)));
      if (!list) return false;
      const p = { x, y };
      for (const rect of list) if (pointInPolygon(p, rect)) return true;
      return false;
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

/**
 * A fingerprint of the ground under and around a building: a 6 x 6 grid over
 * its bounds grown by two modules (the entrance steps land out there), of the
 * land and of the paving. Any change the foundation could see changes this.
 */
function groundDigest(b: Building, groundAt: GroundAt, pavedAt?: PavedAt): string {
  const box = buildingBounds(b, b.module * 2);
  let out = '';
  for (let i = 0; i <= 5; i++) {
    for (let j = 0; j <= 5; j++) {
      const x = box.minX + ((box.maxX - box.minX) * i) / 5;
      const y = box.minY + ((box.maxY - box.minY) * j) / 5;
      out += `${groundAt(x, y).toFixed(2)}${pavedAt ? `/${pavedAt(x, y).toFixed(2)}` : ''},`;
    }
  }
  return out;
}
/** Milliseconds a frame spent emitting the buildings of a change (`update`). */
const WARM_SLICE_MS = 6;
/** Milliseconds a frame while a whole town is loaded (Unity, backgroundLoadingPriority High). */
const LOADING_SLICE_MS = 50;
/**
 * Milliseconds a frame while a town loads behind the loading curtain: nothing
 * is presented, so the frame is the load's (Unity's
 * `allowSceneActivation = false`: loaded whole in the background, then shown).
 */
const HIDDEN_SLICE_MS = 250;
/** More buildings than this not made yet: a load, not an edit. */
const LOADING_COUNT = 100;
/** Side of the cells the buildings are batched in, world units. */
const BATCH_CELL = m(240);
const DETAIL_CELL = m(120);
const DETAIL_PARTS: ReadonlySet<PartKind> = new Set(['frame', 'railing', 'roofRailing', 'louvre', 'curtain']);
const COARSE_PARTS: ReadonlySet<PartKind> = new Set(PART_KINDS.filter((kind) => !DETAIL_PARTS.has(kind)));

/**
 * The buildings batched cell by cell, each cell its own meshes: a cell out of
 * the view (and out of the shadow's) is not drawn at all. One batch for the
 * whole town sent every window frame and railing in it to the GPU, twice a
 * frame (picture and shadow), wherever the camera looked.
 */
/** A cell's batch and the buildings' meshes it was assembled from. */
type CellCache = Map<string, { chunks: readonly BuildingChunk[]; part: BuildingMeshes }>;

/**
 * The buildings batched by cell of the map. A cell whose buildings' meshes
 * are the very ones it was assembled from (each building's are kept while it
 * is unchanged, `chunkFor`) keeps its batch; only the cells an edit touched
 * are assembled and sent to the GPU again. Every cell of the town was, for a
 * storey added to one building - as voxel and tile engines rebuild only the
 * chunks an edit made dirty.
 */
/** The buildings' chunks by cell, in list order. */
function chunksByCell(buildings: readonly Building[], chunkOf: (b: Building) => BuildingChunk, cellSize: number): Map<string, BuildingChunk[]> {
  const byCell = new Map<string, BuildingChunk[]>();
  for (const b of buildings) {
    const key = `${Math.floor(b.x / cellSize)},${Math.floor(b.y / cellSize)}`;
    const list = byCell.get(key);
    if (list) list.push(chunkOf(b));
    else byCell.set(key, [chunkOf(b)]);
  }
  return byCell;
}

const sameChunks = (a: readonly BuildingChunk[], b: readonly BuildingChunk[]): boolean =>
  a.length === b.length && a.every((c, i) => c === b[i]);

function assembleByCell(buildings: readonly Building[], chunkOf: (b: Building) => BuildingChunk,
  kit: BuildingKit, cache: CellCache, cellSize: number, partKinds: ReadonlySet<PartKind>, staged?: CellCache): BuildingMeshes {
  const byCell = chunksByCell(buildings, chunkOf, cellSize);
  const group = new Group();
  group.name = 'buildings';
  group.matrixAutoUpdate = false;
  group.updateMatrix();
  const parts: BuildingMeshes[] = [];
  for (const [key, chunks] of byCell) {
    const known = cache.get(key);
    let part: BuildingMeshes;
    const ready = staged?.get(key);
    if (known && sameChunks(known.chunks, chunks)) {
      part = known.part;
    } else if (ready && sameChunks(ready.chunks, chunks)) {
      // Put together ahead, a cell a frame (`update`).
      known?.part.dispose();
      part = ready.part;
      staged!.delete(key);
      cache.set(key, { chunks, part });
    } else {
      known?.part.dispose();
      part = assembleBuildingMeshes(chunks, kit, false, false,
        { parts: partKinds, shells: partKinds === COARSE_PARTS, furniture: partKinds === COARSE_PARTS });
      cache.set(key, { chunks, part });
    }
    parts.push(part);
    group.add(part.group);
  }
  // Cells left with no building.
  for (const [key, known] of cache) {
    if (byCell.has(key)) continue;
    known.part.dispose();
    cache.delete(key);
  }
  return {
    group,
    triangles: parts.reduce((sum, part) => sum + part.triangles, 0),
    // The cells' batches belong to the cache: only this group is let go.
    dispose() {
      group.clear();
    },
  };
}

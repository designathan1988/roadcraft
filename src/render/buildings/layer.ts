import { Group, type InstancedMesh, type Object3D } from 'three';
import { Digest } from '@core/digest';

import type { RoadDoc } from '@world/doc';
import type { GroundAt, PavedAt } from '@world/buildings/foundation';
import { buildingBounds } from '@world/buildings/geometry';
import type { Building, BuildingId } from '@world/buildings/types';
import { cutOpen } from '@world/buildings/interior';
import { CellFiling } from '@world/cells';
import { type BuildingMeshes, type LotGround, buildBuildingMeshes, emitChunk, fliesFlag, kitBoxes, lotGroundAgain, signatureFloorOf } from './buildingMesh';
import {
  BATCH_CELL, type CellCache, type DetailState, cullDetailCells, watchedCells,
  STREAM_AHEAD, cellGroup, createCoverIndex, detailKeysOf, dropCell, groundDigest,
} from './layerCells';
import { type FlagInstance, createFlagLayer } from './flagLayer';
import { TownIndex, patchCell, signatureBodies } from './townIndex';
import { fadeMeshes } from './fade';
import { createMassCells } from './massCells';
import { type BuildingKit, type PartKind, createBuildingKit } from './kit';
import { type CellEnv, CellPool } from './cellPool';
import { CellRequests, sameEntries } from './cellRequests';
import type { BuildingLayer, BuildingPreviewInput, CutawaySpec } from './layerApi';

export type { BuildingLayer, BuildingPreviewInput, CutawaySpec } from './layerApi';
import type { CellEntry, ChunkSummary } from './cellWork';


/** What the page keeps of a building emitted in a worker: by the record and ground it was made for (their digests). */
interface Kept { readonly sig: number; readonly digest: number; readonly b: Building; readonly summary: ChunkSummary; readonly pavedAt?: PavedAt; lot?: LotGround | null }

/** How many times the ground the screen takes in a cell's detail stays resident on the GPU (`levelOfDetail`). */
const RESIDENT_REACH = 2;

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
  /**
   * Each record's digest (`Digest.addPlain`), once per record object (MDN, WeakMap: kept while the
   * object lives). The store never changes a record in place, so a record seen before has the digest
   * it had. DO NOT keep each record's JSON text instead: a string the size of the record, for every
   * building of the town; the text is written only for the message to a worker (`textOf`).
   */
  const sigs = new WeakMap<Building, number>();
  const sigOf = (b: Building): number => {
    let sig = sigs.get(b);
    if (sig === undefined) sigs.set(b, sig = new Digest().addPlain(b).value());
    return sig;
  };
  const signatures = signatureBodies(signatureRoot, sigOf);
  group.matrixAutoUpdate = false;
  group.updateMatrix();
  let stored: BuildingMeshes | null = null;
  let ruined: ReadonlySet<number> = new Set();
  /** Moves when the ruins change (`setRuined`), not when the same ones are given again. */
  let ruinedSerial = 0;
  let lastGround: { groundAt: GroundAt; groundKey: string; pavedAt: PavedAt | undefined; naturalAt: GroundAt } | null = null;
  /**
   * Each cell's batch as shown, and the buildings it was made of. A cell coming in or going tells the
   * far level (`massCells.setDetailed`): its mass stands in while it is near with no detail. DO NOT
   * set that for every cell of the town every frame (`levelOfDetail` did): it changes only here.
   */
  const cells: CellCache = watchedCells((key, has) => massCells.setDetailed(key, has));
  const detailCells: CellCache = new Map();
  let details: BuildingMeshes | null = null;
  let dimmed: BuildingId | null | undefined = undefined;
  /**
   * "Ocultar outros" as the cells were last set (`fadeMeshes`), and the building left solid, drawn on its
   * own (`solo`, out of its cell) under `soloKey`.
   */
  let storedDimmed: BuildingId | null | undefined = undefined;
  let solo: BuildingMeshes | null = null;
  let soloKey = '';
  let ghost: BuildingMeshes | null = null;
  let storedKey = '';
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
  /** The shown town by cell, kept between changes, as of the diary's `townSeen` in `townDoc`. */
  const town = new TownIndex(cellOf);
  let townSeen = -1, townDoc: RoadDoc | null = null;
  /** The ground, the building hidden by the preview and the ruins the town was last put together with (`update`). */
  let storedGround = '', storedHides: BuildingId | null = null;
  let storedRuined: ReadonlySet<number> = new Set();
  /** Cells held near whatever the eye says: the building cut open, the one being edited. */
  let forcedNear: ReadonlySet<string> = new Set();
  const cellNear = (key: string): boolean => eye === null || forcedNear.has(key) || massCells.near(key);
  const chooseNow = (): void => {
    if (eye) massCells.choose(eye.x, eye.y, eye.z, eye.pxAtMetre, eye.orthoPx, forcedNear, eye.reach);
  };
  /** The shown buildings by coarse cell, as last put together (`update`): what a cell streamed in is made of. */
  let townCells = new Map<string, Building[]>();
  /** The cells whose batches must be made for the town as it is now, shown as they land (`landCells`). */
  const pendingCells = new Set<string>();
  /**
   * The cells shown in detail as `levelOfDetail` last set them: a cell gone far is hidden, its buffers
   * kept on the GPU, and shown again as it nears - only the cells whose nearness changed are touched.
   * DO NOT let a far cell's detail go: coming back to it emitted the cell again and held it on its masses
   * for the seconds that took. NOR walk every detailed cell each frame for its visibility.
   */
  let shownNear = new Set<string>();
  /**
   * Where the resident cells were last checked from (`levelOfDetail`): a cell's detail stays on the GPU,
   * hidden when far, while it is within `RESIDENT_REACH` times the ground the screen takes in, and is let
   * go past it - the loading range of a streamed world (Unreal's World Partition, by distance from the
   * source), so what is kept grows with the view, never with the town or the ground already seen. Checked
   * again when the eye has moved a quarter of that ground.
   */
  let residentFrom = { x: Infinity, y: Infinity, reach: -1 };
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
    lighterNow = far;
    stored?.group.traverse(applyDetail);
    for (const cell of detailCells.values()) {
      lighterNow = far || (detailState.get(cell.part)?.far ?? false);
      cell.part.group.traverse(applyDetail);
    }
  };
  /** An edit to one building must not resample the ground under every other building. */
  const groundDigests = new Map<BuildingId, { sig: number; groundKey: string; digest: number }>();
  /** Whether a ground change since a key reached a building; without one, any new key did. */
  let touched: ((b: Building, sinceKey: string) => boolean) | undefined;
  const digestFor = (b: Building, sig: number, groundKey: string, groundAt: GroundAt, pavedAt?: PavedAt): number => {
    const known = groundDigests.get(b.id);
    if (known && known.sig === sig && known.groundKey === groundKey) return known.digest;
    // The ground changed somewhere, not under this building: what it sampled stands.
    if (known && known.sig === sig && touched && !touched(b, known.groundKey)) {
      groundDigests.set(b.id, { ...known, groundKey });
      return known.digest;
    }
    const digest = groundDigest(b, groundAt, pavedAt);
    groundDigests.set(b.id, { sig, groundKey, digest });
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
  /** Each building as last sent to the workers, by its entry's key: what a summary that comes back is of, and what `textOf` writes. */
  const sent = new Map<string, Building>();
  /**
   * A building as the workers are sent it: its key, its record as text and the
   * ground under it. One cut open sends its record cut open, under a key of its
   * own (by floor and the side the camera looks from, snapped to eighths of a
   * turn: the walls that come down change only when the camera has really turned).
   */
  const entryFor = (b: Building, groundAt: GroundAt, groundKey: string, pavedAt?: PavedAt): CellEntry => {
    const sig = sigOf(b);
    const digest = digestFor(b, sig, groundKey, groundAt, pavedAt);
    if (!(cutaway && near(b))) { sent.set(String(b.id), b); return { key: String(b.id), sig, digest }; }
    const dir = Math.round(Math.atan2(cutaway.view.y, cutaway.view.x) / (Math.PI / 4));
    const key = `${b.id}|${cutaway.level}|${dir}`;
    sent.set(key, b);
    return { key, sig: new Digest().add(sig).add(cutaway.level).add(dir).value(), digest };
  };
  /**
   * An entry's record as text, for a job's message (`CellPool`): the building as sent, or, under a
   * key cut open (`id|floor|side`), cut open at that floor from that side. Written for the message
   * and not kept. DO NOT keep the texts cut open in a map with a cap: a cache that drops and remakes.
   */
  const textOf = (entry: CellEntry): string => {
    const b = sent.get(entry.key)!;
    if (!entry.key.includes('|')) return JSON.stringify(b);
    const [, level, dir] = entry.key.split('|').map(Number) as [number, number, number];
    const turn = dir * (Math.PI / 4);
    // Opened, a signature building is drawn by the shared kit with its rooms and furniture.
    const { blueprint: _sig, ...plain } = cutOpen(b, level, { x: Math.cos(turn), y: Math.sin(turn) });
    return JSON.stringify(plain);
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
      putKept(b.id, { sig: entry.sig, digest: entry.digest, b, summary: s, ...(env.pavedAt ? { pavedAt: env.pavedAt } : {}) });
    }
  };
  /** What is kept of a building, if made for its record and the ground under it now (the digest its mass was last made on). */
  const keptFor = (b: Building): Kept | undefined => {
    const k = kept.get(b.id);
    return k && k.sig === sigOf(b) && k.digest === groundDigests.get(b.id)?.digest ? k : undefined;
  };
  const pool = new CellPool(() => kitBoxes(kit), (entry) => textOf(entry), true, kit.finishTone);
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
  /** The buildings by coarse cell whose masses stand for them from afar: the shown ones (`update`), the faded included. */
  let massTown = new Map<string, Building[]>();
  /**
   * A cell's masses asked of the workers (`cellWork.ts` 'mass') for its buildings now, the cell kept
   * as it stands until they come; a cell with no building goes. DO NOT mass the buildings on the page:
   * every building of the town was massed there a slice a frame, and its mass kept there for good.
   */
  const askMass = (cell: string, env: CellEnv, groundAt: GroundAt, groundKey: string, pavedAt: PavedAt | undefined): void => {
    const list = massTown.get(cell);
    if (!list?.length) { requests.dropMass(cell); massCells.remove(cell); return; }
    massCells.plan(cell);
    const entries = list.map((b): CellEntry => {
      const sig = sigOf(b);
      sent.set(String(b.id), b);
      return { key: String(b.id), sig, digest: digestFor(b, sig, groundKey, groundAt, pavedAt) };
    });
    requests.mass(cell, entries, env, (mass) => {
      massCells.land(cell, mass);
      chooseNow();
      version++;
    });
  };
  /**
   * The cells a cut-open view reaches (the building asked for, or every building within its radius,
   * a cell's margin for a building over its cell's edge), among the town's cells.
   */
  const cutCellsOf = (doc: RoadDoc, spec: CutawaySpec | null): Set<string> => {
    const out = new Set<string>();
    if (!spec) return out;
    if (spec.only !== undefined) {
      const b = doc.buildings.get(spec.only);
      if (b && town.has(b.id)) out.add(cellOf(b));
      return out;
    }
    const i0 = Math.floor((spec.x - spec.radius) / BATCH_CELL) - 1, i1 = Math.floor((spec.x + spec.radius) / BATCH_CELL) + 1;
    const j0 = Math.floor((spec.y - spec.radius) / BATCH_CELL) - 1, j1 = Math.floor((spec.y + spec.radius) / BATCH_CELL) + 1;
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) if (townCells.has(`${i},${j}`)) out.add(`${i},${j}`);
    return out;
  };
  /** The cells held near whatever the eye says: those cut open (`cutCells`), the one being edited (`dimmed`). */
  const forcedCells = (doc: RoadDoc): ReadonlySet<string> => {
    const out = new Set(cutCells);
    const edited = dimmed !== undefined && dimmed !== null ? doc.buildings.get(dimmed) : undefined;
    if (edited) out.add(cellOf(edited));
    return out;
  };
  /** The cut-open view the cells were last asked for (`cutKey` in `update`), and the cells it reaches. */
  let storedCut = 'whole';
  let cutCells = new Set<string>();
  /** Where the batches are shown, for `patchCell`. */
  const shownAt = () => ({ cells, details: detailCells, stored: stored!, detailed: details! });
  /** A cell landed shown: its coarse batch at the detail the eye has, its detail cells under theirs. */
  const show = (key: string, landed: Parameters<typeof patchCell>[1]): void => {
    patchCell(key, landed, shownAt());
    const part = cells.get(key)?.part;
    if (!part) return;
    lighterNow = far;
    part.group.traverse(applyDetail);
    // Landed while the others are faded: faded as the rest (`fadeMeshes`), its detail cells too.
    if (dimmed !== undefined) {
      fadeMeshes(part.group, kit, true);
      for (const sub of detailKeysOf(key)) { const d = detailCells.get(sub); if (d) fadeMeshes(d.part.group, kit, true); }
    }
    part.setVisible(cellNear(key));
  };
  /**
   * One frame's share of the cells: those drawn near with no detail become pending (HLOD
   * streaming); the pending ones are asked of the workers nearest first, a few
   * at once (a far one asked first would keep a near one waiting behind it in
   * its worker), and each is shown whole, once on the GPU, as it lands - its old
   * batch, or its masses, shown till then. A pending cell drawn far gives up its
   * request. True when a cell came in or went out.
   */
  const landCells = (env: CellEnv, groundAt: GroundAt, groundKey: string, pavedAt: PavedAt | undefined): boolean => {
    let changed = false;
    if (eye) {
      // The cells drawn near (`massCells`, a cell with buildings but no mass always near): NOT every cell
      // of the town each frame.
      for (const key of massCells.nearKeys()) if (!cells.has(key) && townCells.has(key)) pendingCells.add(key);
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
    for (const cell of order) {
      if (!cellNear(cell)) {
        patchCell(cell, null, shownAt());
        requests.drop('cell', cell);
        pendingCells.delete(cell);
        changed = true;
        continue;
      }
      let done = true;
      {
        const list = townCells.get(cell) ?? [];
        // A cell whose shown batch is what the town is now (or that has no buildings left) wants nothing
        // asked: a request still out for another state of it is dropped. DO NOT leave it: it landed and was
        // never taken, its meshes sent to the GPU and kept until the cell was asked again (`cellRequests.ts`).
        if (list.length === 0) {
          requests.drop('cell', cell);
          if (cells.has(cell)) { patchCell(cell, null, shownAt()); changed = true; }
        } else {
          const entries = entriesOf(list, groundAt, groundKey, pavedAt);
          const known = cells.get(cell);
          if (known && sameEntries(known.entries, entries)) requests.drop('cell', cell);
          else {
            done = false;
            if (requests.isAsked('cell', cell) || requests.asking < STREAM_AHEAD) {
              const got = requests.want('cell', cell, entries, env, true);
              // On the GPU already (`warmLooseAhead`): taken the frame it is ready. DO NOT hold ready cells
              // back a few a frame (`STREAM_CELLS_PER_FRAME`): the swap is a group put in a group.
              if (got) {
                requests.take('cell', cell);
                show(cell, got);
                changed = true;
              }
            }
          }
        }
      }
      if (done) pendingCells.delete(cell);
    }
    // Nothing near to make: the far buildings' flags (the workers take them after the cells and masses).
    if (pendingCells.size === 0 && backlog.length) {
      const byCell = new Map<string, Building[]>();
      while (backlog.length) {
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
      return pendingCells.size > 0 || requests.massing > 0;
    },
    hidden: false,
    kit,
    chunkOf(b) {
      if (!lastGround) return null;
      const { groundAt, pavedAt, naturalAt } = lastGround;
      // One building asked for at once (a ruin): emitted here.
      return { chunk: emitChunk(b, groundAt, pavedAt, naturalAt), kit };
    },
    update(doc, groundAt, groundKey, pavedAt, naturalAt = groundAt, groundTouched, groundMovedUnder) {
      lastGround = { groundAt, groundKey, pavedAt, naturalAt };
      touched = groundTouched;
      const env: CellEnv = { groundAt, naturalAt, ...(pavedAt ? { pavedAt } : {}) };
      const hides = preview?.hides ?? null;
      const cutKey = cutaway
        ? `${cutaway.only ?? ''}:${cutaway.level}@${Math.round(cutaway.x)},${Math.round(cutaway.y)}/${Math.round(Math.atan2(cutaway.view.y, cutaway.view.x) / (Math.PI / 4))}`
        : 'whole';
      // NOT the cut-open view: opening a building costs its cells (below), not the town. NOR the ground,
      // the building the preview hides or the ruins: each is the buildings it reaches, taken in below as
      // changed ones. DO NOT put them back in this key: every road edit (the ground cut and filled), every
      // building picked up and every blow put the whole town together again.
      // NOR "hide the others": the cells' materials (`fadeMeshes`), the building left solid out of its cell.
      // The buildings' shape and their wear (`BuildingStore.wear`): a building drawn shows both.
      const key = `${doc.buildings.revision}:${doc.buildings.wearRevision}|${groundKey}|${hides}|${ruinedSerial}|${String(dimmed)}`;
      /** A building drawn in its cell: not the one the preview stands for, nor a ruin, nor the one left solid while the others fade. */
      const inCell = (b: Building): boolean => b.id !== hides && !ruined.has(b.id) && !(typeof dimmed === 'number' && b.id === dimmed);
      let rebuilt = false;
      // The masses of the buildings an edit changed (or whose ground it moved) are asked of the cell
      // workers, cell by cell, each cell standing as it was until its masses come; then the cells drawn
      // near are asked their detail (`landCells`). The first town too (the opening, a map loaded).
      if (key !== storedKey) {
        // Only buildings changed since the town was put together, each with its id in the diary, nothing else of the key:
        // their cells, from the town kept by cell (`townIndex.ts`). NOT the town again for one building (AUDITORIA A1).
        const since = stored && details && doc === townDoc ? doc.changes.since(townSeen, ['buildings', 'buildingWear']) : null;
        // The buildings the ground moved under since the town was last taken in, found by place;
        // null when that cannot be said.
        const groundMoved = groundKey === storedGround ? [] : groundMovedUnder?.(storedGround) ?? null;
        const changed = since?.every((e) => e.ids) && groundMoved ? since : null;
        if (changed && groundMoved && stored && details) {
          const dirty = new Set<string>(), ids = new Set<BuildingId>();
          const named = changed.flatMap((e) => e.ids!) as BuildingId[];
          for (const b of groundMoved) named.push(b.id);
          // The one the preview hid and the one it hides now; the ruins that came and went.
          if (hides !== storedHides) for (const id of [storedHides, hides]) if (id !== null) named.push(id);
          if (ruined !== storedRuined) {
            for (const id of ruined) if (!storedRuined.has(id)) named.push(id as BuildingId);
            for (const id of storedRuined) if (!ruined.has(id)) named.push(id as BuildingId);
          }
          // The one left solid before and now: out of its cell, or back in it.
          if (dimmed !== storedDimmed) for (const id of [storedDimmed, dimmed]) if (typeof id === 'number') named.push(id);
          for (const id of named) {
            const b = doc.buildings.get(id);
            town.take(id, b && inCell(b) ? b : undefined, dirty);
            ids.add(id);
          }
          townSeen = doc.changes.version;
          cutCells = cutCellsOf(doc, cutaway);
          forcedNear = forcedCells(doc);
          // Some buildings changed: their cells' masses asked again and their detail made again, each shown as
          // it lands (`landCells`), the rest of the town as it is (AUDITORIA A1).
          for (const cell of dirty) { askMass(cell, env, groundAt, groundKey, pavedAt); pendingCells.add(cell); }
          chooseNow();
          for (const id of ids) {
            const b = doc.buildings.get(id);
            if (b) cover.set(b);
            else { cover.remove(id); dropKept(id); sent.delete(String(id)); groundDigests.delete(id); }
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
          for (const batch of [stored, details]) {
            if (!batch) continue;
            group.remove(batch.group);
            batch.dispose();
          }
          const shown = [...doc.buildings.all()].filter((b) => b.id !== hides && !ruined.has(b.id));
          for (const id of [...kept.keys()]) if (!doc.buildings.has(id)) dropKept(id);
          for (const [k, b] of sent) if (!doc.buildings.has(b.id) || (k.includes('|') && !cutaway)) sent.delete(k);
          for (const id of groundDigests.keys()) if (!doc.buildings.has(id)) groundDigests.delete(id);
          const solid = shown.filter(inCell);
          town.reset(solid);
          townCells = town.byCell;
          [townSeen, townDoc] = [doc.changes.version, doc];
          // The far level: every cell's masses asked, the cells with no building left gone.
          massTown = town.byCell;
          for (const cell of [...massCells.keys()]) if (!massTown.has(cell)) askMass(cell, env, groundAt, groundKey, pavedAt);
          for (const cell of massTown.keys()) askMass(cell, env, groundAt, groundKey, pavedAt);
          cutCells = cutCellsOf(doc, cutaway);
          forcedNear = forcedCells(doc);
          chooseNow();
          // Only the cells drawn near have their detail; the rest stand as their masses (`massCells`) and come in
          // by `landCells` when the eye nears.
          for (const cell of [...cells.keys()]) {
            if (townCells.has(cell) && cellNear(cell)) continue;
            dropCell(cells, cell, null);
            for (const sub of detailKeysOf(cell)) dropCell(detailCells, sub, null);
          }
          stored = cellGroup(cells);
          details = cellGroup(detailCells);
          group.add(stored.group, details.group);
          // The cells pending for the town as it was and no longer: their requests dropped. DO NOT only
          // clear the set: the requests stayed asked, held `STREAM_AHEAD`, and what landed was never taken.
          const wanted = new Set([...townCells.keys()].filter(cellNear));
          for (const cell of pendingCells) if (!wanted.has(cell)) requests.drop('cell', cell);
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
        // "Hide the others" turned on or off: every cell shown faded or made solid by its materials alone.
        if ((dimmed !== undefined) !== (storedDimmed !== undefined)) {
          for (const cache of [cells, detailCells]) for (const cell of cache.values()) fadeMeshes(cell.part.group, kit, dimmed !== undefined);
        }
        [storedGround, storedHides, storedRuined, storedDimmed] = [groundKey, hides, ruined, dimmed];
        storedCut = cutKey;
        flyFlags();
        applyFacadeDetail();
        version++;
        rebuilt = true;
      }
      // A building opened or closed ("ver por dentro"): the cells it reaches, before and now, asked again with
      // it cut open, the rest of the town as it is. DO NOT put the town together again for it: every cell's
      // masses were asked again and the cut cell waited behind them.
      if (cutKey !== storedCut && stored && details) {
        const was = cutCells;
        cutCells = cutCellsOf(doc, cutaway);
        for (const cell of [...was, ...cutCells]) pendingCells.add(cell);
        forcedNear = forcedCells(doc);
        chooseNow();
        storedCut = cutKey;
      }
      // The cells pending land as they come back from the workers; those the eye neared since are asked; those long far go out (HLOD streaming).
      if (stored && details && landCells(env, groundAt, groundKey, pavedAt)) {
        version++;
        rebuilt = true;
      }
      const left = typeof dimmed === 'number' ? doc.buildings.get(dimmed) : undefined;
      const soloWanted = left && left.id !== hides && !ruined.has(left.id) ? `${sigOf(left)}|${groundKey}` : '';
      if (soloWanted !== soloKey) {
        soloKey = soloWanted;
        if (solo) { group.remove(solo.group); solo.dispose(); solo = null; }
        if (left && soloWanted) {
          solo = buildBuildingMeshes([left], groundAt, kit, false, pavedAt, naturalAt);
          group.add(solo.group);
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
      if (ids.size === ruined.size && [...ids].every((id) => ruined.has(id))) return;
      ruined = new Set(ids);
      ruinedSerial++;
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
      // A cell near with no detail yet (coming by `landCells`) keeps its mass until the detail lands
      // (`massCells.setDetailed`, told as the cells come and go).
      massCells.choose(eyeX, eyeY, eyeZ, pxAtMetre, orthoPx, forcedNear, reach);
      const now = new Set<string>(massCells.nearKeys());
      for (const key of forcedNear) now.add(key);
      for (const key of shownNear) if (!now.has(key)) cells.get(key)?.part.setVisible(false);
      for (const key of now) if (!shownNear.has(key)) cells.get(key)?.part.setVisible(true);
      shownNear = now;
      if (Number.isFinite(reach) && (Math.hypot(eyeX - residentFrom.x, eyeY - residentFrom.y) > reach / 4 || reach !== residentFrom.reach)) {
        residentFrom = { x: eyeX, y: eyeY, reach };
        const keep = reach * RESIDENT_REACH;
        for (const key of [...cells.keys()]) {
          if (now.has(key) || pendingCells.has(key)) continue;
          const comma = key.indexOf(',');
          const cx = (Number(key.slice(0, comma)) + 0.5) * BATCH_CELL, cy = (Number(key.slice(comma + 1)) + 0.5) * BATCH_CELL;
          if (Math.hypot(cx - eyeX, cy - eyeY) <= keep) continue;
          dropCell(cells, key, stored);
          for (const sub of detailKeysOf(key)) dropCell(detailCells, sub, details);
        }
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
      for (const cache of [cells, detailCells]) {
        for (const { part } of cache.values()) part.dispose();
        cache.clear();
      }
      // The masses too: asked again whole by the next update.
      massCells.dispose();
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
      solo?.dispose();
      for (const cache of [cells, detailCells]) {
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

import { Box3, Frustum, Group } from 'three';
import { Digest } from '@core/digest';

import type { RoadDoc } from '@world/doc';
import type { GroundAt, PavedAt } from '@world/buildings/foundation';
import { buildingHeight, storedBounds } from '@world/buildings/geometry';
import type { RecordRef } from '@world/buildings/recordTable';
import type { Building, BuildingId } from '@world/buildings/types';
import { CellFiling } from '@world/cells';
import { type BuildingMeshes, type LotGround, buildBuildingMeshes, emitChunk, fliesFlag, kitBoxes, lotGroundAgain, signatureFloorOf } from './buildingMesh';
import { BATCH_CELL, type CellCache, ResidentBytes, watchedCells, STREAM_AHEAD, cellDistance, cellGroup, createCoverIndex, dropCell, groundDigest, recordRef } from './layerCells';
import type { ChangeRect } from '@world/changes';
import { type PartCell, type PartView, dropParts } from './partCells';
import { type FlagInstance, createFlagLayer } from './flagLayer';
import { TownIndex, patchCell, signatureBodies } from './townIndex';
import { fadeMeshes } from './fade';
import { FAR_ERROR, createMassCells } from './massCells';
import { FrameScale, LandedTriangles, TYPICAL_LEVEL_TRIANGLES, SLACK } from './frameBudget';
import { type GpuClass, gpuLedger } from '../gpuLedger';
import { MassLevels } from './massLevels';
import { FarLevels, farRunner } from './farLevels';
import type { FarGroundEnv } from './farTiles';
import type { SharedGroundAt } from '../sharedGround';
import { type BuildingKit, createBuildingKit } from './kit';
import { type CellEnv, CellPool } from './cellPool';
import { type BatchKind, CellRequests } from './cellRequests';
import { sameEntries } from './chunk';
import type { BuildingLayer, BuildingPreviewInput, CutawaySpec } from './layerApi';

export type { BuildingLayer, BuildingPreviewInput, CutawaySpec } from './layerApi';
import type { CellEntry, ChunkSummary } from './cellWork';


/** What the page keeps of a building emitted in a worker: by the record and ground it was made for (their digests). */
interface Kept { readonly sig: number; readonly digest: number; readonly b: Building; readonly summary: ChunkSummary; readonly pavedAt?: PavedAt; lot?: LotGround | null }


/** What a cell's detail is reckoned to hold before any has landed (`MassCells.cap`): a dense 256 m cell's facade level, ~70 MB measured 2026-10-16. */
const TYPICAL_CELL_BYTES = 64 * 2 ** 20;
/** The ledger's classes of the cells' detail (L0) and facade level (L1): what the room left under the cap is shared by. */
const DETAIL_CLASSES: readonly GpuClass[] = ['building detail', 'building facade'];
const detailClass = (kind: BatchKind): GpuClass => (kind === 'cell' ? 'building detail' : 'building facade');

export function createBuildingLayer(): BuildingLayer {
  const kit: BuildingKit = createBuildingKit();
  const group = new Group();
  group.name = 'buildings-layer';
  // Every flag in the city, waving: one instanced draw (`flagLayer.ts`).
  const flagLayer = createFlagLayer();
  group.add(flagLayer.group);
  /** The buildings from afar, a mesh a cell (`massCells.ts`); what it lets go is asked again once wanted (a tile by its levels, a cell by `askExposed`). */
  const massCells = createMassCells(kit, BATCH_CELL, (key) => {
    if (key[0] === 't' || key[0] === 'p') levels.release(key);
    else massAsked.delete(key);
  });
  group.add(massCells.group);
  const signatureRoot = new Group();
  signatureRoot.name = 'signature-buildings';
  group.add(signatureRoot);
  /** DO NOT keep each record's JSON text instead: a string the size of the record, for every building of the town */
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
  /** The buildings of the tiles not in the document, baked in workers from the tile store (`farLevels.ts`): the ground they read is the one shared with the workers. */
  const farEnv = (): FarGroundEnv => ({
    ground: (lastGround?.groundAt as SharedGroundAt | undefined)?.share?.current ?? null,
    naturalIsGround: !lastGround || lastGround.naturalAt === lastGround.groundAt,
    tone: kit.finishTone,
  });
  const farTiles = new FarLevels(kit, farRunner(farEnv));
  group.add(farTiles.group);
  /** DO NOT keep every cell's detail the eye ever came near (`reach = Infinity` in perspective kept it all): it holds what the GPU ledger's cap leaves once every other owner is counted (`room`), and draws no more than that (`MassCells.cap`). */
  let budget = Infinity;
  const room = (): number => Math.min(budget, gpuLedger.roomFor(DETAIL_CLASSES));
  /** The bytes the cells' levels hold on the GPU, and what each level measured when it last landed (`layerCells.ts`). */
  const resident = new ResidentBytes();
  /** THE FRAME'S SCALE (`frameBudget.ts`): the view's budget of triangles, the error scale that fits it and the floor the GPU's time sets (`renderer.ts` `governFrame`). */
  const frame = new FrameScale();
  /** What each cell's level drew when it last landed (`show`): what a level not landed yet is reckoned at. */
  const landedTriangles = new LandedTriangles<BatchKind>(TYPICAL_LEVEL_TRIANGLES);
  /** A cell's level come or gone: its bytes counted (here and in the ledger), the level shown chosen again. */
  const counted = (kind: BatchKind, key: string, has: boolean): void => {
    const part = has ? (kind === 'cell' ? cells : facades).get(key)! : null;
    resident.count(kind, key, part ? part.bytes : 0);
    if (part) gpuLedger.set(`buildings|${kind}|${key}`, detailClass(kind), part.bytes, part.part.triangles); else gpuLedger.remove(`buildings|${kind}|${key}`);
    present(key);
  };
  /** DO NOT set that for every cell of the town every frame (`levelOfDetail` did): it changes only here. */
  const cells: CellCache = watchedCells((key, has) => counted('cell', key, has));
  /** Each cell's facade level (L1, `emitChunk` `far`): drawn where the reveals it lays flat span under the pixels the detail is drawn for, kept with the detail under the same budget. */
  const facades: CellCache = watchedCells((key, has) => counted('facade', key, has));
  const facadeStored = cellGroup(facades);
  group.add(facadeStored.group);
  /** Each shown cell's parts, by the cell's key (`partCells.ts`), under one group; the facade level's beside them. */
  const partCells = new Map<string, PartCell>();
  const facadeParts = new Map<string, PartCell>();
  const partRoot = new Group();
  partRoot.name = 'building-part-cells';
  partRoot.matrixAutoUpdate = false;
  partRoot.updateMatrix();
  group.add(partRoot);
  let dimmed: BuildingId | null | undefined = undefined;
  /** "Ocultar outros" as the cells were last set (`fadeMeshes`), and the building left solid, drawn on its own */
  let storedDimmed: BuildingId | null | undefined = undefined;
  let solo: BuildingMeshes | null = null;
  let soloKey = '';
  let ghost: BuildingMeshes | null = null;
  let storedKey = '';
  let ghostKey = '';
  let preview: BuildingPreviewInput | null = null;
  let cutaway: CutawaySpec | null = null;
  /** The preview's and the solid building's tops (`top`), measured once each is made. */
  let ghostTop = -Infinity, soloTop = -Infinity;
  /** The eye the parts' levels are chosen for (`cullDetails`), one object for every frame. */
  const partView: { -readonly [K in keyof PartView]: PartView[K] } = { x: 0, y: 0, z: 0, pxAtMetre: 0, orthoPx: null, shadowTexel: Infinity };
  /** HLOD streaming (see the file's comment). */
  const eyeNow = { x: 0, y: 0, z: 0, pxAtMetre: 0, orthoPx: null as number | null, reach: Infinity };
  let eye: typeof eyeNow | null = null;
  /** The view's frustum the cells were last chosen in (`levelOfDetail`): a cell out of it gets no detail (`MassCells.choose`). */
  const eyeView = new Frustum();
  let viewKnown = false;
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
  /** Whether a cell near is wanted at full detail (L0) rather than its facade level (L1). */
  const cellFine = (key: string): boolean => eye === null || forcedNear.has(key) || massCells.fine(key);
  /** The level a cell shows: its detail where fine (or with no facade level yet), its facade level where not (or with no detail yet), none far (its masses). */
  const levelShown = (key: string): BatchKind | null => {
    if (!cellNear(key)) return null;
    const l0 = cells.has(key), l1 = facades.has(key);
    return l0 && (l1 ? cellFine(key) : true) ? 'cell' : l1 ? 'facade' : null;
  };
  /** A cell's levels shown or hidden as `levelShown` says, its masses where it shows none (its parts follow at `cullDetails`). */
  const present = (key: string): void => {
    const level = levelShown(key);
    cells.get(key)?.part.setVisible(level === 'cell');
    facades.get(key)?.part.setVisible(level === 'facade');
    const p0 = partCells.get(key), p1 = facadeParts.get(key);
    if (p0 && level !== 'cell') p0.group.visible = false;
    if (p1 && level !== 'facade') p1.group.visible = false;
    massCells.setDetailed(key, level !== null);
  };
  const chooseNow = (): void => {
    if (eye) massCells.choose(eye.x, eye.y, eye.z, eye.pxAtMetre, eye.orthoPx, forcedNear, eye.reach, viewKnown ? eyeView : null);
  };
  /** The detail drawn within the room the ledger leaves (`MassCells.cap`): a cell never landed counts as the cells landed do on average. */
  const capNow = (): void => {
    if (!eye) return;
    const typical = resident.typical(TYPICAL_CELL_BYTES);
    massCells.cap(eye.x, eye.y, room(), (key, fine) => resident.of(fine ? 'cell' : 'facade', key, typical), forcedNear);
  };
  /** The shown buildings by coarse cell, as last put together (`update`): what a cell streamed in is made of. */
  let townCells = new Map<string, Building[]>();
  /** Where a building must stand to be put together here (`setActive`: the streamed world's active tiles), the rectangles whose standing changed since the last update, and how many times it changed (part of the town's key). */
  let activeAt: ((x: number, y: number) => boolean) | null = null;
  const activeFlipped: ChangeRect[] = [];
  let activeSerial = 0;
  /** What the levels chosen draw, triangles: each near cell's level (shown, or as its kind is reckoned until it lands), and every mass resident (the cells', tiles' and plates': those hidden under a cell's detail counted too, so never under what is drawn). */
  const chosenTriangles = (): number => {
    let n = gpuLedger.triangles('cell masses') + gpuLedger.triangles('tile masses') + gpuLedger.triangles('plate masses');
    for (const key of massCells.nearKeys()) {
      const level = levelShown(key);
      if (level === 'cell') n += cells.get(key)!.part.triangles + (partCells.get(key)?.triangles ?? 0);
      else if (level === 'facade') n += facades.get(key)!.part.triangles + (facadeParts.get(key)?.triangles ?? 0);
      else if (townCells.has(key)) n += landedTriangles.of(massCells.fine(key) ? 'cell' : 'facade', key);
    }
    return n;
  };
  /** DO NOT fit the view's budget of triangles by raising one error scale for the whole view: every cell coarsened at once, the ones at the eye fell to their facade level; the farthest go first (`MassCells.cap`, as the bytes' budget), detail to facade level to masses, the nearest kept in detail */
  /** The cells the budget held back, remembered (`MassCells.hold`): a cell capped stays capped until there is room, then ONE comes back a frame, the nearest first (let all back at once, the view passed the budget again and they were capped again: the city blinked, cells loaded and unloaded by turns). */
  const heldFar = new Set<string>(), heldCoarse = new Set<string>();
  const nearestHeld = (held: ReadonlySet<string>): string | null => {
    let best: string | null = null, bestD = Infinity;
    for (const key of held) { const d = cellDistance(key, eye!.x, eye!.y); if (d < bestD) { bestD = d; best = key; } }
    return best;
  };
  const capTriangles = (): void => {
    if (!eye || !Number.isFinite(frame.budget)) return;
    const masses = gpuLedger.triangles('cell masses') + gpuLedger.triangles('tile masses') + gpuLedger.triangles('plate masses');
    const fineBefore = new Map<string, boolean>();
    for (const key of massCells.nearKeys()) fineBefore.set(key, massCells.fine(key));
    massCells.cap(eye.x, eye.y, frame.budget - masses, (key, fine) => landedTriangles.of(fine ? 'cell' : 'facade', key), forcedNear);
    for (const [key, wasFine] of fineBefore) {
      if (!massCells.near(key)) heldFar.add(key);
      else if (wasFine && !massCells.fine(key)) heldCoarse.add(key);
    }
    if ((heldFar.size || heldCoarse.size) && chosenTriangles() < frame.budget * SLACK) {
      const key = nearestHeld(heldCoarse) ?? nearestHeld(heldFar);
      if (key !== null) { heldCoarse.delete(key); heldFar.delete(key); }
    }
    massCells.hold(heldFar, heldCoarse);
  };
  /** The cells whose batches must be made for the town as it is now, shown as they land (`landCells`). */
  const pendingCells = new Set<string>();
  /** DO NOT let a far cell's detail go */
  let shownNear = new Set<string>();
  /** Over the budget, the cells drawn far let go, the farthest first: their masses, on the GPU already, stand for them */
  const keepToBudget = (): void => {
    const budget = room();
    if (resident.total <= budget || !eye || !stored) return;
    const at = eye;
    // The levels not shown, the detail first: a cell drawn at its facade level lets its detail go before any facade level goes.
    for (const kind of ['cell', 'facade'] as const) {
      const cache = kind === 'cell' ? cells : facades;
      const far = [...cache.keys()].filter((key) => levelShown(key) !== kind && !pendingCells.has(key)).sort((a, b) => cellDistance(b, at.x, at.y) - cellDistance(a, at.x, at.y));
      for (const key of far) {
        if (resident.total <= budget) return;
        if (kind === 'cell') { dropCell(cells, key, stored); dropParts(partCells, key, partRoot); }
        else { dropCell(facades, key, facadeStored); dropParts(facadeParts, key, partRoot); }
      }
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
    const box = storedBounds(b);
    const dx = Math.max(box.minX - cutaway.x, 0, cutaway.x - box.maxX);
    const dy = Math.max(box.minY - cutaway.y, 0, cutaway.y - box.maxY);
    return Math.hypot(dx, dy) <= cutaway.radius;
  };
  /** Each building as last sent to the workers, by its entry's key: what a summary that comes back is of, and what `textOf` writes. */
  const sent = new Map<string, Building>();
  /** A building as the workers are sent it: its key, its record as text and the ground under it. */
  const entryFor = (b: Building, groundAt: GroundAt, groundKey: string, pavedAt?: PavedAt): CellEntry => {
    const sig = sigOf(b);
    const digest = digestFor(b, sig, groundKey, groundAt, pavedAt);
    if (!(cutaway && near(b))) { sent.set(String(b.id), b); return { key: String(b.id), sig, digest }; }
    const dir = Math.round(Math.atan2(cutaway.view.y, cutaway.view.x) / (Math.PI / 4));
    const key = `${b.id}|${cutaway.level}|${dir}`;
    sent.set(key, b);
    return { key, sig: new Digest().add(sig).add(cutaway.level).add(dir).value(), digest };
  };
  /** Where a worker reads each record (`layerCells.ts` `recordRef`): its tile's shared table, never its text. */
  const refFor = (entry: CellEntry): () => RecordRef => {
    const b = sent.get(entry.key)!;
    return () => recordRef(b, entry.key);
  };
  const entriesOf = (list: readonly Building[], groundAt: GroundAt, groundKey: string, pavedAt?: PavedAt): CellEntry[] =>
    list.map((b) => entryFor(b, groundAt, groundKey, pavedAt));
  /** What the page keeps of each building the workers emitted */
  const kept = new Map<BuildingId, Kept>();
  /** DO NOT walk `kept` for a point: `anyLotHeightAt` is asked for every walker every frame */
  const lotFiling = new CellFiling<BuildingId, Kept>();
  const putKept = (id: BuildingId, k: Kept): void => {
    kept.set(id, k);
    flagsFor(id);
    if (!k.summary.lot) { lotFiling.remove(id); return; }
    const box = storedBounds(k.b);
    lotFiling.file(id, k, [box.minX, box.minY, box.maxX, box.maxY]);
  };
  const dropKept = (id: BuildingId): void => {
    kept.delete(id);
    flagsFor(id);
    lotFiling.remove(id);
  };
  let flagsMoved = false;
  /** DO NOT walk every shown building for its flags at each summary that lands */
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
  const pool = new CellPool(() => kitBoxes(kit), (entry) => refFor(entry), true, kit.finishTone);
  pool.warm();
  /** A cell's level landed: uploaded only if the view still wants it at that level within the room (the cap worked out again with its measured bytes). */
  const admit = (kind: BatchKind, cell: string, bytes: number): boolean => {
    resident.landed(kind, cell, bytes);
    if (forcedNear.has(cell) || !eye) return true;
    capNow();
    return massCells.near(cell) && (massCells.fine(cell) ? 'cell' : 'facade') === kind;
  };
  /** A landing's upload ranked by the pixels the masses standing for it leave out (`uploads.ts`). */
  const rank = (_kind: BatchKind, cell: string): number => massCells.pixels(cell, FAR_ERROR);
  const requests = new CellRequests(pool, kit, keep, admit, rank);
  /** The tiles' (L2) and plates' (L3) masses, asked again only where a cell's buildings changed (`massLevels.ts`). */
  const levels = new MassLevels(pool, (key, mass) => { massCells.landLevel(key, mass); chooseNow(); }, (key) => massCells.removeLevel(key),
    (key) => massCells.planLevel(key), (key) => massCells.wanted(key));
  /** Each cell's buildings as last filed (`askMass`), and as last asked of the workers for its own masses: asked only while the view draws the cell one by one (`askExposed`). */
  const massEntries = new Map<string, readonly CellEntry[]>();
  const massAsked = new Map<string, readonly CellEntry[]>();
  /** DO NOT ask every cell's masses of the map at the opening: only the cells the view draws one by one (their tile refined, `massCells.exposedCells`), their plate or tile standing for the rest */
  const askExposed = (env: CellEnv): void => {
    for (const cell of massCells.exposedCells()) {
      const entries = massEntries.get(cell);
      if (!entries || massAsked.get(cell) === entries) continue;
      massAsked.set(cell, entries);
      requests.mass(cell, entries, env, (mass) => {
        massCells.land(cell, mass);
        chooseNow();
      });
    }
  };
  /** The far buildings flying a flag not emitted yet: their summaries asked of the workers in the frames' spare slices */
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
  /** DO NOT mass the buildings on the page */
  const askMass = (cell: string, groundAt: GroundAt, groundKey: string, pavedAt: PavedAt | undefined): void => {
    const list = massTown.get(cell);
    if (!list?.length) {
      requests.dropMass(cell); massCells.remove(cell); levels.touch(cell, null); massEntries.delete(cell); massAsked.delete(cell);
      resident.forget(cell);
      return;
    }
    // Its height till its masses come: the ground under its buildings to the highest roof (the view's frustum, `MassCells.choose`).
    let bottom = Infinity, top = -Infinity;
    for (const b of list) {
      const ground = groundAt(b.x, b.y);
      if (ground < bottom) bottom = ground;
      top = Math.max(top, ground + buildingHeight(b));
    }
    massCells.plan(cell, bottom, top);
    const entries = list.map((b): CellEntry => {
      const sig = sigOf(b);
      sent.set(String(b.id), b);
      return { key: String(b.id), sig, digest: digestFor(b, sig, groundKey, groundAt, pavedAt) };
    });
    // Its tile and plate asked again once every cell changed is touched (`levels.flush`); its own masses once the view draws it alone (`askExposed`).
    levels.touch(cell, entries);
    massEntries.set(cell, entries);
  };
  /** The cells a cut-open view reaches */
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
  /** Where the batches of each level are shown, for `patchCell`. */
  const shownAt = (kind: BatchKind) => kind === 'cell'
    ? { cells, parts: partCells, stored: stored!, partRoot }
    : { cells: facades, parts: facadeParts, stored: facadeStored, partRoot };
  /** A cell's level landed shown; its parts drawn from the next `cullDetails`, at the levels the eye allows. */
  const show = (kind: BatchKind, key: string, landed: Parameters<typeof patchCell>[1]): void => {
    patchCell(key, landed, shownAt(kind));
    const part = (kind === 'cell' ? cells : facades).get(key)?.part;
    if (!part) return;
    const parts = (kind === 'cell' ? partCells : facadeParts).get(key);
    landedTriangles.set(kind, key, part.triangles + (parts?.triangles ?? 0));
    // Landed while the others are faded: faded as the rest (`fadeMeshes`), its parts too.
    if (dimmed !== undefined) {
      fadeMeshes(part.group, kit, true);
      parts?.setFaded(true);
    }
    if (parts) parts.group.visible = false;
    present(key);
  };
  /** One frame's share of the cells: those drawn near with no detail become pending (HLOD streaming) */
  const landCells = (env: CellEnv, groundAt: GroundAt, groundKey: string, pavedAt: PavedAt | undefined): boolean => {
    let changed = false;
    if (eye) {
      // The cells drawn near (`massCells`, a cell with buildings but no mass always near)
      for (const key of massCells.nearKeys()) if (!(cellFine(key) ? cells : facades).has(key) && townCells.has(key)) pendingCells.add(key);
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
        for (const kind of ['cell', 'facade'] as const) {
          patchCell(cell, null, shownAt(kind));
          requests.drop(kind, cell);
        }
        pendingCells.delete(cell);
        changed = true;
        continue;
      }
      let done = true;
      {
        const list = townCells.get(cell) ?? [];
        // DO NOT leave it: it landed and was never taken, its meshes sent to the GPU and kept until the cell was asked again
        if (list.length === 0) {
          for (const kind of ['cell', 'facade'] as const) {
            requests.drop(kind, cell);
            if ((kind === 'cell' ? cells : facades).has(cell)) { patchCell(cell, null, shownAt(kind)); changed = true; }
          }
        } else {
          const entries = entriesOf(list, groundAt, groundKey, pavedAt);
          // The level the eye wants of it; the other's request, if any, let go (what landed of it was never taken).
          const kind: BatchKind = cellFine(cell) ? 'cell' : 'facade';
          requests.drop(kind === 'cell' ? 'facade' : 'cell', cell);
          const known = (kind === 'cell' ? cells : facades).get(cell);
          if (known && sameEntries(known.entries, entries)) requests.drop(kind, cell);
          else {
            done = false;
            if (requests.isAsked(kind, cell) || requests.asking < STREAM_AHEAD) {
              const got = requests.want(kind, cell, entries, env, true);
              // DO NOT hold ready cells back a few a frame (`STREAM_CELLS_PER_FRAME`): the swap is a group put in a group.
              if (got) {
                requests.take(kind, cell);
                show(kind, cell, got);
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
      let shown = 0;
      for (const map of [partCells, facadeParts]) for (const cell of map.values()) if (cell.group.visible) shown += cell.triangles;
      for (const cache of [cells, facades]) for (const { part } of cache.values()) if (part.group.visible) shown += part.triangles;
      return shown + (ghost?.triangles ?? 0);
    },
    get top() {
      return Math.max(massCells.top(), signatures.top(), ghostTop, soloTop, farTiles.top());
    },
    get pending() {
      // What the view draws, not the whole map: the cells near, the cells drawn one by one, the tiles and plates standing for the rest, the far levels.
      return pendingCells.size > 0 || requests.massing > 0 || massCells.waiting > 0 || farTiles.waiting > 0;
    },
    get coarsePending() {
      return requests.massing > 0 || massCells.waiting > 0 || farTiles.waiting > 0;
    },
    far: farTiles,
    farEnv,
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
      // DO NOT put them back in this key: every road edit
      const key = `${doc.buildings.revision}:${doc.buildings.wearRevision}|${groundKey}|${hides}|${ruinedSerial}|${String(dimmed)}|${activeSerial}`;
      /** A building drawn in its cell: standing on an active tile, not the one the preview stands for, nor a ruin, nor the one left solid while the others fade. */
      const inCell = (b: Building): boolean => (activeAt === null || activeAt(b.x, b.y)) && b.id !== hides && !ruined.has(b.id) && !(typeof dimmed === 'number' && b.id === dimmed);
      let rebuilt = false;
      // The masses of the buildings an edit changed
      if (key !== storedKey) {
        // Only buildings changed since the town was put together, each with its id in the diary, nothing else of the key
        const since = stored && doc === townDoc ? doc.changes.since(townSeen, ['buildings', 'buildingWear']) : null;
        // The buildings the ground moved under since the town was last taken in, found by place; null when that cannot be said.
        const groundMoved = groundKey === storedGround ? [] : groundMovedUnder?.(storedGround) ?? null;
        const changed = since?.every((e) => e.ids) && groundMoved ? since : null;
        if (changed && groundMoved && stored) {
          const dirty = new Set<string>(), ids = new Set<BuildingId>();
          const named = changed.flatMap((e) => e.ids!) as BuildingId[];
          for (const b of groundMoved) named.push(b.id);
          // The tiles that came into the active region or left it: their buildings taken in or let go.
          for (const r of activeFlipped.splice(0)) for (const b of doc.buildings.near(r[0], r[1], r[2], r[3])) named.push(b.id);
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
          // Some buildings changed: their cells' masses asked again and their detail made again, each shown as it lands
          for (const cell of dirty) { askMass(cell, groundAt, groundKey, pavedAt); pendingCells.add(cell); }
          levels.flush(env);
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
          // @rebuild The whole town filed again (a first look, or a diary that cannot say what changed).
          if (stored) {
            group.remove(stored.group);
            stored.dispose();
          }
          const shown = [...doc.buildings.all()].filter((b) => b.id !== hides && !ruined.has(b.id));
          for (const id of [...kept.keys()]) if (!doc.buildings.has(id)) dropKept(id);
          for (const [k, b] of sent) if (!doc.buildings.has(b.id) || (k.includes('|') && !cutaway)) sent.delete(k);
          for (const id of groundDigests.keys()) if (!doc.buildings.has(id)) groundDigests.delete(id);
          const solid = shown.filter(inCell);
          activeFlipped.length = 0;
          town.reset(solid);
          townCells = town.byCell;
          [townSeen, townDoc] = [doc.changes.version, doc];
          // The far level: every cell's masses asked, the cells with no building left gone.
          massTown = town.byCell;
          for (const cell of [...massCells.keys()]) if (!massTown.has(cell)) askMass(cell, groundAt, groundKey, pavedAt);
          for (const cell of massTown.keys()) askMass(cell, groundAt, groundKey, pavedAt);
          levels.flush(env);
          cutCells = cutCellsOf(doc, cutaway);
          forcedNear = forcedCells(doc);
          chooseNow();
          // Only the cells drawn near have their detail; the rest stand as their masses
          for (const cell of [...cells.keys()]) {
            if (townCells.has(cell) && cellNear(cell)) continue;
            dropCell(cells, cell, null);
            dropParts(partCells, cell, partRoot);
          }
          for (const cell of [...facades.keys()]) {
            if (townCells.has(cell) && cellNear(cell)) continue;
            dropCell(facades, cell, facadeStored);
            dropParts(facadeParts, cell, partRoot);
          }
          stored = cellGroup(cells);
          group.add(stored.group);
          // DO NOT only clear the set: the requests stayed asked, held `STREAM_AHEAD`, and what landed was never taken.
          const wanted = new Set([...townCells.keys()].filter(cellNear));
          for (const cell of pendingCells) if (!wanted.has(cell)) { requests.drop('cell', cell); requests.drop('facade', cell); }
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
          for (const cache of [cells, facades]) for (const cell of cache.values()) fadeMeshes(cell.part.group, kit, dimmed !== undefined);
          for (const map of [partCells, facadeParts]) for (const cell of map.values()) cell.setFaded(dimmed !== undefined);
        }
        [storedGround, storedHides, storedRuined, storedDimmed] = [groundKey, hides, ruined, dimmed];
        storedCut = cutKey;
        flyFlags();
        rebuilt = true;
      }
      // DO NOT put the town together again for it: every cell's masses were asked again and the cut cell waited behind them.
      if (cutKey !== storedCut && stored) {
        const was = cutCells;
        cutCells = cutCellsOf(doc, cutaway);
        for (const cell of [...was, ...cutCells]) pendingCells.add(cell);
        forcedNear = forcedCells(doc);
        chooseNow();
        storedCut = cutKey;
      }
      // The cells pending land as they come back from the workers; those the eye neared since are asked; those long far go out (HLOD streaming).
      if (stored && landCells(env, groundAt, groundKey, pavedAt)) {
        rebuilt = true;
        keepToBudget();
      }
      // The tiles and cells the view refined to since: their masses asked (top down, `massLevels.ts`, `askExposed`).
      levels.pump(env);
      askExposed(env);
      const left = typeof dimmed === 'number' ? doc.buildings.get(dimmed) : undefined;
      const soloWanted = left && left.id !== hides && !ruined.has(left.id) ? `${sigOf(left)}|${groundKey}` : '';
      if (soloWanted !== soloKey) {
        soloKey = soloWanted;
        if (solo) { group.remove(solo.group); solo.dispose(); solo = null; soloTop = -Infinity; }
        if (left && soloWanted) {
          solo = buildBuildingMeshes([left], groundAt, kit, false, pavedAt, naturalAt);
          group.add(solo.group);
          soloTop = new Box3().setFromObject(solo.group).max.y;
        }
      }
      const wanted = preview ? `${preview.serial}|${groundKey}` : '';
      if (wanted !== ghostKey) {
        ghostKey = wanted;
        if (ghost) {
          group.remove(ghost.group);
          ghost.dispose();
          ghost = null;
          ghostTop = -Infinity;
        }
        if (preview) {
          if (!preview.solid) kit.setGhostValid(preview.valid);
          // A signature building being edited shows its floors and rooms in the shared kit (the floor ghost).
          const { blueprint: _sig, ...edited } = preview.building;
          ghost = buildBuildingMeshes([edited as Building], groundAt, kit, !preview.solid, pavedAt, naturalAt);
          ghost.group.renderOrder = 2;
          group.add(ghost.group);
          ghostTop = new Box3().setFromObject(ghost.group).max.y;
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
    levelOfDetail(eyeX, eyeY, eyeZ, pxAtMetre, orthoPx, reach = Infinity, view = null) {
      eyeNow.x = eyeX; eyeNow.y = eyeY; eyeNow.z = eyeZ; eyeNow.pxAtMetre = pxAtMetre; eyeNow.orthoPx = orthoPx; eyeNow.reach = reach;
      eye = eyeNow;
      viewKnown = view !== null;
      if (view) eyeView.copy(view);
      // The levels chosen at the floor the GPU's time sets, over the view's budget of triangles the farthest coarsened first (`capTriangles`); only when the masses alone pass it does the scale rise (`frameBudget.ts`). The building cut open and the one being edited stay in detail whatever the eye says.
      const fitted = (scale: number): number => { massCells.setErrorScale(scale); farTiles.setErrorScale(scale); chooseNow(); capNow(); capTriangles(); return chosenTriangles(); };
      if (fitted(frame.floor) > frame.budget) frame.fit(fitted); else frame.scale = frame.floor;
      farTiles.choose(eyeX, eyeY, eyeZ, pxAtMetre, orthoPx, reach, view);
      // The room shrinks when another owner grows (a resize, the far levels): the hidden levels go first.
      keepToBudget();
      const now = new Set<string>(massCells.nearKeys());
      for (const key of forcedNear) now.add(key);
      // Those gone far, and every one near: a cell near may have changed between its detail and its facade level.
      for (const key of shownNear) if (!now.has(key)) present(key);
      for (const key of now) present(key);
      shownNear = now;
    },
    setDetailBudget(bytes) {
      budget = bytes;
      keepToBudget();
    },
    drawnOver(rect) {
      const i0 = Math.floor(rect[0] / BATCH_CELL), j0 = Math.floor(rect[1] / BATCH_CELL), i1 = Math.ceil(rect[2] / BATCH_CELL), j1 = Math.ceil(rect[3] / BATCH_CELL);
      for (const key of townCells.keys()) {
        const comma = key.indexOf(',');
        const i = Number(key.slice(0, comma)), j = Number(key.slice(comma + 1));
        if (i < i0 || i >= i1 || j < j0 || j >= j1) continue;
        if (levelShown(key) === null && !massCells.drawn(key)) return false;
      }
      return true;
    },
    setActive(at, rects) {
      activeAt = at;
      activeFlipped.push(...rects);
      if (rects.length || at === null) activeSerial++;
    },
    frame,
    get residentBytes() {
      return resident.total;
    },
    cullDetails(eyeX, eyeY, eyeZ, pxAtMetre, orthoPx, shadowTexel) {
      partView.x = eyeX; partView.y = eyeY; partView.z = eyeZ; partView.pxAtMetre = pxAtMetre; partView.orthoPx = orthoPx; partView.shadowTexel = shadowTexel;
      // Drawn while its cell is drawn in detail (the masses stand for it from afar, `massCells.ts`), each kind by its error on the screen.
      for (const [kind, map] of [['cell', partCells], ['facade', facadeParts]] as const) {
        for (const [key, cell] of map) {
          cell.group.visible = levelShown(key) === kind;
          if (cell.group.visible) cell.choose(partView);
        }
      }
    },
    castInto(texel) {
      for (const map of [partCells, facadeParts]) for (const cell of map.values()) if (cell.group.visible) cell.castInto(texel);
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
      for (const cache of [cells, facades]) {
        for (const { part } of cache.values()) part.dispose();
        cache.clear();
      }
      facadeStored.group.clear();
      for (const map of [partCells, facadeParts]) {
        for (const cell of map.values()) cell.dispose();
        map.clear();
      }
      partRoot.clear();
      // The masses too, the tiles' and plates' with them: asked again whole by the next update.
      levels.clear();
      massEntries.clear();
      massAsked.clear();
      massCells.dispose();
      farTiles.refill();
      storedKey = '';
      townDoc = null;
    },
    dispose() {
      requests.clear();
      levels.clear();
      massEntries.clear();
      massAsked.clear();
      pool.dispose();
      flagLayer.dispose();
      massCells.dispose();
      farTiles.dispose();
      stored?.dispose();
      solo?.dispose();
      for (const cache of [cells, facades]) {
        for (const cell of cache.values()) cell.part.dispose();
        cache.clear();
      }
      for (const map of [partCells, facadeParts]) {
        for (const cell of map.values()) cell.dispose();
        map.clear();
      }
      groundDigests.clear();
      ghost?.dispose();
      kit.dispose();
      group.clear();
    },
  };
}

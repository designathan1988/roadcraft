import { Box3, type Camera, Frustum, Group, InstancedMesh, type Mesh, type Object3D } from 'three';
import { Digest } from '@core/digest';

import type { RoadDoc } from '@world/doc';
import type { GroundAt, PavedAt } from '@world/buildings/foundation';
import type { RecordRef } from '@world/buildings/recordTable';
import type { Building, BuildingId } from '@world/buildings/types';
import { CellFiling } from '@world/cells';
import { type BuildingMeshes, type LotGround, buildBuildingMeshes, emitChunk, kitBoxes, lotGroundAgain, signatureFloorOf } from './buildingMesh';
import { BATCH_CELL, type CellCache, ResidentBytes, watchedCells, STREAM_AHEAD, boxGroundDigest, cellGroup, createCoverIndex, dropCell, recordRef } from './layerCells';
import { FLIES, KEPT, KNOWN, SHOWN, SIGNATURE, TownColumns, recordDigests } from './townColumns';
import { type PartCell, type PartView, dropParts } from './partCells';
import { FarPartBatch } from './farParts';
import { ShellBatch } from './shellBatch';
import { type FlagInstance, createFlagLayer } from './flagLayer';
import { TownIndex, patchCell, signatureBodies } from './townIndex';
import { fadeMeshes } from './fade';
import { FAR_ERROR, createMassCells, sameFrustum } from './massCells';
import { FrameScale, LandedMeasure, TYPICAL_LEVEL_TRIANGLES, letBackFitting, letGoPassed } from './frameBudget';
import { type GpuClass, gpuLedger } from '../gpuLedger';
import { MassLevels } from './massLevels';
import { levelCells } from './levelKeys';
import { type BuildingKit, createBuildingKit } from './kit';
import { type CellEnv, CellPool } from './cellPool';
import { type BatchKind, CellRequests } from './cellRequests';
import { type PackedEntries, sameEntries, samePacked, unpack } from './chunk';
import type { BuildingLayer, BuildingPreviewInput, CutawaySpec, GroundDigestOf } from './layerApi';

export type { BuildingLayer, BuildingPreviewInput, CutawaySpec } from './layerApi';
import type { CellEntry, ChunkSummary } from './cellWork';


/** What the page keeps of a building emitted in a worker beyond the digests it was made for (`TownColumns` `keptSig`, `keptDigest`): its summary when it says anything (flags, lots, a signature floor), and its lots' ground once asked. DO NOT keep its record: read from the document when its lots are asked (`lotHeightAt`). */
interface Kept { readonly id: BuildingId; readonly summary: ChunkSummary; readonly pavedAt?: PavedAt; lot?: LotGround | null }


/** The ledger's classes of the cells' detail (L0) and facade level (L1): what the room left under the cap is shared by. */
const DETAIL_CLASSES: readonly GpuClass[] = ['building detail', 'building facade'];
const detailClass = (kind: BatchKind): GpuClass => (kind === 'cell' ? 'building detail' : 'building facade');

/** Whether a diary entry is the player's edit (`main.ts` mutateBuilt's `tool …`, undo, redo), not the growth (`zone growth`) nor a tile coming in. */
export const playerCause = (cause: string): boolean => cause.startsWith('tool ') || cause === 'undo' || cause === 'redo';

/** The most the cells' detail may hold on the GPU as the game sets it (MB): a large city keeps its far levels and masses for the
 *  whole map, but the detail of the places the camera walked through is bounded (`keepToBudget`), and the road walked does not
 *  grow the memory for ever. The player's panel sets another value; -1 is this one. */
export const GAME_DETAIL_MEMORY_MB = 768;

/** SHADOW CASTERS BY THEIR SIZE IN THE CASCADE (Unreal's r.Shadow.RadiusThreshold, 0.03 at its epic scalability to 0.06 at low: a caster
 *  whose bounding radius is under that share of the shadow's extent casts nothing; the Cities: Skylines II autopsy found 72 % of the draws
 *  were shadows of props at any size and distance). Past the first cascade a part casts only where its widest piece spans this share of
 *  the cascade's half side: the far cascades take the buildings by their walls and masses, never by their balconies and sills. */
const CAST_RADIUS_SHARE = 0.03;

/** A world box (three's axes) as the plan's (x, y, height) to the occlusion's test. */
type PlanTest = (x0: number, y0: number, x1: number, y1: number, z0: number, z1: number) => boolean;
const planHidden = (hidden: PlanTest, box: Box3): boolean =>
  !box.isEmpty() && hidden(box.min.x, -box.max.z, box.max.x, -box.min.z, box.min.y, box.max.y);

/** A group's box in the world from its meshes' own boxes (an instanced part's, a mesh's geometry's put in place), kept while its children
 *  are the same; null where one has none to read (its arrays let go on the GPU: never computed here), and such a group is never hidden. */
function groupBoxReader(): (group: Object3D) => Box3 | null {
  const boxes = new WeakMap<Object3D, { readonly children: number; readonly box: Box3 | null }>();
  const scratch = new Box3();
  return (group) => {
    const known = boxes.get(group);
    if (known && known.children === group.children.length) return known.box;
    let box: Box3 | null = new Box3();
    group.traverse((o) => {
      if (box === null) return;
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const own = mesh instanceof InstancedMesh ? mesh.boundingBox : mesh.geometry.boundingBox;
      if (own === null) { box = null; return; }
      box.union(scratch.copy(own).applyMatrix4(mesh.matrixWorld));
    });
    boxes.set(group, { children: group.children.length, box });
    return box;
  };
}

export function createBuildingLayer(anisotropy = 4): BuildingLayer {
  const kit: BuildingKit = createBuildingKit(anisotropy);
  const group = new Group();
  group.name = 'buildings-layer';
  // Every flag in the city, waving: one instanced draw (`flagLayer.ts`).
  const flagLayer = createFlagLayer();
  group.add(flagLayer.group);
  /** The buildings from afar, a mesh a cell (`massCells.ts`); what it lets go is asked again once wanted (a tile by its levels, a cell by `askExposed`). */
  /** Something the levels' choice reads changed since it last ran (`MassCells`, `MassLevels`, the measures, the town filed again, a level landed or admitted): `levelOfDetail` chooses again. */
  let lodStale = true;
  const lodChanged = (): void => { lodStale = true; };
  const massCells = createMassCells(kit, BATCH_CELL, (key) => {
    if (key[0] === 't' || key[0] === 'p') levels.release(key);
    else massAsked.delete(key);
  }, (key) => !levels.outdated(key), lodChanged);
  group.add(massCells.group);
  const signatureRoot = new Group();
  signatureRoot.name = 'signature-buildings';
  group.add(signatureRoot);
  /** DO NOT keep a map by record (a `WeakMap` of digests, a `Map` of records sent, shown or kept): each building's numbers in columns by its id (`townColumns.ts`): its record's digests with and without its wear (what its masses are made of: `massing.ts` reads no wear, so a cell whose buildings only wore asks no mass again, PRD-02), its box, what is kept of it. A record is read when it comes or changes, and where its cell is made. */
  const columns = new TownColumns();
  /** The document the town was last taken from (`update`): where an id's record is read (`slotNow`, `refFor`). */
  let docNow: RoadDoc | null = null;
  /** An id's slot with its columns those of its record now (read from the document when the diary named it since); -1 when it is not in the document. */
  const slotNow = (id: number): number => {
    const slot = columns.slotOf(id);
    if (slot >= 0 && columns.has(slot, KNOWN)) return slot;
    const b = docNow?.buildings.get(id as BuildingId);
    return b ? columns.file(b) : -1;
  };
  /** A record's digest: its columns' when it is the document's, else worked out (a building drawn on its own). */
  const sigOf = (b: Building): number => {
    const slot = docNow?.buildings.get(b.id) === b ? slotNow(b.id) : -1;
    return slot >= 0 ? columns.sig[slot]! : recordDigests(b).sig;
  };
  const signatures = signatureBodies(signatureRoot);
  group.matrixAutoUpdate = false;
  group.updateMatrix();
  let stored: BuildingMeshes | null = null;
  /** A far cascade's pass in progress (`castInto` coarse): each cell's detail group hidden for it, and whether it was shown before. */
  let shadowCoarse = false;
  const shadowHidden = new Map<Object3D, boolean>();
  let ruined: ReadonlySet<number> = new Set();
  /** What the occlusion hid from this frame's colour pass (`hideOccluded`): shown for the shadow passes inside it, shown again after it. */
  const occluded: Object3D[] = [];
  const groupBox = groupBoxReader();
  /** A mass shown hidden from the colour pass where its box (in the world, `massCells.ts` cellMesh) is behind the walls. */
  const hideMass = (o: Object3D, hidden: PlanTest): void => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || !mesh.visible) return;
    const box = mesh.geometry.boundingBox;
    if (box && planHidden(hidden, box)) occluded.push(mesh);
  };
  /** Moves when the ruins change (`setRuined`), not when the same ones are given again. */
  let ruinedSerial = 0;
  let lastGround: { groundAt: GroundAt; groundKey: string; pavedAt: PavedAt | undefined; naturalAt: GroundAt } | null = null;
  /** DO NOT keep every cell's detail the eye ever came near (`reach = Infinity` in perspective kept it all): it holds what the GPU ledger's cap leaves once every other owner is counted (`room`), and draws no more than that (`MassCells.cap`). */
  let budget = GAME_DETAIL_MEMORY_MB * 1048576;
  const room = (): number => Math.min(budget, gpuLedger.roomFor(DETAIL_CLASSES));
  /** The bytes the cells' levels hold on the GPU, and what each level measured when it last landed (`layerCells.ts`). */
  const resident = new ResidentBytes();
  resident.changed = lodChanged;
  /** THE FRAME'S SCALE (`frameBudget.ts`): the view's budget of triangles, the error scale that fits it. */
  const frame = new FrameScale();
  /** What each cell's level drew when it last landed (`show`): what a level not landed yet is reckoned at. */
  const landedTriangles = new LandedMeasure<BatchKind>(TYPICAL_LEVEL_TRIANGLES);
  landedTriangles.changed = lodChanged;
  landedTriangles.weightOf = (key) => massCells.massTriangles(key);
  /** What each cell's level held when it last landed, bytes: a level never landed counts as its kind's landed do on average (NaN before any: its cell's masses, `capNow`). */
  const landedBytes = new LandedMeasure<BatchKind>({ cell: Number.NaN, facade: Number.NaN });
  landedBytes.changed = lodChanged;
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
  // The facade level's detail parts, one draw a kind for the whole town (`farParts.ts`).
  const farParts = new FarPartBatch(kit);
  partRoot.add(farParts.group);
  // The cells' walls, one multi-draw a material (`shellBatch.ts`).
  const shellBatch = new ShellBatch(kit);
  facadeStored.group.add(shellBatch.facadeGroup);
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
  /** The preview of the last update: its building looked for in the document once the preview is gone (`bridges`). */
  let lastPreview: BuildingPreviewInput | null = null;
  let cutaway: CutawaySpec | null = null;
  /** The preview's and the solid building's tops (`top`), measured once each is made. */
  let ghostTop = -Infinity, soloTop = -Infinity;
  /** A building just placed or edited, drawn whole on its own until a level of its cell holds it (the preview gone, the cell still being made in a worker): never a moment with no building where the player put one. */
  const bridges = new Map<BuildingId, { meshes: BuildingMeshes; cell: string; sig: number; since: number }>();
  /** The longest a bridge stands, ms, whatever the workers do. */
  const BRIDGE_MAX_MS = 20_000;
  /** The eye the parts' levels are chosen for (`cullDetails`), one object for every frame. */
  const partView: { -readonly [K in keyof PartView]: PartView[K] } = { x: 0, y: 0, z: 0, pxAtMetre: 0, orthoPx: null, shadowTexel: Infinity };
  /** HLOD streaming (see the file's comment). */
  const eyeNow = { x: 0, y: 0, z: 0, pxAtMetre: 0, orthoPx: null as number | null, reach: Infinity };
  let eye: typeof eyeNow | null = null;
  /** The view's frustum the cells were last chosen in (`levelOfDetail`): a cell out of it gets no detail (`MassCells.choose`). */
  const eyeView = new Frustum();
  let viewKnown = false;
  const cellOf = (b: Building): string => `${Math.floor(b.x / BATCH_CELL)},${Math.floor(b.y / BATCH_CELL)}`;
  /** The shown town by cell (ids), kept between changes, as of the diary's `townSeen` in `townDoc`. */
  const town = new TownIndex(columns);
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
    shellBatch.setVisible('cell', key, level === 'cell');
    shellBatch.setVisible('facade', key, level === 'facade');
    const p0 = partCells.get(key), p1 = facadeParts.get(key);
    if (p0 && level !== 'cell') p0.group.visible = false;
    if (p1 && level !== 'facade') p1.group.visible = false;
    massCells.setDetailed(key, level !== null);
  };
  const chooseNow = (): void => {
    lodStale = true;
    chooseRaw();
  };
  const chooseRaw = (): void => {
    if (eye) massCells.choose(eye.x, eye.y, eye.z, eye.pxAtMetre, eye.orthoPx, forcedNear, eye.reach, viewKnown ? eyeView : null);
  };
  /** The detail drawn within the room the ledger leaves (`MassCells.cap`): a level never landed counts as its kind's landed do on average, and before any of its kind landed as its cell's masses. DO NOT reckon it at a fixed number (64 MB each capped every cell before one came), nor at the masses once a level of its kind measured (the facade level holds 4-5 times its masses: the cap asked too many and the admission threw whole jobs away). */
  const capNow = (): void => {
    lodStale = true;
    capRaw();
  };
  const capRaw = (): void => {
    if (!eye) return;
    massCells.cap(eye.x, eye.y, room(), (key, fine) => {
      const kind: BatchKind = fine ? 'cell' : 'facade';
      const mean = landedBytes.of(kind, key);
      return resident.of(kind, key, Number.isNaN(mean) ? massCells.massBytes(key) : mean);
    }, forcedNear);
  };
  /** The shown buildings' ids by coarse cell, as last put together (`update`): what a cell streamed in is made of. */
  let townCells = new Map<string, number[]>();
  /** What the levels chosen draw, triangles: each near cell's level (shown, or as its kind is reckoned until it lands), and every mass resident (the cells', tiles' and plates': those hidden under a cell's detail counted too, so never under what is drawn). */
  const chosenTriangles = (): number => {
    // DO NOT count every mass on the GPU: a cell in detail was counted twice, by its level and by its masses hidden under it (the view over its budget, cells cut that fit, conferencia 40).
    let n = massCells.farTriangles();
    for (const key of massCells.nearKeys()) {
      const level = levelShown(key);
      if (level === 'cell') n += cells.get(key)!.part.triangles + (partCells.get(key)?.triangles ?? 0);
      else if (level === 'facade') n += facades.get(key)!.part.triangles + (facadeParts.get(key)?.triangles ?? 0) + farParts.trianglesOf(key);
      else if (townCells.has(key)) n += landedTriangles.of(massCells.fine(key) ? 'cell' : 'facade', key);
    }
    return n;
  };
  /** DO NOT fit the view's budget of triangles by raising one error scale for the whole view: every cell coarsened at once, the ones at the eye fell to their facade level; the farthest go first (`MassCells.cap`, as the bytes' budget), detail to facade level to masses, the nearest kept in detail */
  /** The cells the budget held back, remembered (`MassCells.hold`): a cell capped stays capped until its next level fits the budget with what the view draws, then comes back a level, the ones spanning most of the screen first (let all back at once, the view passed the budget again and they were capped again: the city blinked, cells loaded and unloaded by turns). */
  const heldFar = new Set<string>(), heldCoarse = new Set<string>();
  /** What the frame's last choice read (`levelOfDetail`), the levels it left, and whether it left them as the one before it with the same reading (settled). */
  const lodRead = new Float64Array(10), lodLast = new Float64Array(10).fill(Number.NaN);
  const lodView = new Frustum();
  let lodForced: ReadonlySet<string> | null = null, lodChoice = '', lodSettled = false;
  /** The levels chosen, as a string: the scale, each near cell and whether at full detail, the cells held. */
  const lodChosen = (): string => {
    let out = `${frame.scale}|`;
    for (const key of massCells.nearKeys()) out += `${key}${massCells.fine(key) ? '+' : '-'};`;
    out += '|';
    for (const key of heldFar) out += `${key};`;
    out += '|';
    for (const key of heldCoarse) out += `${key};`;
    return out;
  };
  /** How far down the order the budget coarsens in a cell stands (`MassCells.cap`): the less a metre spans there, the sooner it goes; DO NOT rank it by its distance to the eye's point on the plan (two cells alike either side of it were ranked apart). */
  const rankOf = (key: string): number => -massCells.pixels(key, 1);
  const capTriangles = (): void => {
    if (!eye || !Number.isFinite(frame.budget)) return;
    const masses = massCells.farTriangles();
    const fineBefore = new Map<string, boolean>();
    for (const key of massCells.nearKeys()) fineBefore.set(key, massCells.fine(key));
    massCells.cap(eye.x, eye.y, frame.budget - masses, (key, fine) => landedTriangles.of(fine ? 'cell' : 'facade', key), forcedNear, (key) => massCells.massTriangles(key));
    for (const [key, wasFine] of fineBefore) {
      if (!massCells.near(key)) heldFar.add(key);
      else if (wasFine && !massCells.fine(key)) heldCoarse.add(key);
    }
    // The eye moved: a cell held that spans more of the screen than one the budget keeps goes back to the view (the one spanning least is capped in its place).
    letGoPassed(heldFar, heldCoarse, [...massCells.nearKeys()].map((key) => ({ key, fine: massCells.fine(key) })), rankOf);
    // Each held cell a level back while the view with it still fits (`letBackFitting`), not only under a share of the budget.
    if (heldFar.size || heldCoarse.size) {
      letBackFitting(heldFar, heldCoarse, chosenTriangles(), frame.budget, rankOf, (key, far) =>
        (far ? landedTriangles.of('facade', key) - massCells.massTriangles(key) : landedTriangles.of('cell', key) - landedTriangles.of('facade', key)));
    }
    massCells.hold(heldFar, heldCoarse);
  };
  /** The cells whose batches must be made for the town as it is now, shown as they land (`landCells`). */
  const pendingCells = new Set<string>();
  /** The town behind its curtain (`hidden`). */
  let hiddenNow = false;
  /** DO NOT let a far cell's detail go */
  let shownNear = new Set<string>();
  /** Over the budget, the cells drawn far let go, those spanning least of the screen first (`rankOf`): their masses, on the GPU already, stand for them */
  const keepToBudget = (): void => {
    const budget = room();
    if (resident.total <= budget || !eye || !stored) return;
    // The levels not shown, the detail first: a cell drawn at its facade level lets its detail go before any facade level goes.
    for (const kind of ['cell', 'facade'] as const) {
      const cache = kind === 'cell' ? cells : facades;
      const far = [...cache.keys()].filter((key) => levelShown(key) !== kind && !pendingCells.has(key)).sort((a, b) => rankOf(b) - rankOf(a));
      for (const key of far) {
        if (resident.total <= budget) return;
        shellBatch.remove(kind, key);
        if (kind === 'cell') { dropCell(cells, key, stored); dropParts(partCells, key, partRoot); }
        else { dropCell(facades, key, facadeStored); dropParts(facadeParts, key, partRoot); }
      }
    }
  };
  /** DO NOT read the ground building by building for the whole map, nor keep a digest a building in a `Map`: ONE GROUND DIGEST A CELL, of what its buildings stand on, content-addressed (the heights and roads there, never a serial of the session), so the masses and floors kept on disk under it (`cellPool.ts` `storedKey`) are found again only on the same ground after a reopen, and a cell's digest is whole or not worked out at all. Given `groundDigestOf` (the page's, `renderer.ts`: on level land the roads' profiles round the cell, the ground there the level cut to them; off it the terrain's own heights by content) no height is read; without one (a spec) each building's ground sampled as `groundDigest` samples it. Worked out when a cell is first asked, again when its buildings or the ground under them changed. */
  const cellGround = new Map<string, number>();
  /** How a cell's ground is digested as the last `update` was given it. */
  let groundNow: { groundAt: GroundAt; pavedAt?: PavedAt | undefined; digestOf: GroundDigestOf | null } = { groundAt: () => 0, digestOf: null };
  const digestOfCell = (cell: string): number => {
    let digest = cellGround.get(cell);
    if (digest !== undefined) return digest;
    const ids = town.byCell.get(cell);
    const { groundAt, pavedAt, digestOf } = groundNow;
    const out = new Digest();
    if (ids && digestOf) {
      // The box of the ground its buildings read: each one's box grown as `groundDigest` grows it.
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const id of ids) {
        const slot = slotNow(id);
        if (slot < 0) continue;
        x0 = Math.min(x0, columns.groundMinX[slot]!); y0 = Math.min(y0, columns.groundMinY[slot]!);
        x1 = Math.max(x1, columns.groundMaxX[slot]!); y1 = Math.max(y1, columns.groundMaxY[slot]!);
      }
      if (x0 <= x1) out.add(digestOf(x0, y0, x1, y1));
    } else if (ids) {
      for (const id of ids) {
        const slot = slotNow(id);
        if (slot >= 0) out.add(boxGroundDigest(columns.groundMinX[slot]!, columns.groundMinY[slot]!, columns.groundMaxX[slot]!, columns.groundMaxY[slot]!, groundAt, pavedAt));
      }
    }
    digest = out.value();
    cellGround.set(cell, digest);
    return digest;
  };
  const near = (slot: number): boolean => {
    if (!cutaway) return false;
    if (cutaway.only !== undefined) return columns.idOf(slot) === cutaway.only;
    const dx = Math.max(columns.minX[slot]! - cutaway.x, 0, cutaway.x - columns.maxX[slot]!);
    const dy = Math.max(columns.minY[slot]! - cutaway.y, 0, cutaway.y - columns.maxY[slot]!);
    return Math.hypot(dx, dy) <= cutaway.radius;
  };
  /** A building as the workers are sent it: its key, its record's digest and its cell's ground digest (none of its record). */
  const entryFor = (slot: number, digest: number): CellEntry => {
    const id = columns.idOf(slot), sig = columns.sig[slot]!;
    if (!(cutaway && near(slot))) return { key: String(id), sig, digest };
    const dir = Math.round(Math.atan2(cutaway.view.y, cutaway.view.x) / (Math.PI / 4));
    return { key: `${id}|${cutaway.level}|${dir}`, sig: new Digest().add(sig).add(cutaway.level).add(dir).value(), digest };
  };
  /** Where a worker reads each record (`layerCells.ts` `recordRef`), found when its job is asked: the table's buffer and row while the record is the table's own (nothing decoded on the page), else the record the document holds (written, or cut open). DO NOT keep the records sent in a map by key: every building of the map was held decoded there. */
  const refFor = (entry: CellEntry): () => RecordRef => {
    const bar = entry.key.indexOf('|');
    const id = Number(bar < 0 ? entry.key : entry.key.slice(0, bar)) as BuildingId;
    const ref = bar < 0 ? docNow?.buildings.tableRef(id) ?? null : null;
    if (ref) return () => ref;
    const b = docNow?.buildings.get(id);
    if (!b) throw new Error(`[buildings] a job asked for building ${id}, not in the document`);
    return () => recordRef(b, entry.key);
  };
  const entriesOf = (cell: string, ids: readonly number[]): CellEntry[] => {
    const digest = digestOfCell(cell);
    const out: CellEntry[] = [];
    for (const id of ids) { const slot = slotNow(id); if (slot >= 0) out.push(entryFor(slot, digest)); }
    return out;
  };
  /** Each pending cell's entries as last made, and what they were made from: DO NOT make them again every frame while the cell waits (4.8 s of the opening's page in entryFor, wprof4): the same buildings (let go when the cell's buildings change, `update`), ground and cut-open view give the same entries. */
  const cellEntries = new Map<string, { readonly digest: number; readonly cut: string; readonly entries: CellEntry[] }>();
  /** What a cell's entries read of the cut-open view (`near`, `entryOf`), exactly: DO NOT compare the spec by identity, the wiring hands a new one every frame and every pending cell's entries were made again (PRD-12). */
  const cutOf = (c: CutawaySpec | null): string => c ? `${c.only ?? ''}:${c.level}:${c.x}:${c.y}:${c.radius}:${Math.round(Math.atan2(c.view.y, c.view.x) / (Math.PI / 4))}` : '';
  const entriesFor = (cell: string, ids: readonly number[]): CellEntry[] => {
    const known = cellEntries.get(cell);
    const cut = cutOf(cutaway), digest = digestOfCell(cell);
    if (known && known.digest === digest && known.cut === cut) return known.entries;
    const entries = entriesOf(cell, ids);
    cellEntries.set(cell, { digest, cut, entries });
    return entries;
  };
  /** What the page keeps of each building the workers emitted that says anything (`Kept`); the digests it was made for in the columns (`KEPT`). */
  const kept = new Map<BuildingId, Kept>();
  /** DO NOT walk `kept` for a point: `anyLotHeightAt` is asked for every walker every frame */
  const lotFiling = new CellFiling<BuildingId, Kept>();
  const putKept = (slot: number, sig: number, digest: number, summary: ChunkSummary, pavedAt: PavedAt | undefined): void => {
    const id = columns.idOf(slot) as BuildingId;
    columns.keptSig[slot] = sig;
    columns.keptDigest[slot] = digest;
    columns.set(slot, KEPT, true);
    if (summary.flags || summary.lot || summary.signatureFloor !== undefined) kept.set(id, { id, summary, ...(pavedAt ? { pavedAt } : {}) });
    else kept.delete(id);
    flagsFor(id);
    const k = kept.get(id);
    if (!k?.summary.lot) { lotFiling.remove(id); return; }
    lotFiling.file(id, k, [columns.minX[slot]!, columns.minY[slot]!, columns.maxX[slot]!, columns.maxY[slot]!]);
  };
  const dropKept = (id: BuildingId): void => {
    columns.set(columns.slotOf(id), KEPT, false);
    kept.delete(id);
    flagsFor(id);
    lotFiling.remove(id);
  };
  let flagsMoved = false;
  /** DO NOT walk every shown building for its flags at each summary that lands */
  const flagsOf = new Map<BuildingId, readonly FlagInstance[]>();
  const flagsFor = (id: BuildingId): void => {
    const flags = columns.has(columns.slotOf(id), SHOWN) ? kept.get(id)?.summary.flags : undefined;
    if (flags === flagsOf.get(id)) return;
    if (flags) flagsOf.set(id, flags); else flagsOf.delete(id);
    flagsMoved = true;
  };
  const keep = (summaries: readonly ChunkSummary[], entries: readonly CellEntry[], env: CellEnv): void => {
    const byKey = new Map(entries.map((e) => [e.key, e]));
    for (const s of summaries) {
      const entry = byKey.get(s.key);
      // A building cut open: its flags and lots are those of the whole one.
      if (!entry || s.key.includes('|')) continue;
      const slot = columns.slotOf(Number(s.key));
      if (slot < 0) continue;
      putKept(slot, entry.sig, entry.digest, s, env.pavedAt);
    }
  };
  /** A kept building's lots' ground, made once from its record (read from the document, then let go) while what is kept was made for that record; null while it was not (its new summary not come). */
  const lotOf = (k: Kept): LotGround | null => {
    if (k.lot !== undefined) return k.lot;
    const slot = slotNow(k.id);
    const b = slot >= 0 && columns.keptSig[slot] === columns.sig[slot] ? docNow?.buildings.get(k.id) : undefined;
    if (!b) return null;
    return k.lot = lotGroundAgain(b, k.summary.lot!, k.pavedAt) ?? null;
  };
  /** Whether what is kept of a building was made for its record and the ground under it now; its summary (none when it said nothing). */
  const keptFor = (slot: number): { readonly summary?: ChunkSummary } | undefined => {
    if (!columns.has(slot, KEPT) || columns.keptSig[slot] !== columns.sig[slot]) return undefined;
    if (columns.keptDigest[slot] !== digestOfCell(columns.cellOf(slot))) return undefined;
    const k = kept.get(columns.idOf(slot) as BuildingId);
    return k ? { summary: k.summary } : {};
  };
  const pool = new CellPool(() => kitBoxes(kit), (entry) => refFor(entry), true, kit.finishTone);
  pool.warm();
  /** A cell's level landed: uploaded only if the view still wants it at that level within the room (the cap worked out again with its measured bytes). */
  const admit = (kind: BatchKind, cell: string, bytes: number): boolean => {
    resident.landed(kind, cell, bytes);
    landedBytes.set(kind, cell, bytes);
    if (forcedNear.has(cell) || !eye) return true;
    capNow();
    return massCells.near(cell) && (massCells.fine(cell) ? 'cell' : 'facade') === kind;
  };
  /** A landing's upload ranked by the pixels the masses standing for it leave out (`uploads.ts`). */
  const rank = (_kind: BatchKind, cell: string): number => massCells.pixels(cell, FAR_ERROR);
  // What a level asked will bring to the upload queue: as its kind's landed measured (`landedBytes`), its cell's masses before any did.
  const requests = new CellRequests(pool, kit, keep, admit, rank, (kind, cell) => { const mean = landedBytes.of(kind, cell); return Number.isNaN(mean) ? massCells.massBytes(cell) : mean; });
  /** The tiles' (L2) and plates' (L3) masses, asked again only where a cell's buildings changed (`massLevels.ts`). */
  const levels = new MassLevels(pool, (key, mass) => { massCells.landLevel(key, mass); chooseNow(); }, (key) => massCells.removeLevel(key),
    (key) => massCells.planLevel(key), (key) => massCells.wanted(key));
  levels.changed = lodChanged;
  // The base over each plate's square (the top level, `massBase.ts`): asked first, kept for good, drawn wherever nothing finer is.
  levels.landBase = (key, base) => { massCells.landBase(key, base); chooseNow(); };
  // Behind the curtain a tile or a plate out of the view is not asked: the workers make what the opening's picture draws first (`coarsePending`), the rest nearest first once it is shown.
  // One let go for the budget (`massBudget`) waits for the view to meet it again and want it whole (`askable`): DO NOT ask it back at once, to be let go again.
  levels.deferred = (key) => (hiddenNow && !massCells.levelSeen(key)) || !massCells.askable(key);
  // A plate with no masses of its own is a hole in the map (the corners of a city opened on its middle, step-25k 08-early-map): before the view's detail.
  levels.hole = (key) => key[0] === 'p' && !massCells.levelDrawn(key);
  /** The most the town's masses (cells, tiles, plates) hold on the GPU, bytes (`quality.ts` GEOMETRY_BUDGETS): past it the levels out of the view go, least recently seen first. */
  let massBudget = Infinity;
  // The plates waiting asked nearest the eye first (`massLevels.ts` PLATES_IN_FLIGHT).
  levels.away = (key) => {
    if (!eye) return 0;
    const { i0, j0, n } = levelCells(key);
    return Math.hypot((i0 + n / 2) * BATCH_CELL - eye.x, (j0 + n / 2) * BATCH_CELL - eye.y);
  };
  /** Each cell's buildings as last filed (`askMass`), packed (`PackedEntries`: ids and digests in typed arrays, no object a building), and as last asked of the workers for its own masses: asked only while the view draws the cell one by one (`askExposed`). */
  const massEntries = new Map<string, PackedEntries>();
  /** The cells the player's edit changed since their jobs were last asked (a road demolishing buildings, in its own tile or the next): their detail and masses asked first (`cellPool.ts` EDIT_TIER), in whichever tile. DO NOT put the growth here: every building grown ahead of the queue held the view's detail behind it (the near tiles, conf23). */
  const editedCells = new Set<string>();
  const massAsked = new Map<string, PackedEntries>();
  /** DO NOT ask every cell's masses of the map at the opening: only the cells the view draws one by one (their tile refined, `massCells.exposedCells`), their plate or tile standing for the rest */
  const askExposed = (env: CellEnv): void => {
    for (const cell of massCells.exposedCells()) {
      const entries = massEntries.get(cell);
      if (!entries || massAsked.get(cell) === entries) continue;
      // The upload queue full (`warmFull`): left for the next frame, nothing marked asked.
      if (!requests.mass(cell, unpack(entries), env, (mass) => {
        massCells.land(cell, mass);
        chooseNow();
      }, editedCells.has(cell))) return;
      massAsked.set(cell, entries);
    }
  };
  /** The far buildings flying a flag not emitted yet (ids): their summaries asked of the workers in the frames' spare slices */
  let backlog: number[] = [];
  const flyFlags = (): void => {
    const flags: FlagInstance[] = [];
    for (const list of flagsOf.values()) flags.push(...list);
    flagLayer.set(flags);
    flagsMoved = false;
  };
  /** DO NOT mass the buildings on the page */
  const askMass = (cell: string, groundAt: GroundAt): void => {
    const list = town.byCell.get(cell);
    if (!list?.length) {
      requests.dropMass(cell); massCells.remove(cell); levels.touch(cell, null, editedCells.has(cell)); massEntries.delete(cell); massAsked.delete(cell);
      resident.forget(cell);
      // Gone from the town: nothing of it kept by the budget either (its measures, held back or not).
      landedTriangles.forget(cell); landedBytes.forget(cell); heldFar.delete(cell); heldCoarse.delete(cell);
      return;
    }
    // Its height till its masses come: the ground under its buildings to the highest roof (the view's frustum, `MassCells.choose`).
    let bottom = Infinity, top = -Infinity;
    const ids = new Float64Array(list.length), sigs = new Float64Array(list.length);
    let n = 0;
    for (const id of list) {
      const slot = slotNow(id);
      if (slot < 0) continue;
      const ground = groundAt(columns.x[slot]!, columns.y[slot]!);
      if (ground < bottom) bottom = ground;
      top = Math.max(top, ground + columns.height[slot]!);
      ids[n] = id; sigs[n] = columns.massSig[slot]!; n++;
    }
    massCells.plan(cell, bottom, top);
    const entries: PackedEntries = { ids: n === ids.length ? ids : ids.slice(0, n), sigs: n === sigs.length ? sigs : sigs.slice(0, n), digest: digestOfCell(cell) };
    // The same buildings on the same ground (their wear changed alone): its masses stand, asked of nobody again.
    const was = massEntries.get(cell);
    if (was && samePacked(was, entries)) return;
    // Its tile and plate asked again once every cell changed is touched (`levels.flush`); its own masses once the view draws it alone (`askExposed`).
    levels.touch(cell, entries, editedCells.has(cell));
    massEntries.set(cell, entries);
  };
  /** A shown building's signature body (`signature.ts`), its record read for it (the few signature buildings only); none for the rest. */
  const showSignature = (doc: RoadDoc, slot: number, k: { readonly summary?: ChunkSummary } | undefined, naturalAt: GroundAt, pavedAt: PavedAt | undefined): void => {
    const id = columns.idOf(slot) as BuildingId;
    const b = columns.has(slot, SIGNATURE) ? doc.buildings.get(id) : undefined;
    if (!b) { signatures.remove(id); return; }
    signatures.set(b, columns.sig[slot]!, k?.summary?.signatureFloor ?? signatureFloorOf(b, naturalAt, pavedAt));
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
    // The cell's walls go into the multi-draw batch of their material before its group is put in the scene.
    if (landed?.batch) shellBatch.add(kind, key, landed.batch);
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
  const landCells = (env: CellEnv): boolean => {
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
          shellBatch.remove(kind, cell);
          patchCell(cell, null, shownAt(kind));
          requests.drop(kind, cell);
        }
        pendingCells.delete(cell);
        cellEntries.delete(cell);
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
            if ((kind === 'cell' ? cells : facades).has(cell)) { shellBatch.remove(kind, cell); patchCell(cell, null, shownAt(kind)); changed = true; }
          }
        } else {
          const entries = entriesFor(cell, list);
          // The level the eye wants of it; the other's request, if any, let go (what landed of it was never taken).
          const kind: BatchKind = cellFine(cell) ? 'cell' : 'facade';
          requests.drop(kind === 'cell' ? 'facade' : 'cell', cell);
          const known = (kind === 'cell' ? cells : facades).get(cell);
          // DO NOT keep the other level of a cell whose buildings changed: the eye coming back to it found it "made" and drew the buildings as they were (an edited tower shown with its old floors when zoomed out, the player 2026-10-20); let go once the level wanted is current, made again when wanted.
          const otherKind: BatchKind = kind === 'cell' ? 'facade' : 'cell';
          const other = (otherKind === 'cell' ? cells : facades).get(cell);
          if (known && sameEntries(known.entries, entries) && other && !sameEntries(other.entries, entries)) {
            shellBatch.remove(otherKind, cell);
            patchCell(cell, null, shownAt(otherKind));
            changed = true;
          }
          if (known && sameEntries(known.entries, entries)) requests.drop(kind, cell);
          else {
            done = false;
            // A hole: wanted in detail and no level of it landed (its masses at the camera). DO NOT hold it behind `STREAM_AHEAD` cells asked before it (the district's, waiting behind a reopening's re-bake): it is asked past them, `MOST_HOLES` at once (conferencia 109, picture 51).
            const hole = kind === 'cell' && !cells.has(cell) && !facades.has(cell);
            if (requests.isAsked(kind, cell) || requests.asking < STREAM_AHEAD || (hole && requests.holeRoom())) {
              const got = requests.want(kind, cell, entries, env, true, editedCells.has(cell), hole);
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
      if (done) { pendingCells.delete(cell); cellEntries.delete(cell); editedCells.delete(cell); }
    }
    // Nothing near to make: the far buildings' flags (the workers take them after the cells and masses).
    if (pendingCells.size === 0 && backlog.length) {
      const byCell = new Map<string, number[]>();
      while (backlog.length) {
        const id = backlog.pop()!;
        const slot = slotNow(id);
        if (slot < 0 || !town.has(id) || keptFor(slot)) continue;
        const cell = columns.cellOf(slot);
        const list = byCell.get(cell);
        if (list) list.push(id); else byCell.set(cell, [id]);
      }
      for (const [cell, list] of byCell) requests.summarize(cell, entriesOf(cell, list), env);
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
      return Math.max(massCells.top(), signatures.top(), ghostTop, soloTop);
    },
    get pending() {
      // What the view draws, not the whole map: the cells near, the cells drawn one by one, the tiles and plates standing for the rest.
      // And a choice not settled yet (a held cell let back a level, `levelOfDetail`): the frames are drawn on demand, and a still view asked none, the cells let back stood in their masses until the camera moved.
      return pendingCells.size > 0 || requests.massing > 0 || massCells.waiting > 0 || (eye !== null && !lodSettled);
    },
    get coarsePending() {
      // The levels in the view's frustum only: DO NOT hold the opening for every plate of the map (a city of 25,000 buildings waited for nine plates of 2 km, 16 s of the workers, when its view drew none of them, step-25k 2026-10-21); those out of view come after the curtain, nearest first.
      // And every base of the map (`massBase.ts`): the town has no hole once they are in, whatever the view does after the curtain (the map pulled back to at once showed its corners empty for seconds, step-25k 2026-10-21). Their floors are the masses' that follow.
      return requests.massing > 0 || massCells.waitingInView > 0 || massCells.basesWaiting > 0;
    },
    get viewPending() {
      // The cells the view wants in detail (near, in its frustum, `massCells.nearKeys`) whose detail has not landed.
      return pendingCells.size > 0;
    },
    // DO NOT put the view's detail behind the masses while the curtain is up (`CellPool.coarseFirst`): the curtain waits for it (`viewPending`, CLAUDE.md "abrir"), and behind every mass and far level it held the opening or let it fall with the view in masses (conf130/131, conf133). The cells asked are only those the view wants near (`massCells.nearKeys`).
    get hidden() {
      return hiddenNow;
    },
    set hidden(on: boolean) {
      hiddenNow = on;
    },
    kit,
    chunkOf(b) {
      if (!lastGround) return null;
      const { groundAt, pavedAt, naturalAt } = lastGround;
      // One building asked for at once (a ruin): emitted here.
      return { chunk: emitChunk(b, groundAt, pavedAt, naturalAt), kit };
    },
    update(doc, groundAt, groundKey, pavedAt, naturalAt = groundAt, groundMovedUnder, groundDigestOf = null) {
      lastGround = { groundAt, groundKey, pavedAt, naturalAt };
      // The cells' ground digested another way (level land or not, `renderer.ts` levelGroundDigest and landGroundDigest): every cell's digest worked out again.
      if (groundDigestOf !== groundNow.digestOf) cellGround.clear();
      groundNow = { groundAt, pavedAt, digestOf: groundDigestOf };
      // Another document: its ids are other buildings.
      if (doc !== docNow) docNow = doc;
      // The plants' cover follows the buildings' diary cell by cell, and is derived ahead round the eye (`layerCells.ts`, `viewCells.ts`).
      cover.follow(doc);
      if (eye) cover.look(eye.x, eye.y);
      const env: CellEnv = { groundAt, naturalAt, ...(pavedAt ? { pavedAt } : {}) };
      const hides = preview?.hides ?? null;
      const cutKey = cutaway
        ? `${cutaway.only ?? ''}:${cutaway.level}@${Math.round(cutaway.x)},${Math.round(cutaway.y)}/${Math.round(Math.atan2(cutaway.view.y, cutaway.view.x) / (Math.PI / 4))}`
        : 'whole';
      // DO NOT put them back in this key: every road edit
      const key = `${doc.buildings.revision}:${doc.buildings.wearRevision}|${groundKey}|${hides}|${ruinedSerial}|${String(dimmed)}`;
      /** A building drawn in its cell: not the one the preview stands for, nor a ruin, nor the one left solid while the others fade. */
      const inCell = (id: number): boolean => id !== hides && !ruined.has(id) && !(typeof dimmed === 'number' && id === dimmed);
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
          // Their records read again when next asked (`slotNow`).
          for (const id of named) columns.stale(id);
          /** The buildings whose place, shape or ground changed (not their wear alone): their cells' ground digested again (it reads their boxes). */
          const reshaped = new Set<number>();
          for (const e of changed) if (e.kind !== 'buildingWear') for (const id of e.ids!) reshaped.add(id);
          for (const b of groundMoved) { named.push(b.id); reshaped.add(b.id); }
          // The one the preview hid and the one it hides now; the ruins that came and went.
          const shown: number[] = [];
          if (hides !== storedHides) for (const id of [storedHides, hides]) if (id !== null) shown.push(id);
          if (ruined !== storedRuined) {
            for (const id of ruined) if (!storedRuined.has(id)) shown.push(id);
            for (const id of storedRuined) if (!ruined.has(id)) shown.push(id);
          }
          // The one left solid before and now: out of its cell, or back in it.
          if (dimmed !== storedDimmed) for (const id of [storedDimmed, dimmed]) if (typeof id === 'number') shown.push(id);
          for (const id of shown) { named.push(id as BuildingId); reshaped.add(id); }
          // The buildings the player's edit changed (the diary's cause, `main.ts` mutateBuilt and undo): their cells asked first, in whichever tile.
          const byPlayer = new Set<number>();
          for (const e of changed) if (playerCause(e.cause)) for (const id of e.ids!) byPlayer.add(id);
          for (const id of named) {
            const slot = slotNow(id);
            const own = new Set<string>();
            town.take(id, slot >= 0 && inCell(id) ? slot : -1, own);
            for (const cell of own) {
              dirty.add(cell);
              if (byPlayer.has(id)) editedCells.add(cell);
              if (reshaped.has(id)) cellGround.delete(cell);
            }
            ids.add(id);
          }
          townSeen = doc.changes.version;
          cutCells = cutCellsOf(doc, cutaway);
          forcedNear = forcedCells(doc);
          // Some buildings changed: their cells' masses asked again and their detail made again, each shown as it lands
          for (const cell of dirty) { cellEntries.delete(cell); askMass(cell, groundAt); pendingCells.add(cell); }
          levels.flush(env);
          chooseNow();
          // The buildings gone from the document: their floors let go after the loop (`cellPool.ts` `forgetFloors`).
          const gone = new Set<string>();
          for (const id of ids) {
            const slot = slotNow(id);
            if (slot < 0) { dropKept(id); gone.add(String(id)); }
            if (slot < 0 || !town.has(id)) {
              columns.set(columns.slotOf(id), SHOWN, false);
              flagsFor(id);
              signatures.remove(id);
              if (slot < 0) columns.drop(id);
              continue;
            }
            columns.set(slot, SHOWN, true);
            flagsFor(id);
            const k = keptFor(slot);
            if (!k && columns.has(slot, FLIES)) backlog.push(id);
            showSignature(doc, slot, k, naturalAt, pavedAt);
          }
          if (gone.size) pool.forgetFloors((key) => !gone.has(key.split('|')[0]!));
        } else {
          // @rebuild The whole town filed again (a first look, or a diary that cannot say what changed).
          if (stored) {
            group.remove(stored.group);
            stored.dispose();
          }
          // DO NOT hold the whole town's records while it is filed (`[...doc.buildings.all()]` held every one decoded): each record read once, its numbers put in its columns, let go.
          columns.forEach((_id, slot) => { columns.flags[slot]! &= ~KNOWN; });
          const solid: number[] = [];
          for (const b of doc.buildings.all()) {
            const slot = columns.file(b);
            const shown = b.id !== hides && !ruined.has(b.id);
            columns.set(slot, SHOWN, shown);
            if (shown && inCell(b.id)) solid.push(slot);
          }
          town.reset(solid);
          // The ids no longer in the document (not filed again by the walk): what was kept of them let go, their slots with it.
          const goneIds: number[] = [];
          columns.forEach((id, slot) => { if (!columns.has(slot, KNOWN)) goneIds.push(id); });
          for (const id of goneIds) { dropKept(id as BuildingId); columns.set(columns.slotOf(id), SHOWN, false); flagsFor(id as BuildingId); columns.drop(id); }
          // The floors measured by the workers (`cellPool.ts`), of the buildings still in the document only.
          pool.forgetFloors((key) => doc.buildings.has(Number(key.split('|')[0]) as BuildingId));
          townCells = town.byCell;
          lodStale = true;
          [townSeen, townDoc] = [doc.changes.version, doc];
          // Every cell's ground digested again, its entries made again.
          cellGround.clear();
          cellEntries.clear();
          // The far level: every cell's masses asked, the cells with no building left gone.
          for (const cell of [...massCells.keys()]) if (!town.byCell.has(cell)) askMass(cell, groundAt);
          for (const cell of town.byCell.keys()) askMass(cell, groundAt);
          levels.flush(env);
          cutCells = cutCellsOf(doc, cutaway);
          forcedNear = forcedCells(doc);
          chooseNow();
          // Only the cells drawn near have their detail; the rest stand as their masses
          for (const cell of [...cells.keys()]) {
            if (townCells.has(cell) && cellNear(cell)) continue;
            shellBatch.remove('cell', cell);
            dropCell(cells, cell, null);
            dropParts(partCells, cell, partRoot);
          }
          for (const cell of [...facades.keys()]) {
            if (townCells.has(cell) && cellNear(cell)) continue;
            shellBatch.remove('facade', cell);
            dropCell(facades, cell, facadeStored);
            dropParts(facadeParts, cell, partRoot);
          }
          stored = cellGroup(cells);
          group.add(stored.group);
          stored.group.add(shellBatch.detailGroup);
          // DO NOT only clear the set: the requests stayed asked, held `STREAM_AHEAD`, and what landed was never taken.
          const wanted = new Set([...townCells.keys()].filter(cellNear));
          for (const cell of pendingCells) if (!wanted.has(cell)) { requests.drop('cell', cell); requests.drop('facade', cell); }
          pendingCells.clear();
          for (const cell of wanted) pendingCells.add(cell);
          // Signature buildings: their bodies, drawn with parts of their own (`signature.ts`); their records read, the few there are.
          for (const slot of solid) if (columns.has(slot, SIGNATURE)) showSignature(doc, slot, keptFor(slot), naturalAt, pavedAt);
          signatures.keepOnly((id) => town.has(id) && columns.has(columns.slotOf(id), SIGNATURE));
          for (const id of [...flagsOf.keys()]) flagsFor(id);
          for (const id of kept.keys()) flagsFor(id);
          // Far buildings flying a flag only (all: ~7 ms a frame for 40 s, 2026-10-14).
          backlog = [];
          columns.forEach((id, slot) => { if (columns.has(slot, SHOWN) && columns.has(slot, FLIES) && !keptFor(slot)) backlog.push(id); });
        }
        storedKey = key;
        // "Hide the others" turned on or off: every cell shown faded or made solid by its materials alone.
        if ((dimmed !== undefined) !== (storedDimmed !== undefined)) {
          for (const cache of [cells, facades]) for (const cell of cache.values()) fadeMeshes(cell.part.group, kit, dimmed !== undefined);
          for (const map of [partCells, facadeParts]) for (const cell of map.values()) cell.setFaded(dimmed !== undefined);
          farParts.setFaded(dimmed !== undefined);
          shellBatch.setFaded(dimmed !== undefined);
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
      if (stored && landCells(env)) {
        rebuilt = true;
        keepToBudget();
      }
      // The masses out of the view let go past the budget (a ledger's sum when under it).
      if (Number.isFinite(massBudget) && massCells.evictLevels(massBudget) > 0) lodStale = true;
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
      // The preview's building is in the document now (placed, or its edit committed): drawn as it is until its cell's level holds it.
      if (wanted !== ghostKey && ghost && lastPreview) {
        const placed = doc.buildings.get(lastPreview.building.id);
        if (placed && placed.id !== preview?.hides && inCell(placed.id) && !bridges.has(placed.id)) {
          const meshes = buildBuildingMeshes([placed], groundAt, kit, false, pavedAt, naturalAt);
          group.add(meshes.group);
          bridges.set(placed.id, { meshes, cell: cellOf(placed), sig: sigOf(placed), since: performance.now() });
        }
      }
      lastPreview = preview;
      for (const [id, bridge] of bridges) {
        const b = doc.buildings.get(id);
        const level = cells.get(bridge.cell) ?? facades.get(bridge.cell);
        const held = level !== undefined && !pendingCells.has(bridge.cell) && level.entries.some((e) => e.key === String(id));
        const far = !cellNear(bridge.cell) && requests.massing === 0;
        if (!b || sigOf(b) !== bridge.sig || held || far || performance.now() - bridge.since > BRIDGE_MAX_MS) {
          group.remove(bridge.meshes.group);
          bridge.meshes.dispose();
          bridges.delete(id);
          rebuilt = true;
        }
      }
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
      // The levels chosen at scale 1, over the view's budget of triangles the farthest coarsened first (`capTriangles`); only when the masses alone pass it does the scale rise (`frameBudget.ts`). The building cut open and the one being edited stay in detail whatever the eye says.
      const fitted = (scale: number): number => {
        massCells.setErrorScale(scale); chooseRaw();
        capRaw();
        capTriangles();
        return chosenTriangles();
      };
      // DO NOT choose the levels again when nothing they read changed and the last choice left them as the one before it did (the choice is deterministic: the same inputs from where it settled give the same levels; 2 to 4 whole choices and caps a frame, PRD-01). A choice that moved anything (a held cell let back a level, a scale stepping down) is run again until it settles.
      const read = lodRead;
      read[0] = eyeX; read[1] = eyeY; read[2] = eyeZ; read[3] = pxAtMetre; read[4] = orthoPx ?? -1; read[5] = reach;
      read[6] = frame.budget; read[7] = 1; read[8] = room(); read[9] = view ? 1 : 0;
      const sameRead = lodForced === forcedNear && read.every((v, i) => Object.is(v, lodLast[i])) && (!view || sameFrustum(lodView, view));
      if (lodStale || !sameRead || !lodSettled) {
        const wasStale = lodStale;
        lodStale = false;
        if (fitted(1) > frame.budget) frame.fit(fitted); else frame.scale = 1;
        const chose = lodChosen();
        lodSettled = !wasStale && sameRead && chose === lodChoice;
        lodChoice = chose;
        lodLast.set(read);
        lodForced = forcedNear;
        if (view) lodView.copy(view);
      }
      // What the frame's last choice left unexposed or unwanted let go, not what a scale tried on the way did (`MassCells.settle`).
      massCells.settle();
      // The room shrinks when another owner grows (a resize, the far levels): the hidden levels go first.
      keepToBudget();
      const now = new Set<string>(massCells.nearKeys());
      for (const key of forcedNear) now.add(key);
      // The cells the eye left behind: their detail let go, their masses standing for them (the town's own boxes), made again on return by `landCells`, which asks every near cell lacking its level. DO NOT keep the whole town's detail in memory because the camera once passed there: the bytes of a large city's cells are its opening's and its roaming's cost, not its size's.
      if (!hiddenNow && stored) {
        const away = new Set<string>();
        for (const key of cells.keys()) if (!now.has(key)) away.add(key);
        for (const key of facades.keys()) if (!now.has(key)) away.add(key);
        for (const key of away) {
          if (pendingCells.has(key)) continue;
          for (const kind of ['cell', 'facade'] as const) {
            if (!(kind === 'cell' ? cells : facades).has(key)) continue;
            shellBatch.remove(kind, key);
            patchCell(key, null, shownAt(kind));
            requests.drop(kind, key);
          }
          cellEntries.delete(key);
        }
      }
      // Those gone far, and every one near: a cell near may have changed between its detail and its facade level.
      for (const key of shownNear) if (!now.has(key)) present(key);
      for (const key of now) present(key);
      shownNear = now;
    },
    setDetailBudget(bytes) {
      budget = bytes;
      keepToBudget();
    },
    setMassBudget(bytes) {
      massBudget = bytes;
    },
    books() {
      return {
        ...massCells.books(), landedTriangles: landedTriangles.size, landedBytes: landedBytes.size, heldFar: heldFar.size, heldCoarse: heldCoarse.size,
        massEntries: massEntries.size, massAsked: massAsked.size, cells: cells.size, facades: facades.size, partCells: partCells.size, facadeParts: facadeParts.size,
        townCells: townCells.size, columns: columns.size, kept: kept.size, cellGround: cellGround.size, cellEntries: cellEntries.size, flags: flagsOf.size,
      };
    },
    frame,
    roots: () => ({
      masses: massCells.group,
      facades: facadeStored.group,
      cells: stored?.group ?? null,
      parts: partRoot,
      signatures: signatureRoot,
      flags: flagLayer.group,
    }),
    get residentBytes() {
      return resident.total;
    },
    census() {
      massCells.syncBases();
      return massCells.census();
    },
    levels() {
      // Asked, never each frame (the per-frame log of this was the page's garbage): each cell of the town by the level chosen for it, the level shown, and why it is below its detail.
      const count = { cells: 0, chosenDetail: 0, chosenFacade: 0, chosenFar: 0, shownDetail: 0, shownFacade: 0, shownNone: 0, notLanded: 0, heldFar: 0, heldCoarse: 0 };
      for (const key of townCells.keys()) {
        count.cells++;
        const near = massCells.near(key), fine = near && massCells.fine(key);
        if (!near) count.chosenFar++; else if (fine) count.chosenDetail++; else count.chosenFacade++;
        const shown = levelShown(key);
        if (shown === 'cell') count.shownDetail++; else if (shown === 'facade') count.shownFacade++; else count.shownNone++;
        if ((fine && shown !== 'cell') || (near && !fine && shown !== 'facade')) count.notLanded++;
        if (heldFar.has(key)) count.heldFar++;
        if (heldCoarse.has(key)) count.heldCoarse++;
      }
      return { ...count, evictions: massCells.books()['massEvictions'] ?? 0, massing: requests.massing, levelsWaiting: massCells.waiting, levelsWaitingInView: massCells.waitingInView, basesWaiting: massCells.basesWaiting, scale: frame.scale, budgetTriangles: frame.budget, chosenTriangles: chosenTriangles(), residentBytes: resident.total, detailBudgetBytes: budget, roomBytes: room() };
    },
    cullDetails(eyeX, eyeY, eyeZ, pxAtMetre, orthoPx, shadowTexel) {
      partView.x = eyeX; partView.y = eyeY; partView.z = eyeZ; partView.pxAtMetre = pxAtMetre; partView.orthoPx = orthoPx; partView.shadowTexel = shadowTexel;
      // The facade cells the view draws in the batched kinds, and no others (`farParts.ts`): one draw a kind, its instances added and taken out here.
      farParts.sync(facadeParts, (key) => levelShown(key) === 'facade');
      // The bases under exactly the cells nothing finer draws this frame (`massCells.ts` syncBases).
      massCells.syncBases();
      // A kind whose pieces span under a pixel where its nearest cell stands is not drawn: the far band keeps its walls, not its noise.
      farParts.view(eyeX, eyeY, eyeZ, pxAtMetre, orthoPx);
      // Drawn while its cell is drawn in detail (the masses stand for it from afar, `massCells.ts`), each kind by its error on the screen.
      for (const [kind, map] of [['cell', partCells], ['facade', facadeParts]] as const) {
        for (const [key, cell] of map) {
          cell.group.visible = levelShown(key) === kind;
          if (!cell.group.visible) continue;
          cell.choose(partView);
          // What the level draws, measured with its parts chosen (DO NOT measure it as it lands: its parts are chosen at this cull, they counted 0 and the facade level's mean fell 7 times under what it draws).
          const level = (kind === 'cell' ? cells : facades).get(key)?.part;
          if (level) landedTriangles.set(kind, key, level.triangles + cell.triangles + (kind === 'facade' ? farParts.trianglesOf(key) : 0));
        }
      }
    },
    castInto(texel, coarse = false, half = 0) {
      // Past the first cascade, a part narrower than `CAST_RADIUS_SHARE` of the cascade casts nothing (its texel test alone let a sill cast into a cascade of kilometres).
      const partTexel = texel === null ? null : Math.max(texel, CAST_RADIUS_SHARE * half);
      // DO NOT draw hundreds of detail meshes into a far cascade: a cell's masses are its silhouette at those texels, one mesh. Only the cells whose masses stand in: the detail of any other (none landed yet, a town drawn whole) still casts, never a hole.
      if (texel === null || !coarse) {
        farParts.castShadow(true);
        shellBatch.castShadow(true);
        if (shadowCoarse) {
          shadowCoarse = false;
          for (const [group, was] of shadowHidden) group.visible = was;
          shadowHidden.clear();
          massCells.shadowMasses(false);
        }
        if (partTexel === null) return;
        for (const map of [partCells, facadeParts]) for (const cell of map.values()) if (cell.group.visible) cell.castInto(partTexel);
        return;
      }
      // The parts of the cells whose masses cannot stand in (their detail still casts): by their size in this cascade, as above.
      for (const map of [partCells, facadeParts]) for (const cell of map.values()) if (cell.group.visible) cell.castInto(partTexel!);
      if (shadowCoarse) return;
      shadowCoarse = true;
      farParts.castShadow(false);
      shellBatch.castShadow(false);
      for (const key of massCells.shadowMasses(true)) {
        for (const group of [cells.get(key)?.part.group, facades.get(key)?.part.group, partCells.get(key)?.group, facadeParts.get(key)?.group]) {
          if (!group || shadowHidden.has(group)) continue;
          shadowHidden.set(group, group.visible);
          group.visible = false;
        }
      }
    },
    occluderCell(i, j) {
      // The town not drawn as the document says: no wall hides anything.
      if (hiddenNow || eye === null || cutaway !== null || dimmed !== undefined || ruined.size > 0 || bridges.size > 0 || (preview?.hides ?? null) !== null) return false;
      const key = `${i},${j}`;
      // Drawn at its own detail and current: its level landed for the buildings it holds now (a cell whose buildings changed is pending until it is).
      return levelShown(key) !== null && !pendingCells.has(key);
    },
    hideOccluded(camera: Camera, hidden) {
      this.restoreOccluded();
      // The masses shown (far cells, tiles, plates): their boxes are in the world (`massCells.ts` cellMesh).
      // The cells' meshes, and the tiles' and plates' in their own group beside them.
      for (const child of massCells.group.children) {
        if (child instanceof Group) { if (child.visible) for (const level of child.children) hideMass(level, hidden); } else hideMass(child, hidden);
      }
      // Each cell's detail and facade level, and their parts.
      for (const cache of [cells, facades]) for (const { part } of cache.values()) if (part.group.visible) { const box = groupBox(part.group); if (box && planHidden(hidden, box)) occluded.push(part.group); }
      for (const map of [partCells, facadeParts]) for (const cell of map.values()) if (cell.group.visible && planHidden(hidden, cell.bounds)) occluded.push(cell.group);
      for (const o of occluded) o.visible = false;
      // The walls in the multi-draw batches: by instance, for this camera alone (`GpuBatchedMesh.colourHidden`).
      return occluded.length + shellBatch.hideOccluded(camera, (box) => planHidden(hidden, box));
    },
    revealOccluded(on) {
      for (const o of occluded) o.visible = on;
    },
    restoreOccluded() {
      for (const o of occluded) o.visible = true;
      occluded.length = 0;
      shellBatch.restoreOccluded();
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
      return lotOf(k)?.heightAt(x, y) ?? NaN;
    },
    anyLotHeightAt(x, y) {
      // The buildings filed round the point, in increasing id (`CellFiling.idsMeeting`).
      for (const id of lotFiling.idsMeeting([x, y, x, y])) {
        const k = kept.get(id)!;
        // Filed only with a lot (`putKept`).
        const h = lotOf(k)?.heightAt(x, y);
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
      farParts.clear();
      partRoot.add(farParts.group);
      shellBatch.reset();
      facadeStored.group.add(shellBatch.facadeGroup);
      // The masses too, the tiles' and plates' with them: asked again whole by the next update.
      levels.clear();
      massEntries.clear();
      massAsked.clear();
      massCells.dispose();
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
      stored?.dispose();
      solo?.dispose();
      for (const bridge of bridges.values()) bridge.meshes.dispose();
      bridges.clear();
      for (const cache of [cells, facades]) {
        for (const cell of cache.values()) cell.part.dispose();
        cache.clear();
      }
      for (const map of [partCells, facadeParts]) {
        for (const cell of map.values()) cell.dispose();
        map.clear();
      }
      cellGround.clear();
      cellEntries.clear();
      kept.clear();
      columns.clear();
      ghost?.dispose();
      farParts.dispose();
      shellBatch.dispose();
      kit.dispose();
      group.clear();
    },
  };
}

import type { Mesh } from 'three';
import { cancelWarm, warmFull, warmLooseAhead } from '../uploads';
import { type BuildingMeshes, meshesOf } from './buildingMesh';
import { type CellMass, cellBytes } from './cellArrays';
import type { CellEnv, CellPool } from './cellPool';
import type { CellEntry, CellResult, ChunkSummary } from './cellWork';
import { sameEntries } from './chunk';
import type { BuildingKit } from './kit';
import { PartCell } from './partCells';
import { filingBytes } from './partFiling';

/** THE BUILDINGS' CELLS ASKED OF THE WORKERS AND LANDED (`layer.ts`) */

/** A cell's batches as landed: its shells, panes and furniture, and its parts by sub-cell (`partCells.ts`). */
export interface LandedCell {
  readonly entries: readonly CellEntry[];
  readonly batch: BuildingMeshes | null;
  readonly parts: PartCell | null;
  /** What its batches send to the GPU, bytes (`cellBytes`): the layer's residency budget counts it. */
  readonly bytes: number;
}

interface Landing extends LandedCell { uploads: number }

/** A cell's detail (L0) or its facade level (L1, `emitChunk` `far`). */
export type BatchKind = 'cell' | 'facade';

export class CellRequests {
  private readonly asked = new Map<string, { readonly entries: readonly CellEntry[]; id: number }>();
  private readonly landed = new Map<string, Landing>();
  /** Summary jobs asked and not answered: cancelled with the rest (`clear`). */
  private readonly summaries = new Set<number>();
  /** Each cell's masses asked and not answered, by the job's id. */
  private readonly masses = new Map<string, number>();

  /** `admit`: whether a level landed is still wanted within the GPU's room, its bytes measured (refused: disposed, never uploaded); `rank`: its upload's pixels of error (`uploads.ts`). */
  constructor(private readonly pool: CellPool, private readonly kit: BuildingKit, private readonly onSummaries: (summaries: readonly ChunkSummary[], entries: readonly CellEntry[], env: CellEnv) => void,
    private readonly admit: (kind: BatchKind, cell: string, bytes: number) => boolean = () => true, private readonly rank: (kind: BatchKind, cell: string) => number = () => 0) {}

  /** Cells asked and not landed, or landed and still on their way to the GPU. */
  get waiting(): number {
    let n = this.asked.size;
    for (const l of this.landed.values()) if (l.uploads > 0) n++;
    return n;
  }

  /** `cell`'s batches made of `entries`, once landed and (with `upload`) on the GPU; null while they are made */
  want(kind: BatchKind, cell: string, entries: readonly CellEntry[], env: CellEnv, upload: boolean, edited = false): LandedCell | null {
    const key = `${kind}|${cell}`;
    const got = this.landed.get(key);
    if (got && sameEntries(got.entries, entries)) return got.uploads > 0 ? null : got;
    if (got) { disposeLanded(got); this.landed.delete(key); }
    const asked = this.asked.get(key);
    if (asked && sameEntries(asked.entries, entries)) return null;
    // DO NOT ask a level to upload while the upload queue is full before it (`uploads.ts` warmFull by its rank): its arrays waited on the page behind every other one (the renderer at 7.3 GB in a re-bake, conf77, 2026-10-17). What is drawn stands, asked again next frame; a building cut open always goes.
    if (upload && warmFull(this.rank(kind, cell)) && !edited && !entries.some((e) => e.key.includes('|'))) return null;
    // Replaced by the cell as it is now: never sent if waiting, its answer dropped if begun (the queue's key does the same).
    if (asked) this.pool.supersede(asked.id);
    const ask = { entries, id: 0 };
    this.asked.set(key, ask);
    ask.id = this.pool.run(kind, cell, entries, env, (result) => {
      if (this.asked.get(key) !== ask) return;
      this.asked.delete(key);
      this.onSummaries(result.summaries, entries, env);
      const landing = this.land(kind, cell, entries, result, upload);
      if (landing) this.landed.set(key, landing);
    }, key, edited);
    // Where no worker runs the job is done by now.
    const now = this.landed.get(key);
    return now && now.entries === entries && now.uploads === 0 ? now : null;
  }

  /** A cell's batches taken to be shown: the layer's to dispose from now on. */
  take(kind: BatchKind, cell: string): void {
    this.landed.delete(`${kind}|${cell}`);
  }

  /** Cells asked and not landed yet. */
  get asking(): number {
    return this.asked.size;
  }

  /** Whether a cell has been asked for and not landed yet. */
  isAsked(kind: BatchKind, cell: string): boolean {
    return this.asked.has(`${kind}|${cell}`);
  }

  /** A cell no longer wanted (drawn far before it landed): its request cancelled, its batches if landed disposed. */
  drop(kind: BatchKind, cell: string): void {
    const key = `${kind}|${cell}`;
    const asked = this.asked.get(key);
    if (asked) { this.pool.cancel(asked.id); this.asked.delete(key); }
    const got = this.landed.get(key);
    if (got) { disposeLanded(got); this.landed.delete(key); }
  }

  /** What the page keeps of these far buildings (their flags), with no batch made. */
  summarize(cell: string, entries: readonly CellEntry[], env: CellEnv): void {
    // DO NOT read `id` in the answer before it is given: on the page the answer comes inside `run`.
    let id = -1;
    id = this.pool.run('summary', cell, entries, env, (result) => {
      this.summaries.delete(id);
      this.onSummaries(result.summaries, entries, env);
    });
    // Done at once where no worker runs: nothing left to cancel.
    if (this.pool.isRunning(id)) this.summaries.add(id);
  }

  /** A cell's masses from afar made of `entries` (`cellWork.ts` 'mass'), handed to `done` when they come */
  mass(cell: string, entries: readonly CellEntry[], env: CellEnv, done: (mass: CellMass | null) => void, edited = false): boolean {
    // The upload queue full: not asked (the caller asks again next frame), as `want`; never what the player just edited.
    if (warmFull() && !edited) return false;
    const was = this.masses.get(cell);
    if (was !== undefined) { this.pool.cancel(was); this.masses.delete(cell); }
    let id = -1;
    id = this.pool.run('mass', cell, entries, env, (result) => {
      if (this.masses.get(cell) === id) this.masses.delete(cell);
      done(result.mass ?? null);
    }, `mass|${cell}`, edited);
    if (this.pool.isRunning(id)) this.masses.set(cell, id);
    return true;
  }

  /** A cell's masses no longer wanted (it has no building left). */
  dropMass(cell: string): void {
    const id = this.masses.get(cell);
    if (id === undefined) return;
    this.pool.cancel(id);
    this.masses.delete(cell);
  }

  /** Cells whose masses are asked and not come. */
  get massing(): number {
    return this.masses.size;
  }

  /** Every request forgotten and every batch not taken disposed (a context restored, the layer gone). */
  clear(): void {
    for (const { id } of this.asked.values()) this.pool.cancel(id);
    this.asked.clear();
    for (const id of this.summaries) this.pool.cancel(id);
    this.summaries.clear();
    for (const id of this.masses.values()) this.pool.cancel(id);
    this.masses.clear();
    for (const l of this.landed.values()) disposeLanded(l);
    this.landed.clear();
  }

  /** The batches wrapped in meshes, and sent to the GPU ahead (`warmLooseAhead`) when `upload` and admitted; null when refused (DO NOT upload a level the room has no place for: it was sent before the layer chose to show it). */
  private land(kind: BatchKind, cell: string, entries: readonly CellEntry[], result: CellResult, upload: boolean): Landing | null {
    let bytes = result.batch ? cellBytes(result.batch) : 0;
    if (result.parts) bytes += filingBytes(result.parts);
    if (upload && !this.admit(kind, cell, bytes)) return null;
    const batch = result.batch ? meshesOf(result.batch, this.kit, false, false) : null;
    const parts = result.parts ? new PartCell(cell, result.parts, this.kit) : null;
    const landing: Landing = { entries, batch, parts, bytes, uploads: 0 };
    if (!upload) return landing;
    const sent = warmLooseAhead(meshesIn(landing), () => this.rank(kind, cell));
    if (sent) { landing.uploads++; void sent.then(() => { landing.uploads--; }); }
    return landing;
  }
}

/** Every mesh of a landed cell. */
function meshesIn(l: LandedCell): Mesh[] {
  const meshes: Mesh[] = [];
  l.batch?.group.traverse((o) => { if ((o as Mesh).isMesh) meshes.push(o as Mesh); });
  if (l.parts) meshes.push(...l.parts.warmMeshes());
  return meshes;
}

/** DO NOT dispose first: a mesh still queued was drawn after and its geometry went back to the GPU with no owner. */
function disposeLanded(l: LandedCell): void {
  cancelWarm(meshesIn(l));
  l.batch?.dispose();
  l.parts?.dispose();
}

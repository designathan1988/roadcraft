import type { Mesh } from 'three';
import { cancelWarm, warmLooseAhead } from '../uploads';
import { type BuildingMeshes, meshesOf } from './buildingMesh';
import type { CellMass } from './cellArrays';
import type { CellEnv, CellPool } from './cellPool';
import type { CellEntry, CellResult, ChunkSummary } from './cellWork';
import type { BuildingKit } from './kit';

/**
 * THE BUILDINGS' CELLS ASKED OF THE WORKERS AND LANDED (`layer.ts`): a coarse
 * cell's batches are asked once for the entries it has now (each building's
 * key, record and ground, compared by reference), wrapped in meshes when they
 * come back (`buildingMesh.ts` `meshesOf`: the arrays as they are), sent to the
 * GPU a few a frame (`warmLooseAhead`) and handed to the layer only then. A
 * cell asked again with other entries drops what was asked or landed for the
 * old ones. What the page keeps of each building emitted (flags, lots' ground,
 * signature floor) goes to `onSummaries`.
 */

/** Whether two lists are the same buildings with the same records on the same ground (the strings compared by reference). */
export const sameEntries = (a: readonly CellEntry[], b: readonly CellEntry[]): boolean =>
  a.length === b.length && a.every((e, i) => e.key === b[i]!.key && e.record === b[i]!.record && e.digest === b[i]!.digest);

/** A cell's batches as landed: its coarse batch (or its faded one) and its detail cells'. */
export interface LandedCell {
  readonly entries: readonly CellEntry[];
  readonly batch: BuildingMeshes | null;
  readonly details: ReadonlyMap<string, BuildingMeshes>;
}

interface Landing extends LandedCell { uploads: number }

type BatchKind = 'cell' | 'faded';

export class CellRequests {
  private readonly asked = new Map<string, { readonly entries: readonly CellEntry[]; id: number }>();
  private readonly landed = new Map<string, Landing>();
  /** Summary jobs asked and not answered: cancelled with the rest (`clear`). */
  private readonly summaries = new Set<number>();
  /** Each cell's masses asked and not answered, by the job's id. */
  private readonly masses = new Map<string, number>();

  constructor(private readonly pool: CellPool, private readonly kit: BuildingKit, private readonly onSummaries: (summaries: readonly ChunkSummary[], entries: readonly CellEntry[], env: CellEnv) => void) {}

  /** Cells asked and not landed, or landed and still on their way to the GPU. */
  get waiting(): number {
    let n = this.asked.size;
    for (const l of this.landed.values()) if (l.uploads > 0) n++;
    return n;
  }

  /**
   * `cell`'s batches made of `entries`, once landed and (with `upload`) on the
   * GPU; null while they are made - asked now if they were not, for these
   * entries. The batches stay this module's until `take`n.
   */
  want(kind: BatchKind, cell: string, entries: readonly CellEntry[], env: CellEnv, upload: boolean): LandedCell | null {
    const key = `${kind}|${cell}`;
    const got = this.landed.get(key);
    if (got && sameEntries(got.entries, entries)) return got.uploads > 0 ? null : got;
    if (got) { disposeLanded(got); this.landed.delete(key); }
    const asked = this.asked.get(key);
    if (asked && sameEntries(asked.entries, entries)) return null;
    if (asked) this.pool.cancel(asked.id);
    const ask = { entries, id: 0 };
    this.asked.set(key, ask);
    ask.id = this.pool.run(kind, cell, entries, env, (result) => {
      if (this.asked.get(key) !== ask) return;
      this.asked.delete(key);
      this.onSummaries(result.summaries, entries, env);
      this.landed.set(key, this.land(entries, result, kind === 'faded', upload));
    });
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
    const id = this.pool.run('summary', cell, entries, env, (result) => {
      this.summaries.delete(id);
      this.onSummaries(result.summaries, entries, env);
    });
    // Done at once where no worker runs: nothing left to cancel.
    if (this.pool.isRunning(id)) this.summaries.add(id);
  }

  /**
   * A cell's masses from afar made of `entries` (`cellWork.ts` 'mass'), handed to `done` when they
   * come - at once where no worker runs. A cell asked again before they came gives up the old ask.
   */
  mass(cell: string, entries: readonly CellEntry[], env: CellEnv, done: (mass: CellMass | null) => void): void {
    const was = this.masses.get(cell);
    if (was !== undefined) { this.pool.cancel(was); this.masses.delete(cell); }
    let id = -1;
    id = this.pool.run('mass', cell, entries, env, (result) => {
      if (this.masses.get(cell) === id) this.masses.delete(cell);
      done(result.mass ?? null);
    });
    if (this.pool.isRunning(id)) this.masses.set(cell, id);
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

  /** A cell drawn far: its worker may give its buildings' chunks up first. */
  release(cell: string): void {
    this.pool.release(cell);
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

  /** The batches wrapped in meshes, and sent to the GPU ahead (`warmLooseAhead`) when `upload`. */
  private land(entries: readonly CellEntry[], result: CellResult, faded: boolean, upload: boolean): Landing {
    const batch = result.batch ? meshesOf(result.batch, this.kit, false, faded) : null;
    const details = new Map(result.details.map(([key, arrays]) => [key, meshesOf(arrays, this.kit, false, false)] as const));
    const landing: Landing = { entries, batch, details, uploads: 0 };
    if (!upload) return landing;
    const sent = warmLooseAhead(meshesIn(landing));
    if (sent) { landing.uploads++; void sent.then(() => { landing.uploads--; }); }
    return landing;
  }
}

/** Every mesh of a landed cell. */
function meshesIn(l: LandedCell): Mesh[] {
  const meshes: Mesh[] = [];
  for (const part of [l.batch, ...l.details.values()]) part?.group.traverse((o) => { if ((o as Mesh).isMesh) meshes.push(o as Mesh); });
  return meshes;
}

/**
 * A landed cell let go: out of the GPU queue first (`cancelWarm`), then disposed. DO NOT dispose
 * first: a mesh still queued was drawn after and its geometry went back to the GPU with no owner.
 */
function disposeLanded(l: LandedCell): void {
  cancelWarm(meshesIn(l));
  l.batch?.dispose();
  for (const d of l.details.values()) d.dispose();
}

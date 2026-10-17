import { JournalCursor } from './derived';
import type { ChangeJournal } from './changes';
import { OWNER } from './tiles';

/** WHAT EACH TILE OF THE PAGE'S DOCUMENT HOLDS, BY ID: its nodes and roads filed by `OWNER`, kept by the diary's road entries (each names the nodes and segments it touched, `Change.nodes`, `Change.segments`); its land keys and paint dabs grouped again only when the diary says they changed. DO NOT walk every node, road, key and dab of the region for one tile (`RoadDoc.tileMembers`: three times a crossing, at every write of a dirty tile) */

interface Place { readonly x: number; readonly y: number }

/** What of the document the index reads. */
export interface IndexedDoc {
  readonly changes: ChangeJournal;
  readonly nodes: ReadonlyMap<number, Place & { readonly incident: readonly number[] }>;
  readonly segments: ReadonlyMap<number, { readonly a: number; readonly b: number }>;
  readonly lotKeyList: readonly string[];
  readonly paintList: readonly Place[];
}

/** One kind's records by tile: each record's tile and each tile's records. */
class Filing {
  private readonly tileOf = new Map<number, number>();
  private readonly members = new Map<number, Set<number>>();
  /** A tile with none of them. */
  private readonly none: ReadonlySet<number> = new Set();

  /** Record `id` in tile `key` (none: taken out). */
  file(id: number, key: number | undefined): void {
    const was = this.tileOf.get(id);
    if (was === key) return;
    if (was !== undefined) {
      const set = this.members.get(was)!;
      set.delete(id);
      if (set.size === 0) this.members.delete(was);
    }
    if (key === undefined) { this.tileOf.delete(id); return; }
    this.tileOf.set(id, key);
    let set = this.members.get(key);
    if (!set) this.members.set(key, set = new Set());
    set.add(id);
  }

  of(key: number): ReadonlySet<number> {
    return this.members.get(key) ?? this.none;
  }

  clear(): void {
    this.tileOf.clear();
    this.members.clear();
  }
}

export class TileIndex {
  private readonly roads = new JournalCursor(['roads']);
  private readonly lists = new JournalCursor(['lotKeys', 'paint']);
  private readonly nodeFiling = new Filing();
  private readonly segmentFiling = new Filing();
  private keysByTile: Map<number, string[]> | null = null;
  private paintByTile: Map<number, Place[]> | null = null;

  constructor(private readonly doc: IndexedDoc, private readonly keyPlace: (key: string) => Place | null) {}

  /** The ids of tile `key`'s nodes and roads, as the diary says they stand now. */
  roadsOf(key: number): { readonly nodes: ReadonlySet<number>; readonly segments: ReadonlySet<number> } {
    this.followRoads();
    return { nodes: this.nodeFiling.of(key), segments: this.segmentFiling.of(key) };
  }

  /** Tile `key`'s land keys, in the store's order. */
  keysOf(key: number): readonly string[] {
    this.followLists();
    if (!this.keysByTile) {
      this.keysByTile = new Map();
      for (const k of this.doc.lotKeyList) {
        const at = this.keyPlace(k);
        if (!at) continue;
        const tile = OWNER.at(at);
        let list = this.keysByTile.get(tile);
        if (!list) this.keysByTile.set(tile, list = []);
        list.push(k);
      }
    }
    return this.keysByTile.get(key) ?? [];
  }

  /** Tile `key`'s paint dabs, in the list's order. */
  paintOf<T extends Place>(key: number): readonly T[] {
    this.followLists();
    if (!this.paintByTile) {
      this.paintByTile = new Map();
      for (const dab of this.doc.paintList) {
        const tile = OWNER.at(dab);
        let list = this.paintByTile.get(tile);
        if (!list) this.paintByTile.set(tile, list = []);
        list.push(dab);
      }
    }
    return (this.paintByTile.get(key) ?? []) as unknown as readonly T[];
  }

  private followLists(): void {
    const entries = this.lists.read(this.doc.changes);
    if (entries !== null && entries.length === 0) return;
    for (const kind of entries === null ? ['lotKeys', 'paint'] : entries.map((e) => e.kind)) {
      if (kind === 'lotKeys') this.keysByTile = null;
      else this.paintByTile = null;
    }
  }

  private followRoads(): void {
    const entries = this.roads.read(this.doc.changes);
    if (entries === null) { this.fileAll(); return; }
    for (const entry of entries) {
      // An entry that names no node nor road (the map loaded): everything filed again.
      if (!entry.nodes && !entry.segments) { this.fileAll(); return; }
      for (const id of entry.nodes ?? []) {
        this.fileNode(id);
        // A node moved moves the middle of every road on it.
        for (const s of this.doc.nodes.get(id)?.incident ?? []) this.fileSegment(s);
      }
      for (const id of entry.segments ?? []) this.fileSegment(id);
    }
  }

  private fileNode(id: number): void {
    const node = this.doc.nodes.get(id);
    this.nodeFiling.file(id, node ? OWNER.node(node) : undefined);
  }

  private fileSegment(id: number): void {
    const s = this.doc.segments.get(id);
    const a = s && this.doc.nodes.get(s.a), b = s && this.doc.nodes.get(s.b);
    this.segmentFiling.file(id, s && a && b ? OWNER.segment(a, b) : undefined);
  }

  private fileAll(): void {
    this.nodeFiling.clear();
    this.segmentFiling.clear();
    for (const id of this.doc.nodes.keys()) this.fileNode(id);
    for (const id of this.doc.segments.keys()) this.fileSegment(id);
  }
}

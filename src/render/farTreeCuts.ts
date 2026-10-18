import type { TileRecords } from '@world/doc';
import type { FarTileSource } from './farTreeTypes';

/** A tile the page holds edited, cut to what a near level reads, and the digest of that. */
export interface PageCut { readonly records: TileRecords; readonly digest: string }

/** EACH TILE THE PAGE HOLDS EDITED AS THE FAR TREE'S NEAR LEVEL READS IT (`farTree.ts` askNear), by the edit it is of: DO NOT read the page's document again for every neighbour that reads the tile, nor for every frame (`tileMembers` walks the region's document) */
export class PageCuts {
  private readonly known = new Map<number, { readonly edit: number; readonly cut: PageCut | null; drawn?: boolean }>();
  /** The cut of its own tile each tile's near level was asked of, by the signature asked (the signature is a digest: it does not say). */
  private readonly askedOf = new Map<number, Map<string, string>>();

  /** `source`: the page's edits and records of its tiles; `cutOf`: the kind's cut of a tile's records (null: the records whole, by the edit). */
  constructor(private readonly source: () => FarTileSource | null, private readonly cutOf: (records: TileRecords) => PageCut | null) {}

  /** A tile the page holds edited (`FarTileSource.pageEdit`), cut to what the near level reads and digested, once an edit; null for one the store holds as the page has it. */
  of(key: number): PageCut | null {
    const source = this.source();
    const edit = source?.pageEdit?.(key) ?? 0;
    const known = this.known.get(key);
    if (!edit || !source?.pageRecords) {
      // DO NOT let the edit's write being confirmed ask the near level again before the edit is drawn: the stored versions hold what the cut holds, and the job of the cut, still waiting, was cancelled for one of the version in the cells' band, behind every building the road's edit had baked again; a second write (a building grown next to it) cancelled it once more (`conferencia` 40-road-4s, the road drawn only after a reload, conf42-45, 2026-10-17; found by the near-tiles session). The cut stands for the tile until the tile's near level made of it is drawn (`drawn`); then the version's, of the same roads, is kept as drawn (`landNear` same content).
      if (edit === 0 && known?.cut && !known.drawn && source?.pageRecords) return known.cut;
      this.known.delete(key);
      this.askedOf.delete(key);
      return null;
    }
    if (known && known.edit === edit) return known.cut;
    const records = source.pageRecords(key);
    const cut = records ? (this.cutOf(records) ?? { records, digest: `e${edit}` }) : null;
    this.known.set(key, { edit, cut });
    return cut;
  }

  /** The tile's near level asked at `sig` of its cut. */
  asked(key: number, sig: string, cut: PageCut): void {
    let asked = this.askedOf.get(key);
    if (!asked) { asked = new Map(); this.askedOf.set(key, asked); }
    asked.set(sig, cut.digest);
  }

  /** A tile's near level drawn of what it read (`sig`): the tile's cut, if it was made of it, drawn - the edit is on the screen. */
  drawn(key: number, sig: string): void {
    const known = this.known.get(key);
    if (known?.cut && this.askedOf.get(key)?.get(sig) === known.cut.digest) known.drawn = true;
  }
}

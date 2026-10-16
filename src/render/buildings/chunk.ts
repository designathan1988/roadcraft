import type { FurnitureKind } from '@world/buildings/interior';
import type { Finish } from '@world/buildings/materials';
import type { FlagInstance } from './flagLayer';
import type { FacadePropKind } from './facadeProps';

/** A part instanced per kind for the whole near ring (`kit.ts` PART_KINDS): declared with the cell's data, which the kit's materials do not need. */
export type PartKind =
  | 'glass'
  | 'frame'
  | 'concrete'
  | 'door'
  | 'shutter'
  | 'railing'
  | 'roofRailing'
  | 'awning'
  | 'column'
  | 'glassDark'
  | 'water'
  | 'lamp'
  | 'wash'
  | 'fin'
  | 'louvre'
  | 'glassRail'
  | 'brise'
  | FacadePropKind;

/** WHAT ONE BUILDING CONTRIBUTES TO THE BATCHES */

/** A building of a cell as the cell workers are sent it (`cellWork.ts`): its chunk's key (an id, or a building cut open), its record as text and the ground under it. */
export interface CellEntry {
  readonly key: string;
  /** The record's digest (`Digest.addPlain`): two entries alike are the same record. */
  readonly sig: number;
  /** The ground under it, digested (`groundDigest`). */
  readonly digest: number;
}

/** Whether two lists are the same buildings with the same records on the same ground (the strings compared by reference). */
export const sameEntries = (a: readonly CellEntry[], b: readonly CellEntry[]): boolean =>
  a.length === b.length && a.every((e, i) => e.key === b[i]!.key && e.sig === b[i]!.sig && e.digest === b[i]!.digest);

/** DO NOT keep the text with the entries the page keeps: a string the size of the record, for every building. */
export interface CellJobEntry extends CellEntry {
  readonly record: string;
}

/** One part batch of one building: its instance matrices (and colours). */
export interface PartBatch {
  readonly matrices: Float32Array;
  readonly colours: Float32Array | null;
  readonly count: number;
  /** Window panes: each one's light slot. */
  readonly slots?: Float32Array;
  /** Window panes: each one's room behind it, ROOM_FLOATS numbers (`roomBehind.ts`); a depth of 0 for none known. */
  readonly rooms?: Float32Array;
}

/** Everything one building contributes, in typed arrays: a shell fragment with local indices and its instance batches. */
export interface ShellChunk {
  readonly decay: Float32Array;
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly colour: Float32Array;
  readonly uv: Float32Array;
  readonly index: Uint32Array;
  /** The far level only (`emitChunk` `far`): each vertex's window grid, `FACADE_FLOATS` numbers (`cellArrays.ts`). */
  readonly facade?: Float32Array;
  /** The far level only: each vertex's opening and frame colour, `FACADE_BYTES` bytes. */
  readonly opening?: Uint8Array;
}

export interface BuildingChunk {
  /** The shell, one fragment per finish it uses. */
  readonly shells: Readonly<Partial<Record<Finish, ShellChunk>>>;
  readonly parts: Readonly<Record<PartKind, PartBatch>>;
  /** Furniture of a cut-open interior, by kind; absent when none is drawn. */
  readonly furniture?: Readonly<Partial<Record<FurnitureKind, PartBatch>>>;
  /** Flags flown from its masts, drawn by the cloth layer (`flagLayer.ts`). */
  readonly flags?: readonly FlagInstance[];
  /** The ground of its lots and parking bays as drawn; absent when it has none. */
  readonly lotGround?: LotGround;
  /** A signature building's ground floor height: its body is drawn by `signature.ts`. */
  readonly signatureFloor?: number;
}

export interface LotGround {
  /** Height of the drawn surface at a world point on a lot or a bay; NaN elsewhere. */
  heightAt(x: number, y: number): number;
  /** How it was made, to be made again where a function cannot be sent (`buildingMesh.ts` `lotGroundAgain`). */
  readonly recipe: LotGroundRecipe;
}

/** What a lot ground is made from besides the record: the level its lots meet and whether they were laid (`emitLots`). */
export interface LotGroundRecipe {
  readonly level: number | undefined;
  readonly lots: boolean;
}


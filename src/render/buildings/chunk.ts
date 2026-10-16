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
  | 'lotBox'
  | 'lotRail'
  | 'lotSlab'
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
  /** The shell's parts (`shellParts.ts`): each one's finish id, wear and ground, `LOOK_FLOATS` numbers. */
  readonly looks?: Float32Array;
}

/** Everything one building contributes, in typed arrays: a shell fragment with local indices and its instance batches. */
/** A shell's vertices are written in the GPU's layout as they are laid (`cellArrays.ts` `ShellArrays`), each one once: faces alike in every number share it (`buildingMesh.ts` `ShellPart.weld`). */
export interface ShellChunk {
  readonly position: Float32Array;
  /** The normal (three's axes) and the wear, `SHELL_SHORTS` signed shorts a vertex over `NORMAL_UNIT`. */
  readonly normalDecay: Int16Array;
  /** The paint's linear rgb over `COLOUR_RANGE` and the finish id, `SHELL_SHORTS` unsigned shorts a vertex over `PAINT_UNIT`. */
  readonly paint: Uint16Array;
  readonly index: Uint32Array;
}

/** The far level's runs of bays with openings (`emitChunk` `far`): a shell fragment whose every vertex carries its window grid (`facadeLevel.ts`). */
export interface RunChunk extends ShellChunk {
  /** Each vertex's bay width and storey height, `FACADE_FLOATS` numbers (`cellArrays.ts`). */
  readonly facade: Float32Array;
  /** Each vertex's bay, level, kind and volume * 4 + side, `FACADE_GRID` shorts. */
  readonly grid: Int16Array;
  /** Each vertex's opening and frame colour, `FACADE_BYTES` bytes. */
  readonly opening: Uint8Array;
}

export interface BuildingChunk {
  /** The shell, one fragment per finish it uses; at the far level every face but the runs of bays with openings. */
  readonly shells: Readonly<Partial<Record<Finish, ShellChunk>>>;
  /** The far level only: its runs of bays with openings, one fragment per finish, drawn by the facade's material; none on the detail. */
  readonly runs?: Readonly<Partial<Record<Finish, RunChunk>>>;
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


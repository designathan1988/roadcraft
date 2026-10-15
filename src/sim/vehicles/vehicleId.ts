/**
 * A vehicle's id (`vehicles/state.ts` re-exports it). Its own file: a type
 * that needs only the id (`agents/bay.ts`) takes it from here, not from the
 * state, which reaches the whole simulation (`tests/arch/imports.spec.ts`).
 */
export type VehicleId = number;

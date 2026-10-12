import type { RoadDoc } from '@world/doc';
import { type RoadCharge, chargeFor, roadValue } from '@world/economy';

/**
 * Paying for a road edit (`world/economy.ts`, docs/VIAS.md V0): every tool
 * that changes the roads takes what they are worth before it, makes the
 * edit, and settles here. What a road edit costs is decided in one place
 * and the same for all of them - drawing, splitting, retyping, widening,
 * moving a node, demolishing.
 */
export interface RoadsBefore {
  readonly value: number;
  readonly balance: number;
}

/** What the roads are worth and the money in hand, before an edit. */
export function roadsBefore(doc: RoadDoc): RoadsBefore {
  return { value: roadValue(doc), balance: doc.economy.balance };
}

/**
 * The charge for the edit `after` holds against `before`, written into
 * `after` when it can be paid (`apply`), and the charge either way: one the
 * balance cannot cover is not written, and the caller refuses the edit.
 */
export function settleRoadEdit(before: RoadsBefore, after: RoadDoc, apply = true): RoadCharge {
  const charge = chargeFor(before.value, roadValue(after), before.balance);
  if (apply && charge.affordable && charge.amount !== 0) {
    after.setBalance(charge.balance, charge.amount > 0 ? 'via paga' : 'demolição devolvida');
  }
  return charge;
}

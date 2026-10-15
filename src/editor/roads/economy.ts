import type { RoadDoc } from '@world/doc';
import { type RoadCharge, chargeFor, roadValue } from '@world/economy';

/** Paying for a road edit (`world/economy.ts`) */
export interface RoadsBefore {
  readonly value: number;
  readonly balance: number;
}

/** What the roads are worth and the money in hand, before an edit. */
export function roadsBefore(doc: RoadDoc): RoadsBefore {
  return { value: roadValue(doc), balance: doc.economy.balance };
}

/** The charge for the edit `after` holds against `before`, written into `after` when it can be paid */
export function settleRoadEdit(before: RoadsBefore, after: RoadDoc, apply = true): RoadCharge {
  const charge = chargeFor(before.value, roadValue(after), before.balance);
  if (apply && charge.affordable && charge.amount !== 0) {
    after.setBalance(charge.balance, charge.amount > 0 ? 'via paga' : 'demolição devolvida');
  }
  return charge;
}

import { ROAD_TUNING } from '@world/roads/tuning';
import { formatDecimal, language, t } from '../i18n';

/** Money as the player reads it (`world/economy.ts`) */
export function formatMoney(value: number): string {
  // DO NOT make a formatter per call (each frame a road in hand shows its cost): the language's own, kept (`formatDecimal`).
  return t('economy.money', { value: formatDecimal(Math.round(value), 0, language()) });
}

/** What a road in hand costs, for the preview: its price, or what a demolition-like edit gives back. */
export function formatCost(cost: number): string {
  return cost < 0 ? t('economy.refund', { value: formatMoney(-cost) }) : formatMoney(cost);
}

/** The balance's tooltip, with the demolition share the game uses. */
export function balanceTip(): string {
  return t('economy.balance', { share: Math.round(ROAD_TUNING.economy.demolitionRefund * 100) });
}

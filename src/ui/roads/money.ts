import { ROAD_TUNING } from '@world/roads/tuning';
import { language, t } from '../i18n';

/**
 * Money as the player reads it (`world/economy.ts`): whole units, grouped
 * the way the interface language groups digits, in that language's
 * template (`economy.money`).
 */
export function formatMoney(value: number): string {
  const grouped = new Intl.NumberFormat(language(), { maximumFractionDigits: 0 }).format(Math.round(value));
  return t('economy.money', { value: grouped });
}

/** What a road in hand costs, for the preview: its price, or what a demolition-like edit gives back. */
export function formatCost(cost: number): string {
  return cost < 0 ? t('economy.refund', { value: formatMoney(-cost) }) : formatMoney(cost);
}

/** The balance's tooltip, with the demolition share the game uses. */
export function balanceTip(): string {
  return t('economy.balance', { share: Math.round(ROAD_TUNING.economy.demolitionRefund * 100) });
}

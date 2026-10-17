// @vitest-environment happy-dom Money as the player reads it.
import { describe, expect, it } from 'vitest';
import { formatMoney } from '@ui/roads/money';
import { setLanguage, t } from '@ui/i18n';

/** MONEY AS THE PLAYER READS IT, WITH NO FORMATTER MADE PER CALL (`ui/roads/money.ts`, plan K4) */
describe('money', () => {
  it('reads as the language writes a whole number, grouped', () => {
    for (const lang of ['pt-BR', 'en'] as const) {
      setLanguage(lang);
      for (const value of [0, 1234567.6, -980.2]) {
        const grouped = new Intl.NumberFormat(lang, { maximumFractionDigits: 0 }).format(Math.round(value));
        expect(formatMoney(value)).toBe(t('economy.money', { value: grouped }));
      }
    }
  });
});

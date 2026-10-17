// @vitest-environment happy-dom Counts read in the right number, and the language when the browser lists none.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initLanguage, plural, setLanguage, t } from '@ui/i18n';

afterEach(() => { vi.unstubAllGlobals(); });

/** ONE LANE, ONE VEHICLE (plan K9): the counts the game shows read in the singular for one, in both languages */
describe('the counts', () => {
  it('read "1 faixa" and "1 lane", "2 faixas" and "2 lanes"', () => {
    setLanguage('pt-BR');
    expect(plural('palette.lanes.count', 1)).toBe('1 faixa');
    expect(plural('palette.lanes.count', 2)).toBe('2 faixas');
    expect(plural('inspector.capacityValue', 1)).toBe('1 veículo');
    expect(t('catalog.tip', { name: 'Rua', lanes: plural('palette.lanes.count', 1), way: 'mão única', speed: 30 })).toContain('1 faixa,');
    setLanguage('en');
    expect(plural('palette.lanes.count', 1)).toBe('1 lane');
    expect(plural('inspector.capacityValue', 3)).toBe('3 vehicles');
  });

  it('takes the single language of the browser when its list is empty', () => {
    window.localStorage.clear();
    vi.stubGlobal('navigator', { languages: [], language: 'pt-BR' });
    expect(initLanguage()).toBe('pt-BR');
  });
});

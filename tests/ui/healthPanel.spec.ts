// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

import { HealthLog } from '@core/health';
import { mountHealthPanel } from '@ui/healthPanel';
import { t } from '@ui/i18n';

/** F9's panel: its button is handed to whoever lays out the top bar */
describe('health panel', () => {
  const mount = () => mountHealthPanel({ log: new HealthLog(), world: () => [], state: () => ({ now: [], changes: [] }) });

  it('hands its button over instead of looking for the top bar', () => {
    vi.useFakeTimers();
    try {
      const panel = mount();
      vi.advanceTimersByTime(5000);
      expect(panel.button.isConnected).toBe(false);
      document.body.appendChild(panel.button);
      expect(panel.button.getAttribute('aria-label')).toBe(t('health.button'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('says so when the log cannot be copied', async () => {
    const panel = mount();
    panel.toggle();
    const copy = document.querySelector<HTMLButtonElement>('.health-copy')!;
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } });
    try {
      copy.click();
      await Promise.resolve();
      await Promise.resolve();
      expect(copy.textContent).toBe(t('health.copyFailed'));
    } finally {
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});

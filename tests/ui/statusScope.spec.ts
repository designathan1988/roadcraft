import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EN } from '@ui/i18n/en';
import { PT_BR } from '@ui/i18n/pt-BR';
import { statusScopeTip } from '@/ui/labels';

/** THE TOP BAR SAYS WHAT ITS COUNTS COUNT (plan, step 8, K9): in a streamed world the region round the camera, not the whole city */
describe("the top bar's counts", () => {
  it('say they are the region round the camera in a streamed world, in both languages', () => {
    expect(PT_BR['status.region']).toMatch(/região/);
    expect(EN['status.region']).toMatch(/region/);
    expect(statusScopeTip(true)).toBeTruthy();
    // A map held whole: its counts are the city's, nothing added.
    expect(statusScopeTip(false)).toBe('');
  });

  it('are told with their reach by the game, and the bar shows it on them', () => {
    expect(readFileSync('src/main.ts', 'utf8')).toMatch(/region: streamed !== null/);
    const shell = readFileSync('src/ui/v2/shell.ts', 'utf8');
    expect(shell).toMatch(/statusScopeTip\(now\.region\)/);
    expect(shell).toMatch(/stats\.title = scope/);
  });
});

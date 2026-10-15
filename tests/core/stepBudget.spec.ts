import { describe, expect, it } from 'vitest';
import { stepBudget } from '@core/perfBudget';

/** A measured step finds its row by its whole name, spaces and all. */
describe('step budgets', () => {
  it('matches a step whose name holds a space', () => {
    expect(stepBudget('hitch:mutate/after edit')?.key).toBe('mutate/after edit');
    expect(stepBudget('hitch:road-edit/world rebuilt')?.key).toBe('road-edit/world rebuilt');
  });
  it('still reads a step with a detail after its name, and none for an unknown one', () => {
    expect(stepBudget('hitch:network/rebuild 3 segments')?.key).toBe('network/rebuild');
    expect(stepBudget('hitch:nothing/here')).toBeNull();
  });
});

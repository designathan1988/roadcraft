// @vitest-environment happy-dom
// The flight's head-up display (AS14): the pitch ladder signed as aviation
// HUDs mark it - with the nose down the player read 10/20/30 with no sign.
import { describe, expect, it } from 'vitest';
import { mountFlightCockpit } from '@ui/flightCockpit';

describe('the flight cockpit', () => {
  it('marks the rungs below the horizon minus and dashed, those above plain and solid', () => {
    const cockpit = mountFlightCockpit(document.body);
    cockpit.show(true);
    cockpit.update({ speed: 25, height: 5, unit: 1, throttle: 1, pitch: (-20 * Math.PI) / 180, horizon: 1, warp: 0, fov: 50 });
    const rungs = [...cockpit.element.querySelectorAll('text')]
      .map((t) => ({ label: t.textContent ?? '', dash: t.previousElementSibling?.getAttribute('stroke-dasharray') ?? '' }))
      .filter((r) => /^[−-]?\d+$/.test(r.label));
    expect(rungs.map((r) => r.label)).toEqual(['−30', '−20', '−10', '10', '20', '30']);
    for (const r of rungs) expect(r.dash !== '', r.label).toBe(r.label.startsWith('−'));
    cockpit.element.remove();
  });
});

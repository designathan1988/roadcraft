// @vitest-environment happy-dom A transport line's name and colour come from the map file
import { describe, expect, it } from 'vitest';
import { transitLineRow } from '@ui/v2/transitLine';
import { normalizeTransit } from '@world/transit';

const HOSTILE_NAME = '<img src=x onerror="globalThis.__xss = 1">';
const HOSTILE_COLOUR = 'red"><img src=x onerror="globalThis.__xss = 1">';

/** A saved transport with one bus line of two stops, its name and colour as given. */
const saved = (name: unknown, colour: unknown): unknown => ({
  stops: [{ id: 1, mode: 'bus', x: 0, y: 0 }, { id: 2, mode: 'bus', x: 10, y: 0 }],
  lines: [{ id: 3, mode: 'bus', stops: [1, 2], colour, name, vehicles: 2 }],
});

describe('a transport line read from a map file', () => {
  it('keeps its colour only as #rrggbb', () => {
    expect(normalizeTransit(saved('A', '#2F7DE1')).lines[0]!.colour).toBe('#2F7DE1');
    for (const bad of [HOSTILE_COLOUR, 'rgb(1, 2, 3)', 'url(x)', '#12345', '#1234567', 42]) {
      expect(normalizeTransit(saved('A', bad)).lines[0]!.colour, String(bad)).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('shows its name as text, and no element comes of its name or its colour', () => {
    // The colour given straight to the row: the row is safe on its own, whatever reaches it.
    const line = { ...normalizeTransit(saved(HOSTILE_NAME, '#2f7de1')).lines[0]!, colour: HOSTILE_COLOUR };
    const row = transitLineRow(line);
    expect(row.querySelector('img')).toBeNull();
    expect(row.children.length).toBe(3);
    expect(row.querySelector('b')?.textContent).toBe(HOSTILE_NAME);
  });
});

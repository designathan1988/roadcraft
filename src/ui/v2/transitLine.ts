import type { TransitLine } from '@world/transit';
import { t } from '../i18n';

/**
 * A transport line's row in the transport tool's list: its colour, its name, its mode and stops.
 * Its name and colour come from the map file, which anyone may have made: the name goes in as
 * text and the colour into one fixed style property (OWASP XSS Prevention Cheat Sheet: safe
 * sinks; "a fixed property such as element.style.color"). DO NOT build this row with innerHTML:
 * a name `<img src=x onerror=…>` ran its script when the panel opened.
 */
export function transitLineRow(line: TransitLine): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'v2-transit-line';
  const swatch = document.createElement('i');
  swatch.style.background = line.colour;
  const name = document.createElement('b');
  name.textContent = line.name;
  const about = document.createElement('span');
  about.textContent = `${t(`transit.mode.${line.mode}`)} · ${t('transit.stops', { n: line.stops.length })}`;
  row.append(swatch, name, about);
  return row;
}

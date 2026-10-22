import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/** The invariants that are about the SOURCE rather than about the geometry. */

const SRC = join(process.cwd(), 'src');

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...tsFilesUnder(path));
    else if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** Source with comments stripped, so a mention in prose is not a call. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('determinism', () => {
  it('never calls Math.random in world or sim', () => {
    const offenders: string[] = [];

    for (const layer of ['world', 'sim']) {
      for (const file of tsFilesUnder(join(SRC, layer))) {
        const body = code(readFileSync(file, 'utf8'));
        const line = body.split('\n').findIndex((l) => l.includes('Math.random'));
        if (line >= 0) offenders.push(`${relative(SRC, file).split(sep).join('/')}:${line + 1}`);
      }
    }

    // `core/rng.ts` exists for exactly this.
    expect(offenders, `use Rng from @core/rng instead:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('keeps three.js inside the render layer', () => {
    // The other rule CLAUDE.md states in bold: nothing outside `src/render/` may import three.
    const offenders: string[] = [];

    for (const file of tsFilesUnder(SRC)) {
      const rel = relative(SRC, file).split(sep).join('/');
      // The debugging lab inspects the scene itself (picking, its materials, its draws), and the people lab is a 3D page of its own (sculpting,
      // posing, dressing one figure): the places above render that hold three's objects. Nothing of the game imports either.
      if (rel.startsWith('render/') || rel.startsWith('lab/') || rel.startsWith('peopleLab/')) continue;
      const body = code(readFileSync(file, 'utf8'));
      if (/from '(three|three\/[^']*)'/.test(body)) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });
});

describe('one writer per number', () => {
  it('declares the footway height once, in world', () => {
    // It was two constants of one value, `FOOTWAY_RISE` in render and `FOOTWAY_DEPTH` in world/elevation.ts
    const declarations = tsFilesUnder(SRC)
      .filter((file) => /const\s+FOOTWAY_(RISE|DEPTH)\s*=/.test(code(readFileSync(file, 'utf8'))))
      .map((file) => relative(SRC, file).split(sep).join('/'));
    expect(declarations).toEqual(['world/roadTypes.ts']);
  });
});

describe('the document changes only through its diary', () => {
  it('keeps no revision counter of its own: every revision is read from the diary', () => {
    // `RoadDoc.revision`, `terrainRevision`... and `buildings.revision` are the serial of the latest diary entry of their kind
    const owners = ['world/doc.ts', 'world/buildings/store.ts'];
    const offenders: string[] = [];
    for (const file of owners) {
      const lines = code(readFileSync(join(SRC, file), 'utf8')).split('\n');
      lines.forEach((l, i) => {
        if (/\b(revision|[a-z]\w*Revision)\s*(\+\+|\+=|-=|=(?!=))/.test(l)) offenders.push(`${file}:${i + 1}: ${l.trim()}`);
      });
    }
    // Nobody else writes one either the getters refuse it at compile time; this names the place if a counter comes back as a
    for (const layer of ['world', 'editor', 'ui']) {
      for (const path of tsFilesUnder(join(SRC, layer))) {
        const lines = code(readFileSync(path, 'utf8')).split('\n');
        lines.forEach((l, i) => {
          if (/\bdoc\.(buildings\.)?(revision|\w+Revision)\s*(\+\+|\+=|=(?!=))/.test(l)) {
            offenders.push(`${relative(SRC, path).split(sep).join('/')}:${i + 1}: ${l.trim()}`);
          }
        });
      }
    }
    expect(offenders, `write the change in the diary instead (doc.changes.record, zonesChanged, lotsChanged):\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('the simulation is headless', () => {
  it('never reads window or document in world or sim', () => {
    // The spawners read `window.innerWidth`, so one seed grew a different city on a phone and `sim` depended on the DOM.
    const offenders = tsFilesUnder(SRC)
      .filter((file) => /[/\\](world|sim)[/\\]/.test(file))
      .filter((file) => /\b(window|document)\s*\./.test(code(readFileSync(file, 'utf8'))))
      .map((file) => relative(SRC, file).split(sep).join('/'));
    expect(offenders).toEqual([]);
  });
});

describe('nothing simulated that cannot be drawn', () => {
  it('sizes the agent buffers from the simulation ceilings', () => {
    // The sim allowed 3000 vehicles and 1500 people against buffers of 1200 and 1000
    const agents = code(readFileSync(join(SRC, 'render', 'agents.ts'), 'utf8'));
    expect(agents).toMatch(/const MAX_VEHICLES = FLEET_CEILING;/);
    expect(agents).toMatch(/const MAX_PEDS = PED_CEILING;/);
  });
});

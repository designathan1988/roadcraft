import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EN } from '@ui/i18n/en';
import { PT_BR } from '@ui/i18n/pt-BR';

/**
 * THE OLD INTERFACE IS GONE, AND EVERYTHING IT DID IS IN THE NEW ONE
 * (docs/PLANO.md 5g, "interface v2 sem a antiga").
 *
 * The old interface's markup and code left in 5g (a268a2ff); what it left
 * behind was its styling (rules for a top bar, a toolbar, palettes, a status
 * bar, a minimap, the Builder's own bars), its words, and a few hooks only it
 * listened to. A rule that needs a class or an id no code or page makes can
 * never match: none may be left. And each thing the old interface could do -
 * its controls, read off its last index.html - has its control in the v2
 * shell (`ui/v2/shell.ts`) or in the game's commands it is handed.
 */
const root = fileURLToPath(new URL('../../', import.meta.url));
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return name === 'i18n' || name === 'studios' || name === 'atelier' ? [] : walk(path);
  return /\.(ts|tsx|html)$/.test(name) ? [path] : [];
});
const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
const corpus = [...walk(join(root, 'src')), join(root, 'index.html')].map((p) => strip(readFileSync(p, 'utf8'))).join('\n');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const SHEETS = ['src/ui/app.css', 'src/ui/builder/workspace.css', 'src/ui/roads/roads.css', 'src/ui/v2/shell.css'];

/** Every rule's selectors of a stylesheet (in @media and @supports too; @keyframes' steps are not selectors). */
function selectorsOf(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  let i = 0;
  const block = (inKeyframes: boolean): void => {
    let prelude = '';
    while (i < text.length) {
      const c = text[i++]!;
      if (c === '}') return;
      if (c === ';') { prelude = ''; continue; }
      if (c !== '{') { prelude += c; continue; }
      const head = prelude.trim();
      prelude = '';
      if (head.startsWith('@')) block(/^@(-\w+-)?keyframes/.test(head));
      else {
        if (!inKeyframes) out.push(...head.split(/,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean));
        // A rule's own body: skip to its end.
        let depth = 1;
        while (i < text.length && depth > 0) { const d = text[i++]; if (d === '{') depth++; else if (d === '}') depth--; }
      }
    }
  };
  block(false);
  return out;
}
/**
 * The words that can be a class or an id: those inside the code's strings
 * (quoted, templated) and the pages' attribute values - not identifiers: a
 * class named like a variable (`tool`, `hint`) is alive only if a string
 * carries it.
 */
const words = new Set<string>();
for (const m of corpus.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)) {
  for (const w of m[0].split(/[^\w-]+/)) if (w) words.add(w);
}
const alive = (token: string): boolean => words.has(token);
/** The classes and ids a selector needs (inside :not, :has, :is and :where none is required). */
const needs = (selector: string): string[] => {
  const plain = selector.replace(/:(not|has|is|where)\((?:[^()]|\([^()]*\))*\)/g, '').replace(/\[[^\]]*\]/g, '');
  return [...plain.matchAll(/[.#](-?[A-Za-z_][\w-]*)/g)].map((m) => m[1]!);
};

describe('the old interface', () => {
  it('left no style rule that can match nothing', () => {
    const dead: string[] = [];
    for (const sheet of SHEETS) {
      for (const selector of selectorsOf(read(sheet))) if (!needs(selector).every(alive)) dead.push(`${sheet}: ${selector}`);
    }
    expect(dead).toEqual([]);
  });

  it('left none of its own controls, words or hooks', () => {
    // Its controls' ids and classes: the top bar, the palettes, the status bar, the minimap, the Builder's bars.
    for (const name of ['topMenu', 'moreMenu', 'minimapPanel', 'minimapBody', 'statusbar', 'roadHeightContext', 'terrainPalette', 'paletteBody',
      'bw-hide-legacy', 'bw-rail', 'bw-dock', 'bw-top', 'road-palette', 'terrain-palette', 'simulation-controls', 'minimap-panel']) {
      expect(alive(name), name).toBe(false);
    }
    expect(read('index.html')).not.toMatch(/data-ui=/);
    // Its words, in both dictionaries.
    const OLD_KEYS = ['palette.title', 'palette.label', 'palette.prev', 'palette.next', 'palette.classes', 'palette.height.raise', 'palette.height.lower',
      'minimap.title', 'minimap.label', 'minimap.move', 'sim.title', 'sim.label', 'tools.label', 'action.more', 'action.language', 'action.quality',
      'action.traffic', 'atmo.clouds', 'atmo.cloudBase', 'atmo.cloudThickness', 'app.tagline', 'status.clear', 'builder.view.top', 'builder.view.turnLeft',
      'builder.view.turnRight', 'builder.floor.insertAbove', 'builder.floor.insertBelow', 'builder.seeAll', 'builder.models.remove', 'builder.dock.close'];
    for (const key of OLD_KEYS) {
      expect(key in EN, key).toBe(false);
      expect(key in PT_BR, key).toBe(false);
    }
    // Hooks only it listened to.
    for (const hook of ['TERRAIN_SHADE', 'onCutWallsChange', 'onDrawProfileChange']) expect(alive(hook), hook).toBe(false);
  });

  it('did nothing the v2 shell cannot do', () => {
    const shell = read('src/ui/v2/shell.ts');
    const main = read('src/main.ts');
    // The old index.html's controls (a268a2ff^), each with where it is now.
    const commands: Record<string, string> = {
      newMap: 'deps.newMap()', openMap: 'deps.openMap()', saveMap: 'deps.saveMap()', undoAction: 'deps.undo()', redoAction: 'deps.redo()',
      aboutButton: 'deps.about', qualitySelect: 'deps.setQuality', languageSelect: 'setLanguage(', paintStyleSelect: 'deps.setMarkingStyle',
      skyMode: 'deps.setSky', playButton: 'deps.setSpeed', trafficToggle: 'deps.setSpeed', congestionToggle: 'deps.toggleCongestion',
      demandLevel: 'deps.setDemand', perspectiveToggle: "'perspective'", resetView: "'reset'", cameraControls: "'turnLeft'",
      metricTrips: "'trips'", metricLost: "'lost'", metricSpeed: "'meanSpeed'", metricQueued: "'queued'", cityClock: 'now.clock',
      vehicleCount: 'now.vehicles', pedCount: 'now.people', roadLanes: 'deps.setLanes', roadTypes: 'deps.selectRoadType',
      roadHeightValue: 'deps.stepRoadHeight', zonePalette: 'deps.setZone', zoneRemove: 'eraser: true', terrainPalette: 'deps.setTerrainMode',
      // The old status bar's numbers: in the Simulation menu (the network) and the Camera menu (zoom, centre).
      roadCount: 'roadCountLabel(r.roads)', nodeCount: 'nodeCountLabel(r.nodes)', zoomReadout: "t('camera.zoom')", coordReadout: "t('camera.centre')",
    };
    const missing = Object.entries(commands).filter(([, evidence]) => !shell.includes(evidence)).map(([id]) => id);
    expect(missing).toEqual([]);
    // The old sliders and the whole map's actions, by the names the shell asks the game for.
    const SLIDERS = ['terrainRadius', 'terrainStrength', 'terrainHardness', 'gullyStrength', 'gullyAuto', 'waterWaves', 'waterFoam', 'waterCurrent',
      'weatherRain', 'weatherWind', 'weatherWindDir', 'weatherLightning', 'weatherThunder', 'treeDensity', 'treeHeight', 'treeVariation', 'treeSpacing',
      'elDensity', 'elSize', 'elVariation', 'elSpacing', 'elStrength', 'elIntensity', 'cloudSize', 'cloudHeight', 'cloudDensity', 'cloudCount',
      'cloudVariation', 'fogStrength', 'fogHeight', 'fogSpeed', 'fogMapDensity', 'atmoFog', 'atmoFogHeight', 'trafficIntensity', 'pedIntensity'];
    for (const slider of SLIDERS) {
      expect(shell, slider).toContain(`'${slider}'`);
      expect(main, slider).toMatch(new RegExp(`\\b${slider}:`));
    }
    for (const action of ['clearTerrain', 'clearGullies', 'clearFog', 'clearTrees', 'clearElements', 'clearClouds', 'scatterClouds']) {
      expect(shell, action).toContain(`'${action}'`);
    }
  });
});

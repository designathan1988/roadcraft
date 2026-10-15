import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE SITES GRADED AS THEIR BUILDINGS COME (2026-10-15): what made one frame
 * of a growing 2,560 m city 10 s, checked in the code itself so it cannot
 * come back unseen:
 * - the frames grade the sites while a world job makes its road tiles; only
 *   its own ground steps hold them (`worldJobGround`);
 * - a shaping pass over regions asks the regions' corners (`shapeCorners`),
 *   never every box of the town against every region
 *   (tests/render/terrainShaping.spec.ts counts it);
 * - the camera's solids are not floored again round a graded site: a floor
 *   reads the land and the paving, not the graded ground (`floorGroundSince`);
 * - a site's platform is worked out alone (`padOf`), not filed as a town of
 *   one; a building's frame is turned once, not a cosine and a sine a point.
 */
const read = (path: string): string => readFileSync(path, 'utf8');
/** Comments blanked: a word in a note is not code. */
const code = (path: string): string => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

describe('the sites graded', () => {
  it('in the frames while a world job makes its road tiles', () => {
    const renderer = code('src/render/renderer.ts');
    expect(renderer).toMatch(/if \(!\(worldJob && worldJobGround\) && gradedFor !== net\.doc\.buildings\.revision\)/);
    expect(renderer).not.toMatch(/if \(!worldJob && gradedFor/);
    // Set when the job starts, cleared once its ground is shaped.
    expect(renderer).toMatch(/worldJob = worldSteps\([^;]*\);\s*worldJobFresh = true;\s*worldJobGround = true;/);
    expect(renderer).toMatch(/yield\* shapeBlocksSteps\(net, blocks\);\s*pendingBlocks = \[\];\s*worldJobGround = false;/);
  });

  it('shape the corners of their regions, not every box against every region', () => {
    const terrain = code('src/render/terrain.ts');
    const pass = terrain.slice(terrain.indexOf('const shapeToRoads = ('), terrain.indexOf('const normal = geometry.getAttribute'));
    expect(pass).toMatch(/shapeCorners\(corners, natural, shape, regions, visited, pass,/);
    expect(pass).not.toMatch(/shapeBounds\(\)/);
  });

  it('do not floor the camera\'s solids again', () => {
    const renderer = code('src/render/renderer.ts');
    expect(renderer).toMatch(/cameraSolidsKept\.follow\(net\.doc\.buildings, floorGroundSince\)/);
    expect(renderer).toMatch(/if \(sites && serial\) sitesGradedSerials\.add\(serial\);/);
  });

  it('work each platform out alone, each building\'s frame turned once', () => {
    expect(code('src/world/buildings/siteGrading.ts')).not.toMatch(/buildingPads\(\[/);
    for (const path of ['src/world/buildings/foundation.ts', 'src/world/buildings/lots.ts']) {
      expect(code(path), path).not.toMatch(/\blocalToWorld\(|\bworldToLocal\(/);
    }
  });
});

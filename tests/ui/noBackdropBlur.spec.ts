import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** DECISION 5.5: NO PANEL BLURS WHAT IS BEHIND IT - the 3D canvas changes every frame, and a blur behind a panel 90-97% opaque was made again every frame for almost nothing to see */

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? cssFiles(path) : name.endsWith('.css') ? [path] : [];
  });
}

describe("the interface's style sheets", () => {
  it('blur nothing behind a panel', () => {
    const blurred = cssFiles('src').filter((file) => /backdrop-filter:\s*blur/.test(readFileSync(file, 'utf8')));
    expect(blurred).toEqual([]);
  });
});

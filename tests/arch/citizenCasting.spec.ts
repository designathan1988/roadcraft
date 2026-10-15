import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';
import { CastingRegistry, CROWD, compatible, type CitizenModel } from '@render/citizenCasting';

/** ONE DOOR INTO THE ROSTER. */
const SRC = join(process.cwd(), 'src');
const ALLOWED = new Set(['render/citizenCasting.ts', 'render/citizenCatalog.ts']);
const ROSTER = /citizens\.manifest|citizenCatalog|CITIZEN_CATALOG|CITIZEN_MODELS/;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...tsFilesUnder(path));
    else if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('citizen casting', () => {
  it('is the only module that reads the roster', () => {
    const offenders = tsFilesUnder(SRC)
      .map((file) => relative(SRC, file).split(sep).join('/'))
      .filter((file) => !ALLOWED.has(file) && ROSTER.test(code(readFileSync(join(SRC, file), 'utf8'))));
    expect(offenders).toEqual([]);
  });

  it('casts every child as a child body even when nearby child models are already worn', () => {
    const casting = new CastingRegistry();
    casting.beginFrame();
    for (let seed = 1; seed <= 40; seed++) {
      const body = casting.pickCitizenModel({
        seed, gender: seed % 2 ? 'f' : 'm', ageClass: 'child',
        company: 'family', companyId: Math.ceil(seed / 4), hasChild: true,
        x: 0, y: 0,
      });
      expect(body, `child ${seed}`).not.toBeNull();
      expect(CROWD[body!.index]!.ageBand, `child ${seed}`).toBe('child');
      expect(body!.size, `child ${seed}`).toBe(1);
    }
  });

  it('keeps a picked-up walker recognizable while recasting incompatible car occupants', () => {
    const roster: CitizenModel[] = [
      { id: 'smart', wardrobe: 'smart-casual', ageBand: 'adult', gender: 'f' },
      { id: 'sport', wardrobe: 'sport-casual', ageBand: 'adult', gender: 'f' },
      { id: 'casual', wardrobe: 'casual', ageBand: 'adult', gender: 'f' },
    ];
    let checked = false;
    for (let vehicleId = 1; vehicleId <= 100 && !checked; vehicleId++) {
      const casting = new CastingRegistry(roster);
      const walker = { seed: 7, gender: 'f' as const, ageClass: 'adult' as const,
        company: 'colleagues' as const, companyId: 700, x: 0, y: 0 };
      const car = { ...walker, seed: 10_000 + vehicleId, company: 'car' as const, companyId: vehicleId };
      const beforeWalker = casting.pickCitizenModel(walker)!;
      const beforeCar = casting.pickCitizenModel(car)!;
      if (roster[beforeCar.index]?.wardrobe !== 'sport-casual') continue;
      const boarded = casting.pickCitizenModel({ ...walker, company: 'car', companyId: vehicleId })!;
      const afterCar = casting.pickCitizenModel(car)!;
      expect(boarded.index).toBe(beforeWalker.index);
      expect(compatible(roster[boarded.index]!.wardrobe, roster[afterCar.index]!.wardrobe)).toBe(true);
      checked = true;
    }
    expect(checked).toBe(true);
  });

  it('keeps a person in their clothes for good, however long out of sight and wherever they come back', () => {
    // A walker seen, then out of sight for minutes while the street fills with others
    const roster: CitizenModel[] = ['a', 'b', 'c'].map((id) => ({ id, wardrobe: 'casual' as const, ageBand: 'adult' as const, gender: 'f' as const }));
    const walker = { seed: 1, gender: 'f' as const, ageClass: 'adult' as const, company: 'solo' as const, companyId: 1, x: 0, y: 0 };
    const plain = new CastingRegistry(roster).pickCitizenModel({ ...walker, x: 9000, y: 9000 })!.index;
    const casting = new CastingRegistry(roster);
    casting.beginFrame();
    let other = 1000;
    while (casting.pickCitizenModel({ seed: other, gender: 'f', ageClass: 'adult', company: 'solo', companyId: other, x: 0, y: 0 })!.index !== plain) other++;
    const first = casting.pickCitizenModel(walker)!.index;
    expect(first).not.toBe(plain);
    for (let frame = 0; frame < 20_000; frame++) casting.beginFrame();
    expect(casting.pickCitizenModel({ ...walker, x: 9000, y: 9000 })!.index).toBe(first);
  });

  it('never re-dresses the members of a party on foot when somebody joins it', () => {
    const casting = new CastingRegistry();
    casting.beginFrame();
    const party = [1, 2, 3].map((seed) => ({ seed, gender: 'm' as const, ageClass: 'adult' as const, company: 'friends' as const, companyId: 9, x: 0, y: 0 }));
    const before = party.map((p) => casting.pickCitizenModel(p)!.index);
    for (let other = 100; other < 160; other++) {
      // Somebody from another company joins the party.
      casting.pickCitizenModel({ seed: other, gender: 'f', ageClass: 'adult', company: 'colleagues', companyId: other, x: 0, y: 0 });
      casting.pickCitizenModel({ seed: other, gender: 'f', ageClass: 'adult', company: 'friends', companyId: 9, x: 0, y: 0 });
    }
    expect(party.map((p) => casting.pickCitizenModel(p)!.index)).toEqual(before);
  });
});

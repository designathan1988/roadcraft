import { describe, expect, it } from 'vitest';
import { seatAgeClass, seatPerson } from '@sim/vehicles/kerbStops';

/** AGT-32: the age of a seat's person read without the person's object, the same as `seatPerson`. */
describe("a seat's age", () => {
  it('is the person seatPerson casts there, for seats picked and not, front and back', () => {
    for (let id = 0; id < 300; id++) {
      for (const doorsPerSide of [1, 2, 3]) {
        const v = { id, people: [undefined, 77 + id, undefined, undefined, 5] as number[], peopleAge: [undefined, 'elder', undefined, undefined, undefined] as never[], archetype: { doorsPerSide } };
        for (let seat = 0; seat < 8; seat++) expect(seatAgeClass(v, seat)).toBe(seatPerson(v, seat).ageClass);
      }
    }
  });
});

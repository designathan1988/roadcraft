import { m } from '../units';

/**
 * THE ROAD TUNING: every figure the road system is tuned by, in one place
 * (docs/VIAS.md, stage V0). Grades are rise over run; lengths and heights
 * are world units (`m()` turns a metre figure into them, one metre a unit).
 *
 * Two kinds of entry, never mixed up:
 *  - LIVE: a figure the game runs on today. It holds exactly the number the
 *    code had before this file existed (the tests in
 *    `tests/world/roadTuning.spec.ts` lock them); where the real-world
 *    reference differs it is written beside it as `reference`, and changing
 *    the live figure is the player's decision, not a refactor's.
 *  - NOT LIVE YET: a figure for a stage still to come (`bridge`, `tunnel.minCover`,
 *    `piers.reference`, `flow`), kept here so that stage starts from a sourced number.
 *
 * Sources (read 2026-10-09):
 *  - TxDOT Roadway Design Manual 4.8.1 "Grades" (grades under 5 % preferred,
 *    up to 15 % in very constrained conditions; one-way downgrades under 500 ft
 *    one point more) and its target-value tables for local roads and urban
 *    collectors (8 % on level ground):
 *    https://www.txdot.gov/manuals/des/rdw/chapter-4--basic-design-criteria/4-8-vertical-alignment/4-8-1-grades.html
 *  - TxDOT 4.8.6 "Vertical Clearance" (16.5 ft = 5.03 m over any road, 17.5 ft
 *    = 5.33 m for pedestrian bridges and sign gantries, never under 14.5 ft = 4.42 m):
 *    https://www.txdot.gov/manuals/des/rdw/chapter-4--basic-design-criteria/4-8-vertical-alignment/4-8-6-vertical-clearance.html
 *  - FHWA design standards (16 ft = 4.9 m rural Interstate, 14 ft = 4.3 m other
 *    urban routes): https://www.fhwa.dot.gov/design/design_standards.cfm
 *  - Wikipedia "Grade (slope)": Baldwin Street 34.8 %, the steepest street
 *    (Guinness): https://en.wikipedia.org/wiki/Grade_(slope)
 *  - JICA, North-South Express Railway study (Vietnam), ch. 2: embankments up to
 *    about 9 m, viaducts above; PC T-girder spans "generally L=30" m:
 *    https://openjicareport.jica.go.jp/pdf/12345716_02.pdf
 *  - Wikipedia "Tunnel construction": shallow tunnels are cut and cover, deep
 *    ones bored: https://en.wikipedia.org/wiki/Tunnel_construction
 *  - São José dos Campos, Lei 7.451/2007: "vão básico entre os postes de até
 *    35,00 m" in town, 70 m rural:
 *    https://servicos.sjc.sp.gov.br/Legislacao/Arquivos/Leis/2007/LE_2007_00007451.pdf
 *  - Flyvbjerg et al., "Comparison of Capital Costs per Route-Kilometre in Urban
 *    Rail" (arXiv 1303.6569): elevated construction 2 to 2.5 times, underground
 *    several times the cost of construction at grade: https://arxiv.org/pdf/1303.6569
 */
export const ROAD_TUNING = {
  grade: {
    /**
     * LIVE. Steepest grade of a road at grade (`elevation.ts` `GROUND_GRADE`).
     * Reference: 8 %, the TxDOT target for local roads and urban collectors on
     * level ground; 12 % is what the game has always used.
     */
    ground: 0.12,
    /** Reference for `ground` (not live): TxDOT local roads / urban collectors, level ground. */
    groundReference: 0.08,
    /**
     * LIVE. Steepest grade the road tool lays between two authored heights
     * before the height is cut short (`commit.ts`, the preview in `main.ts`):
     * the "12 % short ramp" of docs/VIAS.md, inside TxDOT's 15 % for very
     * constrained conditions.
     */
    authored: 0.12,
    /** LIVE. Straight part of a ramp up to a raised deck (`elevation.ts` `RAMP_GRADE`); see the reasoning there. */
    ramp: 0.16,
    /** LIVE. Steepest grade a deck takes to clear a rise under it (`elevation.ts` `DECK_GRADE`). */
    deck: 0.05,
    /** LIVE. Steepest grade a deck is carried up with to a higher deck it meets (`elevation.ts` `DECK_TIE`). */
    deckTie: 0.05,
    /** LIVE. A tunnel's approach ramps (`structures.ts` `TUNNEL_GRADE`). */
    tunnel: 0.13,
    /**
     * LIVE. Past this the editor refuses the road (`editRules.ts`): Baldwin
     * Street, 34.8 %, the steepest street there is.
     */
    refuse: 0.35,
  },
  clearance: {
    /**
     * LIVE. Height of an `elevated` deck's SURFACE over the ground under it
     * (`structures.ts`): 5.6 m, 4.4 m of headroom under the soffit.
     * It is also the vertical room two crossing roads need to pass
     * independently (`commit.ts` `CROSSING_CLEARANCE`, `editRules.ts`).
     */
    elevated: m(5.6),
    /** LIVE. A `bridge` deck's surface over the ground (`structures.ts`): 3 m. */
    bridge: m(3),
    /**
     * NOT LIVE YET (V3). Clear height over a road under any structure:
     * 5.5 m, over TxDOT's 5.03 m for vehicle overpasses and close to its
     * 5.33 m for footbridges and gantries.
     */
    overRoad: m(5.5),
    /**
     * NOT LIVE YET (V3). Clear height under an urban viaduct: 4.5 m, over
     * FHWA's 4.3 m for urban routes and TxDOT's absolute 4.42 m.
     */
    underUrbanViaduct: m(4.5),
  },
  structure: {
    /**
     * LIVE. Height over the natural ground at which a deck stands clear of it on
     * piers and stops shaping it (`elevation.ts` `LIFT_ON`/`LIFT_OFF`, 0.6 m to
     * 2.8 m). The economy prices a road over `pierFrom` as a viaduct.
     */
    liftOn: m(0.6),
    pierFrom: m(2.8),
    /**
     * NOT LIVE YET (V3). Height over the terrain past which a construction in the
     * air is a bridge rather than an embankment: 6 m (JICA builds embankments
     * up to about 9 m; the plan takes the lower, urban figure).
     */
    bridgeAbove: m(6),
  },
  tunnel: {
    /**
     * LIVE. Cover over a road at grade past which the road tool bores it as a
     * tunnel instead of cutting it (`commit.ts` `AUTO_TUNNEL_COVER`): 18 m,
     * the sixty feet past which builders have found a tunnel cheaper than a cutting.
     */
    autoCover: m(18),
    /**
     * NOT LIVE YET (V3). The least cover under which a road can run as a bored
     * tunnel when the player chooses one: 7 m, about one bore (shallower is
     * cut and cover, per "Tunnel construction").
     */
    minCover: m(7),
  },
  piers: {
    /** LIVE. Distance between the bents of an `elevated` road (`render/structures.ts`): 29.6 m. */
    spacingElevated: m(29.6),
    /** LIVE. Distance between the piers of a `bridge` (`render/structures.ts`): 38.4 m. */
    spacingBridge: m(38.4),
    /** NOT LIVE YET (V3). Pier spacing range for girder viaducts: 25 to 35 m (JICA: PC T-girders, generally 30 m). */
    reference: { min: m(25), max: m(35) },
  },
  poles: {
    /**
     * LIVE. Distance between poles laid along a run (`utilities.ts`): 38 m by
     * default, never under 18 m nor over 80 m. Reference: 30 to 38 m in town
     * (São José dos Campos: up to 35 m between lighting poles, 70 m rural).
     */
    spacing: m(38),
    minSpacing: m(18),
    maxSpacing: m(80),
    reference: { min: m(30), max: m(38) },
  },
  /**
   * LIVE (V5, `sim/roads/controlAdvisor.ts`): approach flows, vehicles an hour
   * entering the junction, past which a junction left on "automatic" steps up
   * its control, from the MUTCD (2009): sec. 2B.07 multi-way stop, 300 an hour
   * on the major road (both approaches) and 200 on the minor road; sec. 4C.02
   * Warrant 1, one lane each way, condition A 500 and 150 (the higher minor
   * approach), condition B 750 and 75. Stepped down under 80 % of a threshold.
   */
  flow: {
    stopMajor: 300,
    stopMinor: 200,
    signalMajor: 500,
    signalMinor: 150,
    signalMajorB: 750,
    signalMinorB: 75,
    stepDown: 0.8,
    /** How long a trend is measured before the control may change, and the least time between two changes, s. */
    trendWindow: 900,
  },
  economy: {
    /**
     * Money a new map, and a map saved before the economy, starts with: a
     * little more than the roads of the test town are worth at the prices
     * below (16.5 million, `maps/cidade-com-estacionamento.json`).
     */
    startingFunds: 20_000_000,
    /**
     * Price of one square metre of each element of the cross-section
     * (`world/economy.ts`): the carriageway (lanes and parking), the central
     * reservation, the footways. Game balance figures.
     */
    perSquareMetre: { carriageway: 150, median: 40, footway: 80 },
    /**
     * Price multiplier by how the road is built. A viaduct 2.5 and a tunnel 6
     * times a road at grade, as elevated and underground construction compare
     * in Flyvbjerg et al.; embankment and cutting between them.
     */
    structure: { ground: 1, embankment: 1.4, trench: 1.8, bridge: 2.5, tunnel: 6 },
    /** Authored height over the designed ground from which a road at grade is on an embankment, or in a cutting below its negative. */
    fillFrom: m(1),
    /** Share of a road's price given back when it is demolished. */
    demolitionRefund: 0.25,
  },
} as const;

export type RoadTuning = typeof ROAD_TUNING;

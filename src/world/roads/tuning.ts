import { m } from '../units';

/** THE ROAD TUNING: every figure the road system is tuned by, in one place. */
export const ROAD_TUNING = {
  grade: {
    /** LIVE. */
    ground: 0.12,
    /** Reference for `ground` (not live): TxDOT local roads / urban collectors, level ground. */
    groundReference: 0.08,
    /** LIVE. */
    authored: 0.12,
    /** LIVE. Straight part of a ramp up to a raised deck (`elevation.ts` `RAMP_GRADE`); see the reasoning there. */
    ramp: 0.16,
    /** LIVE. Steepest grade a deck takes to clear a rise under it (`elevation.ts` `DECK_GRADE`). */
    deck: 0.05,
    /** LIVE. Steepest grade a deck is carried up with to a higher deck it meets (`elevation.ts` `DECK_TIE`). */
    deckTie: 0.05,
    /** LIVE. A tunnel's approach ramps (`structures.ts` `TUNNEL_GRADE`). */
    tunnel: 0.13,
    /** LIVE. */
    refuse: 0.35,
  },
  clearance: {
    /** LIVE. */
    elevated: m(5.6),
    /** LIVE. A `bridge` deck's surface over the ground (`structures.ts`): 3 m. */
    bridge: m(3),
    /** NOT LIVE YET (V3). */
    overRoad: m(5.5),
    /** NOT LIVE YET (V3). */
    underUrbanViaduct: m(4.5),
  },
  structure: {
    /** LIVE. */
    liftOn: m(0.6),
    pierFrom: m(2.8),
    /** NOT LIVE YET (V3). */
    bridgeAbove: m(6),
  },
  tunnel: {
    /** LIVE. */
    autoCover: m(18),
    /** NOT LIVE YET (V3). */
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
    /** LIVE. */
    spacing: m(38),
    minSpacing: m(18),
    maxSpacing: m(80),
    reference: { min: m(30), max: m(38) },
  },
  /** LIVE (V5, `sim/roads/controlAdvisor.ts`) */
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
    /** Money a new map, and a map saved before the economy, starts with */
    startingFunds: 20_000_000,
    /** Price of one square metre of each element of the cross-section (`world/economy.ts`): the carriageway */
    perSquareMetre: { carriageway: 150, median: 40, footway: 80 },
    /** Price multiplier by how the road is built. */
    structure: { ground: 1, embankment: 1.4, trench: 1.8, bridge: 2.5, tunnel: 6 },
    /** Authored height over the designed ground from which a road at grade is on an embankment, or in a cutting below its negative. */
    fillFrom: m(1),
    /** Share of a road's price given back when it is demolished. */
    demolitionRefund: 0.25,
  },
} as const;

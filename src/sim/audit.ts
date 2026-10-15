/** Invariant checker. */
export type AuditCode =
  // vehicles
  | 'greenBlocked'
  /** Held at a green past what any single interaction explains. */
  | 'greenHeld'
  | 'redEntry'
  | 'overlap'
  | 'nonMonotoneS'
  | 'routeless'
  | 'spillbackWedge'
  // claims
  | 'staleClaim'
  | 'orphanClaim'
  // signals
  | 'allRedTooLong'
  | 'groupStarved'
  | 'planCoverageGap'
  | 'degradedPlan'
  // pedestrians
  | 'pedFrozen'
  | 'pedInRoadStalled'
  | 'pedOutsideSidewalk'
  | 'pedSignalContradiction'
  // geometry
  | 'shortLink'
  | 'degenerateGeometry';

export interface AuditIssue {
  readonly code: AuditCode;
  readonly tick: number;
  readonly subject: string;
  readonly detail: string;
}

export const issue = (
  code: AuditCode,
  tick: number,
  subject: string | number,
  detail: string,
): AuditIssue => ({ code, tick, subject: String(subject), detail });

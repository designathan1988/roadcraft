import { seatFitScale, type SeatModel } from '@render/vehicleModels';

/** The largest size, metres per metre, a body is drawn at in this seat (`agents.ts`) */
export function occupantScale(seat: SeatModel): number {
  return seat.pose === 'car' ? seatFitScale(seat) : 1;
}

import { seatFitScale, type SeatModel } from '@render/vehicleModels';

/**
 * The largest size, metres per metre, a body is drawn at in this seat
 * (`agents.ts`): a car seat shrinks a tall person to fit (`seatFitScale`); an
 * upright cab or bus seat draws everybody at the size its pose was solved at,
 * 1, the feet put on the floor and the hands on the wheel by the pose itself.
 */
export function occupantScale(seat: SeatModel): number {
  return seat.pose === 'car' ? seatFitScale(seat) : 1;
}

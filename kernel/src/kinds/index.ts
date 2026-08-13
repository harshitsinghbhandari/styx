import { registerKind } from './registry.js';
import { PromiseKind } from './promise.js';
import { ReservationKind } from './reservation.js';

registerKind(PromiseKind);
registerKind(ReservationKind);

export * from './registry.js';

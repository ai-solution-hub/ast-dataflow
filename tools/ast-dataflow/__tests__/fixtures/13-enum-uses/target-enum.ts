/**
 * Fixture: target-enum.ts
 *
 * Declares the enum under test (OrderStatus) and its members.
 * This file also contains an internal use of the enum at module top level.
 */

export enum OrderStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  CLOSED = 'closed',
}

// Internal enum use at module top level — declaration file self-reference
const defaultStatus: OrderStatus = OrderStatus.PENDING;

export function getDefaultStatus(): OrderStatus {
  return defaultStatus;
}

/**
 * Fixture: case-member-access.ts
 *
 * Exercises PropertyAccessExpression against the enum identifier.
 * Each line is a distinct memberAccess row:
 *   - OrderStatus.PENDING  (line 9)
 *   - OrderStatus.ACTIVE   (line 10)
 *   - OrderStatus.CLOSED   (line 13)
 */

import { OrderStatus } from './target-enum';

export function getLabel(status: OrderStatus): string {
  if (status === OrderStatus.PENDING) {
    return 'pending';
  }
  if (status === OrderStatus.ACTIVE) {
    return 'active';
  }
  return 'closed';
}

export const SENTINEL = OrderStatus.CLOSED;

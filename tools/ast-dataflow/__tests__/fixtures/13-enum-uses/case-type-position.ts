/**
 * Fixture: case-type-position.ts
 *
 * Exercises type-position usages of the enum:
 *   - parameter type annotation  (line 10)
 *   - return type annotation     (line 10)
 *   - variable annotation        (line 15)
 *   - generic type argument      (line 18)
 */

import { OrderStatus } from './target-enum';

export function processStatus(status: OrderStatus): OrderStatus {
  return status;
}

export const currentStatus: OrderStatus = 'pending' as OrderStatus;

export type StatusList = Array<OrderStatus>;

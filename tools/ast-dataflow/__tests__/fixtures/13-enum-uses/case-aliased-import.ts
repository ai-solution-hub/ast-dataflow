/**
 * Fixture: case-aliased-import.ts
 *
 * Exercises enum member access when the enum is imported under an alias.
 * The alias `OS` is used for member access: OS.PENDING, OS.ACTIVE.
 * This exercises the "aliased import → member access" detection path.
 */

import { OrderStatus as OS } from './target-enum';

export function isActive(status: OS): boolean {
  return status === OS.ACTIVE;
}

export const FALLBACK_STATUS = OS.PENDING;

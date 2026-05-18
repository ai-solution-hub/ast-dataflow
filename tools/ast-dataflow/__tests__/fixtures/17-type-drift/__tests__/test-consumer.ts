/**
 * Test-only consumer — references TestOnlyResult.
 * This ensures TestOnlyResult gets classified as unused+testOnly.
 */

import type { TestOnlyResult } from '@/types/items';

export function makeTestResult(): TestOnlyResult {
  return { value: 42 };
}

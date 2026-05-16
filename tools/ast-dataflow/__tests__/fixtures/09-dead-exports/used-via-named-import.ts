/**
 * Fixture 2: used-via-named-import.ts
 *
 * Exports `namedImportTarget` which is consumed by
 * `consumer-named.ts` via `import { namedImportTarget } from ...`.
 * dead-exports must report reachableImporters >= 1 and NOT flag this
 * as dead.
 */
export function namedImportTarget(): number {
  return 42;
}

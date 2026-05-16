/**
 * Fixture 1: definitely-unused.ts
 *
 * Exports `unusedHelper` which is never imported by any other file in the
 * test project. dead-exports must classify it as reachableImporters === 0
 * and testOnlyImporters === 0.
 */
export function unusedHelper(): string {
  return 'I am unused everywhere';
}

// Internal reference — same-file usage must NOT count as an importer.
const _selfRef = unusedHelper();
void _selfRef;

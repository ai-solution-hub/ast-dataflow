/**
 * Fixture 6: same-file-only.ts
 *
 * Exports `sameFileExport` which is ONLY referenced within this file.
 * No other file imports it. This is the false-positive guard: the symbol
 * is exported and referenced, but only same-file usage must NOT count as
 * an importer.
 *
 * dead-exports must classify this as dead:
 *   reachableImporters === 0, testOnlyImporters === 0.
 */
export function sameFileExport(): number {
  return 99;
}

// This same-file usage must NOT prevent dead-export detection.
const _internal = sameFileExport();
void _internal;

/**
 * Fixture 5: used-via-barrel-reexport.ts
 *
 * Exports `barrelTarget` which is re-exported through `barrel-index.ts`
 * and consumed by `consumer-barrel.ts`. This is the key fixture proving
 * the barrel walker works: Knip may say "unused" because there is no
 * direct import, but the barrel walker finds the real importer.
 *
 * dead-exports must report barrelChain.length >= 1 and
 * reachableImporters >= 1.
 */
export function barrelTarget(): string {
  return 'I reach consumers via a barrel';
}

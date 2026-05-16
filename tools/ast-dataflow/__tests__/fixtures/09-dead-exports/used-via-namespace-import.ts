/**
 * Fixture 3: used-via-namespace-import.ts
 *
 * Exports `namespaceTarget` which is consumed by `consumer-namespace.ts`
 * via `import * as ns from ...`. dead-exports must report
 * reachableImporters >= 1 and NOT flag this as dead.
 */
export const namespaceTarget = 'reachable via namespace import';

export const siblingExport = 'also in the namespace';

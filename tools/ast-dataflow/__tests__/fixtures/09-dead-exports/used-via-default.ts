/**
 * Fixture 4: used-via-default.ts
 *
 * Default export consumed by `consumer-default.ts` via
 * `import defaultFn from ...`. dead-exports must report
 * reachableImporters >= 1 and NOT flag the default export as dead.
 */
export default function defaultExportedFn(): boolean {
  return true;
}

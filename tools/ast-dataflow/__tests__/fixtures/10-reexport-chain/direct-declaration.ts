/**
 * Fixture: direct-declaration.ts
 *
 * Scenario 1: directSymbol is declared here and imported directly
 * by direct-consumer.ts (no barrel hop). The reexport-chain query
 * should report:
 *   - 1 declaration row (kind: 'declaration', distance: 0, throughBarrel: null)
 *   - 1 importer row (kind: 'importer', distance: 0, throughBarrel: null)
 */
export function directSymbol(): string {
  return 'declared here, imported directly';
}

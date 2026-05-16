/**
 * Fixture: one-hop-source.ts
 *
 * Scenario 2: oneHopSymbol is declared here, re-exported via
 * one-hop-barrel.ts, and consumed by one-hop-consumer.ts.
 *
 * Expected reexport-chain rows:
 *   - declaration row: file='one-hop-source.ts', kind='declaration', distance=0
 *   - reexport row: file='one-hop-barrel.ts', kind='reexport', distance=1, throughBarrel='one-hop-barrel.ts'
 *   - importer row: file='one-hop-consumer.ts', kind='importer', distance=1, throughBarrel=null
 */
export function oneHopSymbol(): string {
  return 'reaches consumers via one barrel hop';
}

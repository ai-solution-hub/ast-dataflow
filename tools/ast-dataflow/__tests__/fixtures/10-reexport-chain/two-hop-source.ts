/**
 * Fixture: two-hop-source.ts
 *
 * Scenario 3: twoHopSymbol is declared here, re-exported through
 * two barrel hops (two-hop-barrel-a.ts → two-hop-barrel-b.ts),
 * and finally consumed by two-hop-consumer.ts.
 *
 * Expected reexport-chain rows:
 *   - declaration: file='two-hop-source.ts', kind='declaration', distance=0
 *   - reexport: file='two-hop-barrel-a.ts', kind='reexport', distance=1, throughBarrel='two-hop-barrel-a.ts'
 *   - reexport: file='two-hop-barrel-b.ts', kind='reexport', distance=2, throughBarrel='two-hop-barrel-b.ts'
 *   - importer: file='two-hop-consumer.ts', kind='importer', distance=2, throughBarrel=null
 */
export function twoHopSymbol(): string {
  return 'reaches consumers via two barrel hops';
}

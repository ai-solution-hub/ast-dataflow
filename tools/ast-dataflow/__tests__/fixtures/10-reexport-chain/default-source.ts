/**
 * Fixture: default-source.ts
 *
 * Scenario 5: a default export that is re-exported via a barrel and
 * consumed by default-consumer.ts via a default import.
 *
 * Expected reexport-chain rows:
 *   - declaration: file='default-source.ts', kind='declaration', distance=0, symbolName='default'
 *   - reexport: file='default-barrel.ts', kind='reexport', distance=1, symbolName='default'
 *   - importer: file='default-consumer.ts', kind='importer', distance=1
 */
export default function defaultSymbol(): string {
  return 'I am the default export';
}

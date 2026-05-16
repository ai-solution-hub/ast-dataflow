/**
 * Fixture: rename-source.ts
 *
 * Scenario 4: renamedSymbol is declared here, then re-exported under
 * a different name in rename-barrel.ts (`export { renamedSymbol as aliasedSymbol }`).
 * The consumer imports it as aliasedSymbol.
 *
 * The reexport-chain query must track the rename. The reexport row must
 * show the original symbolName ('renamedSymbol') and the barrel where
 * the rename occurs.
 */
export function renamedSymbol(): string {
  return 'I get a new name in the barrel';
}

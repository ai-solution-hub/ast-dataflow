/**
 * Fixture: rename-barrel.ts
 *
 * Scenario 4: re-exports renamedSymbol under a new name aliasedSymbol.
 * `export { renamedSymbol as aliasedSymbol } from './rename-source'`
 *
 * The reexport-chain query must track this rename: the reexport row's
 * symbolName is 'renamedSymbol' (original) and the throughBarrel is
 * 'rename-barrel.ts'.
 */
export { renamedSymbol as aliasedSymbol } from './rename-source.js';

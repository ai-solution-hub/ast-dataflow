/**
 * Fixture: one-hop-consumer.ts
 *
 * Imports oneHopSymbol from the barrel (one-hop-barrel.ts), not from the source.
 * This is the "importer" row in the reexport-chain result for scenario 2.
 */
import { oneHopSymbol } from './one-hop-barrel.js';

export function useOneHopSymbol(): string {
  return oneHopSymbol();
}

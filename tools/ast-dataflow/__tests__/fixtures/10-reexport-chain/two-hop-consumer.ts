/**
 * Fixture: two-hop-consumer.ts
 *
 * Imports twoHopSymbol from the second barrel (two-hop-barrel-b.ts).
 * This is the terminal "importer" row at distance=2 in scenario 3.
 */
import { twoHopSymbol } from './two-hop-barrel-b.js';

export function useTwoHopSymbol(): string {
  return twoHopSymbol();
}

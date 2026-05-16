/**
 * Fixture: rename-consumer.ts
 *
 * Scenario 4: consumes aliasedSymbol from rename-barrel.ts.
 * The terminal importer that uses the renamed export.
 */
import { aliasedSymbol } from './rename-barrel.js';

export function useRenamedSymbol(): string {
  return aliasedSymbol();
}

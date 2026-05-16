/**
 * Fixture: default-consumer.ts
 *
 * Scenario 5: imports the default export from the barrel.
 * This is the terminal importer for the default re-export scenario.
 */
import defaultSymbol from './default-barrel.js';

export function useDefaultSymbol(): string {
  return defaultSymbol();
}

/**
 * Fixture: direct-consumer.ts
 *
 * Imports directSymbol directly from its declaration file.
 * This is the "importer" row in the reexport-chain result for scenario 1.
 */
import { directSymbol } from './direct-declaration.js';

export function useDirectSymbol(): string {
  return directSymbol();
}

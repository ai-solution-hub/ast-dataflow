/**
 * Fixture: two-hop-barrel-a.ts
 *
 * First barrel hop in scenario 3. Re-exports twoHopSymbol from the source,
 * which two-hop-barrel-b.ts then re-exports again.
 */
export { twoHopSymbol } from './two-hop-source.js';

/**
 * Barrel file for fixture 5: re-exports barrelTarget, giving it
 * a one-hop reachability path to consumer-barrel.ts.
 *
 * This is the "barrel hop" the barrel walker must detect.
 * Note: KH enforces no-barrel-re-exports in production, but the
 * ast-dataflow tool must DETECT barrels to understand real reachability —
 * this is a test fixture, not production code.
 */
export { barrelTarget } from './used-via-barrel-reexport';

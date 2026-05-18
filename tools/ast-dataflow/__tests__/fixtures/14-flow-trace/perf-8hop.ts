/**
 * Performance fixture: 8-hop synthetic chain.
 * A linear assignment chain of 8 hops representing the worst-case depth.
 *
 * Used by performance.test.ts to validate the 10-second P95 budget (P-19).
 */

export function deepChain(input: string) {
  const a = input;
  const b = a;
  const c = b;
  const d = c;
  const e = d;
  const f = e;
  const g = f;
  const h = g;
  return h;
}

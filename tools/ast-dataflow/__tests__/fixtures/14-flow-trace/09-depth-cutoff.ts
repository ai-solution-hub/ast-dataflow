/**
 * Fixture 09: Depth cutoff.
 *
 * A 4-hop linear chain: a → b → c → d (each hop is a VariableDeclaration).
 * When invoked with maxDepth: 2, the walker should emit:
 *   hop 1 — origin (a), kind: assignment
 *   hop 2 — assignment b = a (depth 1)
 *   hop 3 — depthCutoff (depth 2 >= maxDepth 2 — cutoff fires before c = b is emitted)
 *
 * Expected with maxDepth: 2: 3 hops — origin, one real assignment, depthCutoff.
 */

export function longChain(input: string) {
  const a = input;
  const b = a;
  const c = b;
  const d = c;
  return d;
}

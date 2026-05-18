/**
 * Fixture 08: Cycle detection.
 *
 * The walker detects a cycle when `a` is assigned to `b` and then `b` is
 * re-assigned back to `a`. Starting from the declaration of `a` (hop 1):
 *   hop 2 — b = a (assignment)
 *   hop 3 — cycleCutoff: walking from `b` finds `a = b` where `a`'s
 *            declaration position is already in the visited-set (origin).
 *
 * No `return` in the function body to avoid extra return-hops from the
 * origin walk.
 *
 * Expected: 3 hops — origin (a), assignment (b=a), cycleCutoff.
 */

export function cyclePair(seed: number): void {
  let a = seed;
  const b = a;
  a = b;
  void a;
  void b;
}

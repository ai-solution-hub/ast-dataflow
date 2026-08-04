/**
 * Glob scoping, shared by every query that accepts `--scope`.
 *
 * Lived in type-drift-detect.ts and was imported across query files; it moved
 * here when callers/references gained the flag, so a general utility is not
 * owned by one query.
 */

/**
 * Compile a comma-separated glob list into a repo-relative path matcher.
 * An absent or empty list matches everything.
 *
 * Supports `**` (any depth) and `*` (within one segment).
 */
export function buildScopeMatcher(
  scope: string | undefined,
): (rel: string) => boolean {
  if (!scope) return () => true;
  const regexes = scope
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean)
    .map((glob) => {
      const source = glob
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '(?:[^/]+/)*')
        .replace(/\*\*/g, '.*')
        .replace(/(?<![.\])])\*/g, '[^/]*');
      return new RegExp(`^${source}$`);
    });
  if (regexes.length === 0) return () => true;
  return (rel: string) => regexes.some((r) => r.test(rel));
}

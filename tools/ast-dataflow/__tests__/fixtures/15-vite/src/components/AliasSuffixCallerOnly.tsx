/**
 * Vite fixture — tests alias-suffix matching fallback path.
 * This file only imports via relative path so we can test that the suffix
 * fallback in resolveTargetFilePath works for the ~/foo/bar query form
 * when the file is not directly importable via specifier match.
 *
 * The resolver must handle the case where modulePath is passed as a
 * non-@/ alias path (e.g. ~/utils/format) with no exact specifier match
 * in the corpus, and must fall back to stripped-alias suffix matching.
 */
import { formatCurrency } from '../utils/format';

export function AliasOnlyCallerBadge({ amount }: { amount: number }) {
  return formatCurrency(amount);
}

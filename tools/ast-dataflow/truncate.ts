import type { BaseResult } from './types';

/**
 * Spatial-coverage truncation (PRODUCT.md invariant 14).
 *
 * Result-set queries collect ALL hits, then truncate here: distinct files
 * come first, multiple hits per file thin last. Output order is a total
 * order on (file, line, column) — deterministic regardless of ts-morph
 * source-file discovery order.
 *
 * Exempt queries (rows are ordered hops, not a coverage set): flow-trace,
 * reexport-chain — see the exemption notes in their file headers.
 */
export interface SpatialTruncateResult<R extends BaseResult> {
  rows: R[]; // ≤ limit, sorted by (file, line, column)
  truncated: boolean; // allRows.length > limit
  totalEstimated: number | undefined; // allRows.length when truncated, else undefined (envelope convention)
}

const byFileLineCol = <R extends BaseResult>(a: R, b: R): number =>
  a.file < b.file
    ? -1
    : a.file > b.file
      ? 1
      : a.line - b.line || a.column - b.column;

export function truncateSpatial<R extends BaseResult>(
  allRows: readonly R[],
  limit: number,
): SpatialTruncateResult<R> {
  const sorted = [...allRows].sort(byFileLineCol);
  if (sorted.length <= limit) {
    return { rows: sorted, truncated: false, totalEstimated: undefined };
  }
  // Group by file; Map insertion order = file-sorted order.
  const byFile = new Map<string, R[]>();
  for (const r of sorted) {
    const g = byFile.get(r.file);
    if (g) g.push(r);
    else byFile.set(r.file, [r]);
  }
  const groups = [...byFile.values()];
  // Round-robin: round 0 takes each file's first hit in file order (distinct
  // files first); round k takes each file's (k+1)-th hit (multi-hit files
  // thin last — a heavy file's LATEST hits are dropped first).
  const picked: R[] = [];
  outer: for (let round = 0; ; round++) {
    let pushed = false;
    for (const hits of groups) {
      if (round >= hits.length) continue;
      picked.push(hits[round]);
      pushed = true;
      if (picked.length === limit) break outer;
    }
    if (!pushed) break; // defensive; unreachable when total > limit
  }
  picked.sort(byFileLineCol);
  return { rows: picked, truncated: true, totalEstimated: allRows.length };
}

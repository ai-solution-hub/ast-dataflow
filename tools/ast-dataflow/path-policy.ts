/**
 * Per-surface path policy for caller-supplied filesystem paths (issue #1,
 * audit finding HIGH-1 in docs/audits/mcp-audit-2026-08-04.md).
 *
 * Three query arguments name files this tool then reads. Left ungoverned they
 * read any host file the process can open, and the read/parse error split
 * doubles as a file-existence oracle:
 *
 *   - schema-coverage `evidence[]`  → readFileSync (queries/schema-coverage.ts)
 *   - dead-exports `symbolsFile`    → readFileSync (queries/dead-exports.ts)
 *   - fixture-uses `scope`          → glob discovery, then readFileSync on
 *                                     every discovered .json/.ts/.tsx/.md
 *
 * The two surfaces have different trust domains, so they get different
 * answers rather than one compromise:
 *
 *   - CLI  — no policy. The caller already has the shell's authority, and
 *            out-of-repo sidecars are a LIVE requirement: evidence producers
 *            (the Python companion's schema-uses sweep among them) default
 *            their sidecar output to a $TMPDIR directory and feed those
 *            absolute paths to `schema-coverage --evidence`. Confining the
 *            CLI would break that workflow as shipped.
 *   - MCP  — allowlist, defaulting to [repoRoot]. The caller is a model, not
 *            the operator, so reaching outside the repo is opt-in and is
 *            configured server-side at spawn, never per request.
 *
 * Rejection is decided on path SHAPE ONLY, before any filesystem call. A
 * policy that stat'd the path first would answer "outside the allowlist"
 * differently for a file that exists and one that does not, which is the
 * oracle the confinement exists to close.
 */

import { isAbsolute, resolve, sep } from 'node:path';
import type { QueryName } from './dispatch';

/**
 * The roots a surface will follow a caller-supplied path into. Absolute
 * directory paths; a path is allowed when it resolves to a root or beneath
 * one. An undefined policy means "no confinement" (the CLI).
 */
export interface PathPolicy {
  allowedRoots: readonly string[];
}

/** A rejection, in the shape the shared error envelope carries. */
export interface PathPolicyViolation {
  kind: 'path_not_allowed';
  message: string;
  hint: string;
}

/**
 * How one argument spells the paths it carries.
 *
 * `glob-csv` is its own kind because a glob is not a path: it cannot be
 * resolved to a single location, so it is judged on whether it can escape its
 * base at all rather than on where it lands.
 */
type PathArgKind = 'path' | 'path-list' | 'glob-csv';

interface PathArgSpec {
  key: string;
  kind: PathArgKind;
}

/**
 * Every query argument that reaches the filesystem, by query.
 *
 * Keyed by QueryName so the record is exhaustive: a query added to
 * QUERY_NAMES without a line here fails the type check, and cannot ship a new
 * ungoverned path argument by omission. An empty array is the positive claim
 * that the query takes no caller-supplied fs path.
 *
 * `scope` appears for fixture-uses ONLY. Everywhere else `scope` is a
 * comma-separated glob list compiled by buildScopeMatcher into an in-memory
 * matcher over repo-relative paths of files already in the ts-morph project —
 * it selects among files the corpus has, and never names a file to open.
 * fixture-uses is the exception: the root tsconfig excludes the fixture trees
 * it searches, so its `scope` drives real glob discovery against disk
 * (queries/fixture-uses.ts) and every hit is then read.
 */
export const PATH_ARGS: Record<QueryName, readonly PathArgSpec[]> = {
  callers: [],
  callees: [],
  importers: [],
  references: [],
  'column-reads': [],
  'column-writes': [],
  'type-evolution': [],
  'dead-exports': [{ key: 'symbolsFile', kind: 'path' }],
  'reexport-chain': [],
  'enum-uses': [],
  'string-literal-uses': [],
  'fixture-uses': [{ key: 'scope', kind: 'glob-csv' }],
  'flow-trace': [],
  'type-drift-detect': [],
  'schema-coverage': [{ key: 'evidence', kind: 'path-list' }],
};

const HINT =
  'This surface confines caller-supplied paths to its allowed roots (default: the repo root). ' +
  'Run the query on the CLI, which is unconfined, or start the server with AST_DATAFLOW_ALLOWED_ROOTS ' +
  'set to the extra roots it may read.';

function violation(key: string, supplied: string): PathPolicyViolation {
  return {
    kind: 'path_not_allowed',
    // Says only what the caller already supplied. Deliberately identical
    // whether or not the path exists — nothing here was read from disk.
    message: `Path '${supplied}' for argument '${key}' resolves outside the roots this surface is allowed to read.`,
    hint: HINT,
  };
}

/**
 * True when `candidate` is `root` or lies beneath it. Both are already
 * absolute and normalised. The separator test is what stops `/repo-evil` from
 * passing as being inside `/repo`.
 */
function isUnder(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Judge one concrete path. Purely lexical: `resolve` normalises `..` segments
 * and returns an absolute path without consulting the filesystem, and an
 * absolute `supplied` overrides `base` exactly as it would at the read site.
 *
 * Fail-closed on case: the comparison is case-sensitive, so on a
 * case-insensitive filesystem a differently-cased spelling of an allowed root
 * is rejected rather than admitted.
 */
function checkPath(
  policy: PathPolicy,
  base: string,
  key: string,
  supplied: string,
): PathPolicyViolation | null {
  const resolved = resolve(base, supplied);
  const allowed = policy.allowedRoots.some((root) =>
    isUnder(resolve(root), resolved),
  );
  return allowed ? null : violation(key, supplied);
}

/**
 * Judge one glob pattern.
 *
 * A pattern is not resolvable to a location, so containment is enforced on
 * the pattern's ability to leave its base at all: absolute patterns and any
 * `..` segment are refused, which leaves every match under the base directory
 * the caller of glob() sets. Measured against tinyglobby: with cwd set to the
 * repo root, `../../*.json` and `/etc/*.conf` both return host files, so
 * neither form is merely theoretical.
 *
 * Note this makes the glob surface strictly repo-confined on MCP: extending
 * allowedRoots does not widen it, because fixture-uses fixes glob's cwd to
 * the repo root and a pattern has no way to address another root.
 */
function checkGlob(key: string, pattern: string): PathPolicyViolation | null {
  if (isAbsolute(pattern)) return violation(key, pattern);
  if (pattern.split('/').includes('..')) return violation(key, pattern);
  return null;
}

/**
 * Apply `policy` to every filesystem path in one query's arguments, returning
 * the first violation or null when all are allowed.
 *
 * A pure function over (query, args, repoRoot, policy) — it reads no
 * filesystem and holds no state, so it stays correct wherever the surface
 * chooses to call it. That matters for issue #2: migrating the MCP server to
 * registerTool relocates the handler, not this check, as long as the new
 * handler still reaches dispatch.
 *
 * An undefined policy allows everything — the CLI's permissive surface is the
 * absence of a policy, not a policy that permits.
 */
export function checkArgPaths(
  query: QueryName,
  args: Record<string, unknown>,
  repoRoot: string,
  policy: PathPolicy | undefined,
): PathPolicyViolation | null {
  if (!policy) return null;

  for (const { key, kind } of PATH_ARGS[query]) {
    const value = args[key];
    if (value === undefined || value === null) continue;

    if (kind === 'path') {
      if (typeof value !== 'string' || value === '') continue;
      const result = checkPath(policy, repoRoot, key, value);
      if (result) return result;
    } else if (kind === 'path-list') {
      if (!Array.isArray(value)) continue;
      for (const entry of value) {
        if (typeof entry !== 'string' || entry === '') continue;
        const result = checkPath(policy, repoRoot, key, entry);
        if (result) return result;
      }
    } else {
      if (typeof value !== 'string') continue;
      for (const pattern of value.split(',').map((g) => g.trim())) {
        if (pattern === '') continue;
        const result = checkGlob(key, pattern);
        if (result) return result;
      }
    }
  }

  return null;
}

/**
 * The policy the MCP surface runs under: the repo root, plus any root the
 * operator opted into at spawn via AST_DATAFLOW_ALLOWED_ROOTS (delimited by
 * the platform's PATH separator — `:` on POSIX). Relative entries resolve
 * against the repo root.
 *
 * Configured at server start, never per request: a request that could widen
 * its own allowlist would not be an allowlist.
 */
export function mcpPathPolicy(
  repoRoot: string,
  configured: string | undefined,
): PathPolicy {
  const extra = (configured ?? '')
    .split(/[:;]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(repoRoot, entry));
  return { allowedRoots: [resolve(repoRoot), ...extra] };
}

/**
 * type-drift-detect query (PRODUCT.md WP-D, R-WP17)
 *
 * Classifies every response-interface candidate in the KH codebase into one
 * of four buckets:
 *   enforced    — symmetric usage (fetcher generic + route return-type)
 *   fetcher-only — fetcher uses the type but no route annotates it
 *   route-only  — route annotates but no fetcher uses it
 *   unused      — declared but used in neither position
 *
 * Algorithm summary (from TECH.md §WP-D):
 *   1. Enumerate candidate interfaces from types/ *.ts, lib/query/fetchers.ts,
 *      and app/api/ route files.
 *   2. For each candidate, classify its references as fetcher uses or route uses.
 *   3. Map fetcher URLs to candidate route files heuristically.
 *   4. Bucket by most-favourable classification (enforced > route-only > fetcher-only > unused).
 *   5. Emit JSONL rows conforming to TypeDriftResult.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Project,
  Node,
  ReferenceFindableNode,
  SourceFile,
} from 'ts-morph';
import { SyntaxKind } from 'ts-morph';
import type {
  TypeDriftResult,
  TypeDriftDetectArgs,
  QueryResponse,
} from '../types';
import { toRepoRelative, isTestFilePath } from '../resolve';

const DEFAULT_LIMIT = 500;

// ---------------------------------------------------------------------------
// Candidate regex — matches interface/type-alias names that are response
// types per the default heuristic (PRODUCT.md D-15).
// ---------------------------------------------------------------------------
const DEFAULT_CANDIDATE_REGEX = /(Response|Payload|Result|Body)$/;

// ---------------------------------------------------------------------------
// Allowlist entry shape
// ---------------------------------------------------------------------------
interface AllowlistEntry {
  interface: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Allowlist loader
//
// Primary location is the repo-root dotfile (same convention as
// `.type-drift-baseline.json`). The legacy `docs/specs/…` path is kept as a
// fallback — the spec tree moved to the private docs-site (ID-68), so the
// legacy path no longer exists in this repo and previously made the allowlist
// silently dead.
// ---------------------------------------------------------------------------
const ALLOWLIST_PATHS = [
  ['.type-drift-allowlist.json'],
  [
    'docs',
    'specs',
    'id-16-ast-dataflow-tool',
    'type-safety-pipeline',
    'allowlist.json',
  ],
] as const;

function loadAllowlist(repoRoot: string): AllowlistEntry[] | null {
  for (const segments of ALLOWLIST_PATHS) {
    const path = join(repoRoot, ...segments);
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (e): e is AllowlistEntry =>
          typeof e === 'object' &&
          e !== null &&
          typeof e.interface === 'string' &&
          typeof e.reason === 'string',
      );
    } catch {
      return null;
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Scope glob matcher
//
// `--scope` accepts comma-separated glob patterns (e.g. 'app/api/**,lib/**').
// Only files matching the globs are inspected for fetcher/route call sites;
// interface declarations are always scanned regardless of scope.
// Supported syntax: `**` (any path segments), `*` (within one segment).
// ---------------------------------------------------------------------------
function buildScopeMatcher(
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

// ---------------------------------------------------------------------------
// Baseline loader/writer
// ---------------------------------------------------------------------------
interface BaselineEntry {
  interface: string;
  declaredAt: { file: string };
}

function loadBaseline(repoRoot: string): BaselineEntry[] {
  const path = join(repoRoot, '.type-drift-baseline.json');
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Fetcher URL extraction
//
// Walks up from a type-argument node inside a fetchJson<T>(url) call to find
// the URL string literal passed as the first argument.
// Returns the URL string if statically resolvable, null otherwise.
//
// The call site is: fetchJson<X>(url)
//   The `X` identifier is inside a TypeReference which is the generic argument
//   of the CallExpression. The CallExpression args are the actual runtime args.
// ---------------------------------------------------------------------------
function extractFetcherUrl(node: Node): string | null {
  // node is inside TypeReference → parent is the CallExpression
  const typeRef = node.getFirstAncestorByKind(SyntaxKind.TypeReference);
  const callExpr =
    typeRef?.getParent()?.getKind() === SyntaxKind.CallExpression
      ? (typeRef.getParent() as unknown as {
          getArguments(): Node[];
        })
      : null;

  if (!callExpr) return null;

  const args = callExpr.getArguments();
  if (!args || args.length === 0) return null;

  const firstArg = args[0];

  // Direct string literal: '/api/items'
  if (firstArg.getKind() === SyntaxKind.StringLiteral) {
    return (
      firstArg as unknown as { getLiteralValue(): string }
    ).getLiteralValue();
  }

  // Template literal: `/api/orders/${id}` — extract static prefix
  if (firstArg.getKind() === SyntaxKind.TemplateExpression) {
    const text = firstArg.getText();
    // Grab up to first ${
    const prefixMatch = text.match(/^`([^$`]*)/);
    return prefixMatch ? prefixMatch[1] : null;
  }

  // No-substitute template: `/api/items`
  if (firstArg.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return (
      firstArg as unknown as { getLiteralValue(): string }
    ).getLiteralValue();
  }

  return null; // computed / identifier
}

// ---------------------------------------------------------------------------
// URL-to-route-file mapping
//
// Translates a URL like '/api/review/queue' to the candidate path
// 'app/api/review/queue/route.ts'. Path segments like '[id]' and
// template-literal placeholders are treated as wildcards.
// ---------------------------------------------------------------------------
function urlToRoutePath(url: string): string {
  // Remove leading slash, trailing query string / fragment
  const clean = url.replace(/^\//, '').replace(/[?#].*$/, '');
  // Split and rebuild — replace [id]-style and ${...}-style segments with [*]
  const parts = clean.split('/').map((seg) => {
    if (seg.startsWith('[') || seg.includes('${')) return '[*]';
    return seg;
  });
  return `app/${parts.join('/')}/route.ts`;
}

/**
 * Check if a route file path matches the candidate route path,
 * treating [*] as a wildcard segment.
 */
function routePathMatches(
  candidatePath: string,
  routeRelPath: string,
): boolean {
  const candParts = candidatePath.split('/');
  const routeParts = routeRelPath.split('/');
  if (candParts.length !== routeParts.length) return false;
  return candParts.every((p, i) => p === '[*]' || p === routeParts[i]);
}

// ---------------------------------------------------------------------------
// Check if a reference is a route handler return-type annotation
//
// Looks for patterns like:
//   Promise<NextResponse<X>>
//   Promise<X>
//   NextResponse<X>
// at function return-type positions in app/api/**/route.ts files.
// ---------------------------------------------------------------------------
function isRouteReturnTypeAnnotation(node: Node, relPath: string): boolean {
  // Must be in a route file
  if (!relPath.startsWith('app/api/') || !relPath.endsWith('route.ts')) {
    return false;
  }

  // The reference node should be inside a TypeReference
  const typeRef = node.getFirstAncestorByKind(SyntaxKind.TypeReference);
  if (!typeRef) return false;

  // Walk up to see if we're in a function return type position
  let current: Node | undefined = typeRef.getParent();
  while (current) {
    const kind = current.getKind();
    if (
      kind === SyntaxKind.FunctionDeclaration ||
      kind === SyntaxKind.MethodDeclaration ||
      kind === SyntaxKind.ArrowFunction ||
      kind === SyntaxKind.FunctionExpression
    ) {
      // Check it has a return type node that contains our typeRef
      const returnType = (
        current as unknown as { getReturnTypeNode?(): Node | undefined }
      ).getReturnTypeNode?.();
      if (returnType) {
        const rtText = returnType.getText();
        // The return type annotation text contains the interface name
        const typeRefText = typeRef.getText();
        return rtText.includes(typeRefText);
      }
      return false;
    }
    // Stop at source file boundary
    if (kind === SyntaxKind.SourceFile) break;
    current = current.getParent();
  }

  return false;
}

// ---------------------------------------------------------------------------
// Check if a reference is a fetcher generic argument
//
// Looks for patterns like:
//   fetchJson<X>(...)
//   mutationFetchJson<X>(...)
//
// ts-morph represents `fetchJson<X>(url)` as:
//   CallExpression
//     TypeReference  ← our node's parent is here
//       Identifier(X)
//
// There is no separate TypeArguments node — the TypeReference sits directly
// under the CallExpression as a type argument.
// ---------------------------------------------------------------------------
function isFetcherGenericArgument(node: Node): boolean {
  // The identifier must be inside a TypeReference
  const typeRef = node.getFirstAncestorByKind(SyntaxKind.TypeReference);
  if (!typeRef) return false;

  // The TypeReference's parent should be a CallExpression
  const parent = typeRef.getParent();
  if (!parent || parent.getKind() !== SyntaxKind.CallExpression) return false;

  // Verify the call is to fetchJson or mutationFetchJson
  const callText = (parent as unknown as { getExpression(): Node })
    .getExpression()
    .getText();
  return callText === 'fetchJson' || callText === 'mutationFetchJson';
}

// ---------------------------------------------------------------------------
// Find all type declaration nodes whose name matches the candidate pattern.
// Covers InterfaceDeclaration, TypeAliasDeclaration in any file.
// ---------------------------------------------------------------------------
interface CandidateDecl {
  name: string;
  file: string;
  line: number;
  column: number;
  node: Node & ReferenceFindableNode;
  sourceFile: SourceFile;
}

function enumerateCandidates(
  project: Project,
  repoRoot: string,
  candidatePattern: RegExp,
): CandidateDecl[] {
  const results: CandidateDecl[] = [];
  const seen = new Set<string>(); // dedupe by "file:name"

  for (const sf of project.getSourceFiles()) {
    const relPath = toRepoRelative(repoRoot, sf.getFilePath());

    // Scope: types/**/*.ts, lib/query/fetchers.ts, app/api/**/route.ts
    const isInScope =
      relPath.startsWith('types/') ||
      relPath === 'lib/query/fetchers.ts' ||
      (relPath.startsWith('app/api/') && relPath.endsWith('route.ts'));

    if (!isInScope) continue;

    // Gather interface declarations
    for (const iface of sf.getInterfaces()) {
      const name = iface.getName();
      if (!candidatePattern.test(name)) continue;
      const key = `${relPath}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const pos = sf.getLineAndColumnAtPos(iface.getStart());
      if ('findReferences' in iface) {
        results.push({
          name,
          file: relPath,
          line: pos.line,
          column: pos.column,
          node: iface as unknown as Node & ReferenceFindableNode,
          sourceFile: sf,
        });
      }
    }

    // Gather type alias declarations
    for (const alias of sf.getTypeAliases()) {
      const name = alias.getName();
      if (!candidatePattern.test(name)) continue;
      const key = `${relPath}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const pos = sf.getLineAndColumnAtPos(alias.getStart());
      if ('findReferences' in alias) {
        results.push({
          name,
          file: relPath,
          line: pos.line,
          column: pos.column,
          node: alias as unknown as Node & ReferenceFindableNode,
          sourceFile: sf,
        });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Also find candidates from fetcher generic usage
// (catches types used as fetchJson<T> that don't match the default name pattern)
// ---------------------------------------------------------------------------
function enumerateFetcherGenericCandidates(
  project: Project,
  repoRoot: string,
): Map<string, { file: string; line: number; column: number }> {
  const fetcherCandidates = new Map<
    string,
    { file: string; line: number; column: number }
  >();

  for (const sf of project.getSourceFiles()) {
    const relPath = toRepoRelative(repoRoot, sf.getFilePath());
    if (isTestFilePath(relPath)) continue;

    // Walk all call expressions looking for fetchJson<T> or mutationFetchJson<T>
    const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const call of calls) {
      const expr = call.getExpression();
      const exprText = expr.getText();
      if (exprText !== 'fetchJson' && exprText !== 'mutationFetchJson')
        continue;

      const typeArgs = call.getTypeArguments();
      if (typeArgs.length === 0) continue;

      const firstTypeArg = typeArgs[0];
      const typeName = firstTypeArg.getText();

      // Strip generic parameters from the name (e.g. "Array<X>" → "Array")
      const baseName = typeName.split('<')[0].trim();
      if (!fetcherCandidates.has(baseName)) {
        const pos = sf.getLineAndColumnAtPos(firstTypeArg.getStart());
        fetcherCandidates.set(baseName, {
          file: relPath,
          line: pos.line,
          column: pos.column,
        });
      }
    }
  }

  return fetcherCandidates;
}

// ---------------------------------------------------------------------------
// Main query
// ---------------------------------------------------------------------------

export async function typeDriftDetect(
  args: TypeDriftDetectArgs,
  project: Project,
  repoRoot: string,
): Promise<QueryResponse<TypeDriftResult> & { newSinceBaseline?: string[] }> {
  const started = Date.now();
  const limit = args.limit ?? DEFAULT_LIMIT;

  // Build candidate pattern (default + optional additive pattern)
  let candidatePattern = DEFAULT_CANDIDATE_REGEX;
  if (args.interfacePattern) {
    try {
      const extra = new RegExp(args.interfacePattern);
      candidatePattern = new RegExp(
        `${DEFAULT_CANDIDATE_REGEX.source}|${extra.source}`,
      );
    } catch {
      // Ignore invalid regex — use default only
    }
  }

  // Load allowlist (null = malformed JSON)
  const rawAllowlist = loadAllowlist(repoRoot);
  const allowlist: AllowlistEntry[] = rawAllowlist ?? [];
  const allowlistBadJson = rawAllowlist === null;

  const allowlistSet = new Set(allowlist.map((e) => e.interface));
  const allowlistReasons = new Map(
    allowlist.map((e) => [e.interface, e.reason]),
  );

  const inScope = buildScopeMatcher(args.scope);

  // D-25: Check for absent or empty fetchers surface.
  // Short-circuit with a single informational row when the project contains
  // zero fetchJson / mutationFetchJson calls anywhere. (Previously only
  // lib/query/fetchers.ts was checked, which returned a false "no fetchers"
  // sentinel the moment fetcher calls moved to sibling modules while the
  // reference scan below was already project-wide.)
  const hasFetcherCalls = project.getSourceFiles().some((sf) =>
    sf.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
      const exprText = call.getExpression().getText();
      return exprText === 'fetchJson' || exprText === 'mutationFetchJson';
    }),
  );

  if (!hasFetcherCalls) {
    return {
      query: 'type-drift-detect',
      args: { ...args, limit },
      results: [
        {
          file: 'lib/query/fetchers.ts',
          line: 1,
          column: 1,
          confidence: 'exact' as const,
          interface: 'n/a',
          declaredAt: { file: 'lib/query/fetchers.ts', line: 1, column: 1 },
          classification: 'unused' as const,
          fetchers: [],
          routes: [],
          candidateRoutes: [],
          remediationHint:
            'No fetcher calls found — lib/query/fetchers.ts is absent or contains no fetchJson/mutationFetchJson calls.',
          error: {
            kind: 'no-fetchers-found' as const,
            confidence: 'exact' as const,
          },
        },
      ],
      truncated: false,
      durationMs: Date.now() - started,
    };
  }

  // Enumerate candidates from type declarations
  const declaredCandidates = enumerateCandidates(
    project,
    repoRoot,
    candidatePattern,
  );

  // Also find from fetcher generic usage (catches types without name pattern match)
  const fetcherGenericCandidates = enumerateFetcherGenericCandidates(
    project,
    repoRoot,
  );

  // Merge: add fetcher-generic candidates that weren't found by name pattern
  const candidateMap = new Map<string, CandidateDecl>();
  for (const c of declaredCandidates) {
    candidateMap.set(c.name, c);
  }

  // For fetcher-generic candidates not yet in candidateMap, find their decls
  for (const [name] of fetcherGenericCandidates) {
    if (candidateMap.has(name)) continue;

    // Search all source files for a declaration of this name
    for (const sf of project.getSourceFiles()) {
      const relPath = toRepoRelative(repoRoot, sf.getFilePath());
      if (isTestFilePath(relPath)) continue;

      for (const iface of sf.getInterfaces()) {
        if (iface.getName() === name && 'findReferences' in iface) {
          const pos = sf.getLineAndColumnAtPos(iface.getStart());
          candidateMap.set(name, {
            name,
            file: relPath,
            line: pos.line,
            column: pos.column,
            node: iface as unknown as Node & ReferenceFindableNode,
            sourceFile: sf,
          });
          break;
        }
      }
      if (candidateMap.has(name)) break;

      for (const alias of sf.getTypeAliases()) {
        if (alias.getName() === name && 'findReferences' in alias) {
          const pos = sf.getLineAndColumnAtPos(alias.getStart());
          candidateMap.set(name, {
            name,
            file: relPath,
            line: pos.line,
            column: pos.column,
            node: alias as unknown as Node & ReferenceFindableNode,
            sourceFile: sf,
          });
          break;
        }
      }
      if (candidateMap.has(name)) break;
    }
  }

  // Classify each candidate
  const rows: TypeDriftResult[] = [];
  let totalEstimated = 0;

  for (const candidate of candidateMap.values()) {
    // Collect all references to this interface/type
    let allRefs: ReturnType<ReferenceFindableNode['findReferences']>;
    try {
      allRefs = candidate.node.findReferences();
    } catch {
      continue;
    }

    const fetcherUses: TypeDriftResult['fetchers'] = [];
    const routeUses: TypeDriftResult['routes'] = [];
    const candidateRoutes: TypeDriftResult['candidateRoutes'] = [];
    let testOnlyUseCount = 0;
    let nonTestNonFetcherNonRouteCount = 0;

    for (const refSymbol of allRefs) {
      for (const ref of refSymbol.getReferences()) {
        const node = ref.getNode();
        const sf = node.getSourceFile();
        const relPath = toRepoRelative(repoRoot, sf.getFilePath());

        // Skip the declaration itself
        if (ref.isDefinition()) continue;

        const lineCol = sf.getLineAndColumnAtPos(node.getStart());

        if (isTestFilePath(relPath)) {
          testOnlyUseCount++;
          continue;
        }

        // --scope: only files matching the globs are inspected for
        // fetcher/route call sites (declarations are always scanned).
        if (!inScope(relPath)) continue;

        // Check if this reference is a fetcher generic argument
        if (isFetcherGenericArgument(node)) {
          const url = extractFetcherUrl(node);
          fetcherUses.push({
            file: relPath,
            line: lineCol.line,
            column: lineCol.column,
            url: url ?? null,
          });
          continue;
        }

        // Check if this reference is a route return-type annotation
        if (isRouteReturnTypeAnnotation(node, relPath)) {
          routeUses.push({
            file: relPath,
            line: lineCol.line,
            column: lineCol.column,
            confidence: 'exact',
          });
          continue;
        }

        // Check if it's imported into a route file (candidate route)
        if (relPath.startsWith('app/api/') && relPath.endsWith('route.ts')) {
          // It's referenced in a route but not as a return-type annotation
          const importDecl = node.getFirstAncestorByKind(
            SyntaxKind.ImportDeclaration,
          );
          if (importDecl) {
            candidateRoutes.push({
              file: relPath,
              line: lineCol.line,
              column: lineCol.column,
              matchReason: 'imported-not-annotated',
              confidence: 'indirect',
            });
            continue;
          }
        }

        nonTestNonFetcherNonRouteCount++;
      }
    }

    // Also check URL-based route matching for fetcher-only cases
    // (even if the interface isn't imported by the route)
    for (const fetcherUse of fetcherUses) {
      if (!fetcherUse.url) continue;

      const candidateRoutePath = urlToRoutePath(fetcherUse.url);
      // Find route files that match this path pattern
      for (const sf of project.getSourceFiles()) {
        const relPath = toRepoRelative(repoRoot, sf.getFilePath());
        if (!relPath.startsWith('app/api/') || !relPath.endsWith('route.ts')) {
          continue;
        }
        if (!inScope(relPath)) continue;

        if (routePathMatches(candidateRoutePath, relPath)) {
          // Check if this route is already in candidateRoutes or routeUses
          const alreadyListed =
            routeUses.some((r) => r.file === relPath) ||
            candidateRoutes.some((r) => r.file === relPath);

          if (!alreadyListed) {
            // Find the first handler function in this route file
            const handlers = sf
              .getFunctions()
              .filter((fn) =>
                ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(
                  fn.getName() ?? '',
                ),
              );
            const line =
              handlers.length > 0
                ? sf.getLineAndColumnAtPos(handlers[0].getStart()).line
                : 1;

            candidateRoutes.push({
              file: relPath,
              line,
              column: 1,
              matchReason: 'url-match',
              confidence: 'indirect',
            });
          }
        }
      }
    }

    // Deduplicate candidateRoutes
    const seenCandidateRoutes = new Set<string>();
    const deduplicatedCandidateRoutes = candidateRoutes.filter((cr) => {
      const key = `${cr.file}:${cr.line}`;
      if (seenCandidateRoutes.has(key)) return false;
      seenCandidateRoutes.add(key);
      return true;
    });

    // Classify — most-favourable wins (D-10)
    let classification: TypeDriftResult['classification'];
    if (fetcherUses.length > 0 && routeUses.length > 0) {
      classification = 'enforced';
    } else if (fetcherUses.length > 0) {
      classification = 'fetcher-only';
    } else if (routeUses.length > 0) {
      classification = 'route-only';
    } else {
      classification = 'unused';
    }

    // testOnly flag (D-29)
    const testOnly =
      classification === 'unused' &&
      testOnlyUseCount > 0 &&
      nonTestNonFetcherNonRouteCount === 0
        ? true
        : undefined;

    // Allowlist check — overrides fetcher-only classification
    const isAllowlisted = allowlistSet.has(candidate.name);
    const allowlistedField = isAllowlisted
      ? { reason: allowlistReasons.get(candidate.name) ?? '' }
      : undefined;

    // Build remediation hint. For allowlisted rows the hint must match the
    // overridden classification — previously an allowlisted fetcher-only row
    // was emitted as 'unused' while its hint still said "add a return type
    // annotation".
    const remediationHint = isAllowlisted
      ? `${candidate.name} is allowlisted (${allowlistedField?.reason ?? 'no reason recorded'}) — no action needed.`
      : buildRemediationHint(
          candidate.name,
          classification,
          fetcherUses,
          deduplicatedCandidateRoutes,
        );

    totalEstimated++;

    if (rows.length < limit) {
      rows.push({
        // BaseResult fields (from declaredAt position)
        file: candidate.file,
        line: candidate.line,
        column: candidate.column,
        confidence: 'exact',

        // TypeDriftResult fields
        interface: candidate.name,
        declaredAt: {
          file: candidate.file,
          line: candidate.line,
          column: candidate.column,
        },
        classification: isAllowlisted ? 'unused' : classification,
        fetchers: fetcherUses,
        routes: routeUses,
        candidateRoutes: deduplicatedCandidateRoutes,
        remediationHint,
        ...(testOnly !== undefined ? { testOnly } : {}),
        ...(allowlistedField !== undefined
          ? { allowlisted: allowlistedField }
          : {}),
      });
    }
  }

  // Sort: fetcher-only first, then route-only, enforced, unused
  const ORDER: Record<TypeDriftResult['classification'], number> = {
    'fetcher-only': 0,
    'route-only': 1,
    enforced: 2,
    unused: 3,
  };
  rows.sort((a, b) => ORDER[a.classification] - ORDER[b.classification]);

  // CI mode: diff against baseline (D-19)
  let newSinceBaseline: string[] | undefined;
  if (args.ci) {
    const baseline = loadBaseline(repoRoot);
    const baselineKeys = new Set(
      baseline.map((e) => `${e.interface}:${e.declaredAt?.file ?? ''}`),
    );

    const nonAllowlistedFetcherOnly = rows.filter(
      (r) => r.classification === 'fetcher-only' && !r.allowlisted,
    );

    newSinceBaseline = nonAllowlistedFetcherOnly
      .filter((r) => {
        const key = `${r.interface}:${r.declaredAt.file}`;
        return !baselineKeys.has(key);
      })
      .map((r) => r.interface);
  }

  const response: QueryResponse<TypeDriftResult> & {
    newSinceBaseline?: string[];
  } = {
    query: 'type-drift-detect',
    args: { ...args, limit },
    results: rows,
    truncated: totalEstimated > rows.length,
    totalEstimated: totalEstimated > rows.length ? totalEstimated : undefined,
    durationMs: Date.now() - started,
    ...(allowlistBadJson
      ? {
          error: {
            kind: 'parse_error' as const,
            message: 'Allowlist JSON is malformed — allowlist ignored.',
            hint: `Fix ${join(repoRoot, 'docs', 'specs', 'id-16-ast-dataflow-tool', 'type-safety-pipeline', 'allowlist.json')}`,
          },
        }
      : {}),
  };

  if (newSinceBaseline !== undefined) {
    response.newSinceBaseline = newSinceBaseline;
  }

  return response;
}

// ---------------------------------------------------------------------------
// Remediation hint builder
// ---------------------------------------------------------------------------
function buildRemediationHint(
  interfaceName: string,
  classification: TypeDriftResult['classification'],
  fetchers: TypeDriftResult['fetchers'],
  candidateRoutes: TypeDriftResult['candidateRoutes'],
): string {
  if (classification === 'enforced') {
    return `${interfaceName} is enforced — no action needed.`;
  }

  if (classification === 'fetcher-only') {
    const routeHint =
      candidateRoutes.length > 0
        ? `Add return type annotation to the handler at ${candidateRoutes[0].file}` +
          (candidateRoutes[0].line > 0 ? `:${candidateRoutes[0].line}` : '')
        : 'Annotate the matching route handler return type';
    return (
      `${routeHint}, e.g.: ` +
      `\`export async function GET(): Promise<NextResponse<${interfaceName}>>\`. ` +
      `Alternatively, migrate to defineRoute(${interfaceName}Schema, ...) once OPS-T1 ships.`
    );
  }

  if (classification === 'route-only') {
    const url =
      fetchers.length > 0 ? (fetchers[0].url ?? '/api/...') : '/api/...';
    return (
      `Add a matching fetcher that uses the type as a generic: ` +
      `\`fetchJson<${interfaceName}>('${url}')\`. ` +
      `This closes the route-only gap.`
    );
  }

  return (
    `${interfaceName} is unused — consider removing it or adding a ` +
    `\`fetchJson<${interfaceName}>(...)\` call and a matching route annotation.`
  );
}

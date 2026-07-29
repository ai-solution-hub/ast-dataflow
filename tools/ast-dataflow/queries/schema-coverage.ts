/**
 * schema-coverage query (id-375 {375.8}) — the "built-not-wired" audit.
 *
 * One corpus walk joins the generated Postgres schema
 * (Database['public']['Tables'] in supabase/types/database.types.ts) to every
 * `.from()` query chain, then issues a per-column wiring verdict. The design
 * exists to NOT reproduce the baseline audit's false negatives
 * (id-375 research/baseline.md):
 *
 *   - schema enumeration + existence validation kills the silent-0/0
 *     dropped-table/typo'd-column failure (unknown_table / unknown_column);
 *   - `.from(CONST)` one-hop resolution (supabase-shared) attributes the
 *     const-table sites that produced 3 of 4 false "unwired" verdicts;
 *   - dynamic `.from()` sites are never dropped: argument TYPES that bound
 *     the site to specific tables become table-scoped smoke (zero-evidence
 *     columns on those tables downgrade to 'undecidable'); unbounded sites
 *     are reported as per-file counts in the caveats;
 *   - indirect/wildcard rows never count as wiring evidence (they are
 *     unfalsifiable — a nonexistent column collects both).
 *
 * Verdicts may additionally merge EXTERNAL evidence sidecars (`args.evidence`
 * / `--evidence`; contract v1 lives in types.ts): rows of column access
 * observed by a producer this scan cannot see — first the Python-side
 * scanner. Merged rows aggregate exactly like TS sites (exact evidence wires
 * a column; wildcard/indirect never does), a table-scoped `column: '*'` row
 * lands as a wildcard read / indirect write on every column of the table, and
 * the merged surface drops out of the invisible-surfaces caveat. Verdict
 * logic itself is untouched: evidence changes, not the rules.
 *
 * Out of scope (reported as static caveats, no SQL parsing): RPC function
 * bodies, api-schema views, external PostgREST consumers, and the Python
 * pipeline unless its sidecar is merged. `.rpc()` payload heuristics are also
 * excluded — they are table-blind and never fire on this repo's `p_*` param
 * convention.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  Project,
  SyntaxKind,
  type CallExpression,
  type InterfaceDeclaration,
  type Node,
  type PropertySignature,
  type SourceFile,
  type TypeLiteralNode,
} from 'ts-morph';
import type {
  Confidence,
  ErrorKind,
  EvidenceSidecarRow,
  SchemaCoverageArgs,
  SchemaCoverageCaveats,
  SchemaCoverageResponse,
  SchemaCoverageResult,
  SchemaCoverageVerdict,
} from '../types';
import { toRepoRelative } from '../resolve';
import {
  collectChain,
  detectIsTyped,
  findAllFromCalls,
  objectLiteralHasKey,
} from './supabase-shared';
import {
  FILTER_METHODS,
  literalArgValue,
  selectContainsColumn,
} from './column-reads';
import { inspectWriteArg } from './column-writes';
import { buildScopeMatcher } from './type-drift-detect';

const DEFAULT_LIMIT = 2000;

const SCHEMA_TYPES_PATH = 'supabase/types/database.types.ts';

const EVIDENCE_REFS_PER_DIRECTION = 3;

/** The only evidence-sidecar contract this consumer understands. */
const EVIDENCE_SCHEMA_VERSION = 1;

/**
 * The sidecar source that covers the Python pipeline. Merging one retires
 * that entry from `invisibleSurfaces` — the surface is no longer invisible.
 */
const PYTHON_EVIDENCE_SOURCE = 'ast-dataflow-py';

/**
 * `.match()` is deliberately NOT mutation evidence here (unlike
 * column-writes, where it is reported as a column-reference site): a
 * `.select().match({col})` chain never writes the column, and counting it
 * would let read-filter chains flip a column to 'wired'. It is counted on
 * the read side, matching column-reads.
 */
const MUTATION_METHODS: ReadonlySet<string> = new Set([
  'insert',
  'update',
  'upsert',
]);

const VERDICT_ORDER: Record<SchemaCoverageVerdict, number> = {
  unwired: 0,
  undecidable: 1,
  'write-only': 2,
  'read-only': 3,
  wired: 4,
};

const CONFIDENCE_RANK: Record<Confidence, number> = {
  exact: 0,
  wildcard: 1,
  indirect: 2,
};

// ─────────────────────────────────────────────────────────────────────────────
// Schema enumeration — ad-hoc ts-morph parse of database.types.ts
// (the root tsconfig excludes supabase/, so the main project cannot see it;
// same technique as fixture-uses: pure parse, no type checking needed).
// ─────────────────────────────────────────────────────────────────────────────

interface SchemaParseFailure {
  kind: ErrorKind;
  message: string;
  hint: string;
}

/** PropertySignature names may be quoted in generated types — normalise. */
function unquoteName(name: string): string {
  if (
    (name.startsWith("'") && name.endsWith("'")) ||
    (name.startsWith('"') && name.endsWith('"'))
  ) {
    return name.slice(1, -1);
  }
  return name;
}

/** The TypeLiteral of a property member, or null (mapped types etc.). */
function propTypeLiteral(prop: PropertySignature): TypeLiteralNode | null {
  const typeNode = prop.getTypeNode();
  return typeNode?.getKind() === SyntaxKind.TypeLiteral
    ? (typeNode as TypeLiteralNode)
    : null;
}

/** Find a named property member's TypeLiteral inside a container. */
function memberTypeLiteral(
  container: TypeLiteralNode | InterfaceDeclaration,
  name: string,
): TypeLiteralNode | null {
  for (const member of container.getMembers()) {
    if (member.getKind() !== SyntaxKind.PropertySignature) continue;
    const prop = member as PropertySignature;
    if (unquoteName(prop.getName()) !== name) continue;
    return propTypeLiteral(prop);
  }
  return null;
}

/**
 * Parse Database['public']['Tables'] → table name → Row column names.
 * Handles both the current generator output (`export type Database = {…}`)
 * and the legacy interface form.
 */
function enumerateSchema(
  repoRoot: string,
): Map<string, string[]> | SchemaParseFailure {
  const absPath = resolve(repoRoot, SCHEMA_TYPES_PATH);
  const adhoc = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { skipLibCheck: true },
  });

  let sf: SourceFile;
  try {
    sf = adhoc.addSourceFileAtPath(absPath);
  } catch {
    return {
      kind: 'unknown_file',
      message: `Cannot read ${SCHEMA_TYPES_PATH} under ${repoRoot}.`,
      hint: 'Regenerate the Supabase types (see supabase/CLAUDE.md) or run from the repo root.',
    };
  }

  let container: TypeLiteralNode | InterfaceDeclaration | null =
    sf.getInterface('Database') ?? null;
  if (!container) {
    const alias = sf.getTypeAlias('Database');
    const typeNode = alias?.getTypeNode();
    if (typeNode?.getKind() === SyntaxKind.TypeLiteral) {
      container = typeNode as TypeLiteralNode;
    }
  }
  if (!container) {
    return {
      kind: 'parse_error',
      message: `No 'Database' type alias or interface found in ${SCHEMA_TYPES_PATH}.`,
      hint: 'The file must be the generated Supabase types (supabase gen types).',
    };
  }

  const publicLit = memberTypeLiteral(container, 'public');
  const tablesLit = publicLit ? memberTypeLiteral(publicLit, 'Tables') : null;
  if (!tablesLit) {
    return {
      kind: 'parse_error',
      message: `Database['public']['Tables'] not found in ${SCHEMA_TYPES_PATH}.`,
      hint: 'The file must be the generated Supabase types (supabase gen types).',
    };
  }

  const schema = new Map<string, string[]>();
  for (const member of tablesLit.getMembers()) {
    if (member.getKind() !== SyntaxKind.PropertySignature) continue;
    const tableProp = member as PropertySignature;
    const tableLit = propTypeLiteral(tableProp);
    const rowLit = tableLit ? memberTypeLiteral(tableLit, 'Row') : null;
    if (!rowLit) continue;
    const columns: string[] = [];
    for (const colMember of rowLit.getMembers()) {
      if (colMember.getKind() !== SyntaxKind.PropertySignature) continue;
      columns.push(unquoteName((colMember as PropertySignature).getName()));
    }
    schema.set(unquoteName(tableProp.getName()), columns);
  }

  if (schema.size === 0) {
    return {
      kind: 'parse_error',
      message: `Database['public']['Tables'] contains no tables with a Row shape in ${SCHEMA_TYPES_PATH}.`,
      hint: 'The file must be the generated Supabase types (supabase gen types).',
    };
  }
  return schema;
}

// ─────────────────────────────────────────────────────────────────────────────
// One-pass scan
// ─────────────────────────────────────────────────────────────────────────────

interface EvidenceRef {
  file: string;
  line: number;
  confidence: Confidence;
}

interface DirectionAgg {
  exact: number;
  wildcard: number;
  indirect: number;
  refs: EvidenceRef[];
}

interface ColumnAgg {
  reads: DirectionAgg;
  writes: DirectionAgg;
}

function emptyDirection(): DirectionAgg {
  return { exact: 0, wildcard: 0, indirect: 0, refs: [] };
}

/** Bump one confidence bucket and keep the ref — the only mutation path. */
function recordEvidence(
  agg: ColumnAgg,
  direction: 'reads' | 'writes',
  confidence: Confidence,
  file: string,
  line: number,
): void {
  const dir = agg[direction];
  if (confidence === 'exact') dir.exact++;
  else if (confidence === 'wildcard') dir.wildcard++;
  else dir.indirect++;
  dir.refs.push({ file, line, confidence });
}

/**
 * The set of table names a dynamic `.from(<arg>)` site could touch, derived
 * from the argument's TYPE: a single string-literal type (e.g. a call whose
 * return type is 'signup_policy' — the one-hop resolver never follows
 * non-identifier expressions) or a union of string literals. Null = the type
 * is unbounded (`string`, any, …) — the site is globally unattributable.
 */
function possibleTablesFromType(arg: Node): string[] | null {
  try {
    const argType = arg.getType();
    if (argType.isStringLiteral()) {
      const value = argType.getLiteralValue();
      return typeof value === 'string' ? [value] : null;
    }
    if (argType.isUnion()) {
      const names = new Set<string>();
      for (const member of argType.getUnionTypes()) {
        if (!member.isStringLiteral()) return null;
        const value = member.getLiteralValue();
        if (typeof value !== 'string') return null;
        names.add(value);
      }
      return names.size > 0 ? [...names] : null;
    }
  } catch {
    // Type resolution may fail; treat as unbounded.
  }
  return null;
}

/**
 * True when the argument is string-typed — the precondition for treating an
 * unresolved `.from(<arg>)` as possible table access. Non-string arguments
 * (`Array.from(iterable)`, etc.) are not table queries and must not pollute
 * the unattributable-site counts. any/unknown stay loud: a table query
 * through an untyped value cannot be ruled out.
 */
function isStringTypedArg(arg: Node): boolean {
  try {
    const argType = arg.getType();
    if (argType.isAny() || argType.isUnknown()) return true;
    const members = argType.isUnion() ? argType.getUnionTypes() : [argType];
    return members.every(
      (m) => m.isString() || m.isStringLiteral() || m.isTemplateLiteral(),
    );
  } catch {
    return false;
  }
}

/** True for `X.storage.from('bucket')` — the Storage API, not a table query. */
function isStorageFrom(callExpr: CallExpression): boolean {
  const expr = callExpr.getExpression();
  if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) return false;
  const target = (
    expr as import('ts-morph').PropertyAccessExpression
  ).getExpression();
  return (
    target.getKind() === SyntaxKind.PropertyAccessExpression &&
    (target as import('ts-morph').PropertyAccessExpression).getName() ===
      'storage'
  );
}

/**
 * Classify one resolved `.from(table)` chain into per-column read/write
 * evidence — the same chain semantics as column-reads/column-writes, applied
 * to every column of the table in a single pass.
 */
function classifyChain(
  fromCallExpr: CallExpression,
  columns: string[],
  columnAggs: Map<string, ColumnAgg>,
  relPath: string,
  sf: SourceFile,
): void {
  const isTyped = detectIsTyped(fromCallExpr);
  const base: Confidence = isTyped ? 'exact' : 'indirect';
  const chain = collectChain(fromCallExpr);

  const record = (
    direction: 'reads' | 'writes',
    column: string,
    confidence: Confidence,
    line: number,
  ): void => {
    const agg = columnAggs.get(column);
    if (!agg) return;
    recordEvidence(agg, direction, confidence, relPath, line);
  };

  for (const { method, callExpr } of chain) {
    const chainArgs = callExpr.getArguments();
    if (chainArgs.length === 0) continue;
    const line = sf.getLineAndColumnAtPos(callExpr.getStart()).line;

    if (method === 'select') {
      const selectStr = literalArgValue(chainArgs[0]);
      if (selectStr === null) continue;
      if (selectStr === '*') {
        // A wildcard select may read ANY column of the table — wildcard
        // confidence on every column, regardless of client typing.
        for (const column of columns) {
          record('reads', column, 'wildcard', line);
        }
      } else {
        for (const column of columns) {
          if (selectContainsColumn(selectStr, column)) {
            record('reads', column, base, line);
          }
        }
      }
    } else if (
      method === 'eq' ||
      method === 'order' ||
      FILTER_METHODS.has(method)
    ) {
      const columnArg = literalArgValue(chainArgs[0]);
      if (columnArg !== null && columns.includes(columnArg)) {
        record('reads', columnArg, base, line);
      }
    } else if (
      method === 'match' &&
      chainArgs[0].getKind() === SyntaxKind.ObjectLiteralExpression
    ) {
      const objLiteral =
        chainArgs[0] as import('ts-morph').ObjectLiteralExpression;
      for (const column of columns) {
        if (objectLiteralHasKey(objLiteral, column)) {
          record('reads', column, base, line);
        }
      }
    } else if (MUTATION_METHODS.has(method)) {
      for (const column of columns) {
        const inspection = inspectWriteArg(chainArgs[0], column, isTyped);
        if (inspection.found) {
          record('writes', column, inspection.confidence, line);
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// External evidence sidecars — load, validate, merge (contract v1)
// ─────────────────────────────────────────────────────────────────────────────

interface LoadedSidecar {
  /** Top-level `source`: the producing tool. */
  source: string;
  /** Repo-relative when the file is under the repo root, else as supplied. */
  path: string;
  rows: EvidenceSidecarRow[];
}

/** A malformed sidecar is never a silent skip — it fails the whole query. */
function sidecarFailure(
  label: string,
  reason: string,
  hint: string,
): SchemaParseFailure {
  return {
    kind: 'parse_error',
    message: `Evidence sidecar '${label}' ${reason}.`,
    hint,
  };
}

const SIDECAR_SHAPE_HINT =
  "Contract v1: { schemaVersion: 1, source, rows: [{ table, column ('*' for table-scoped), direction: 'read'|'write', confidence: 'exact'|'wildcard'|'indirect', method, file, line, source }] }.";

/** Validate one row against contract v1; returns the reason on rejection. */
function validateRow(entry: unknown): EvidenceSidecarRow | string {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return 'is not an object';
  }
  const row = entry as Record<string, unknown>;
  const strings = ['table', 'column', 'method', 'file', 'source'] as const;
  for (const key of strings) {
    if (typeof row[key] !== 'string' || row[key] === '') {
      return `has no non-empty string '${key}'`;
    }
  }
  if (row.direction !== 'read' && row.direction !== 'write') {
    return `has direction '${String(row.direction)}' (expected 'read' or 'write')`;
  }
  if (
    typeof row.confidence !== 'string' ||
    !(row.confidence in CONFIDENCE_RANK)
  ) {
    return `has confidence '${String(row.confidence)}' (expected ${Object.keys(CONFIDENCE_RANK).join(', ')})`;
  }
  if (typeof row.line !== 'number' || !Number.isFinite(row.line)) {
    return `has line '${String(row.line)}' (expected a number)`;
  }
  return row as unknown as EvidenceSidecarRow;
}

/**
 * Read and validate every sidecar path, or return the first failure. Loading
 * happens before the corpus walk so a bad sidecar fails fast — and always
 * loudly: a silently skipped sidecar would present TS-only verdicts as if
 * they carried the external evidence.
 */
function loadEvidenceSidecars(
  paths: string[],
  repoRoot: string,
): LoadedSidecar[] | SchemaParseFailure {
  const loaded: LoadedSidecar[] = [];
  for (const supplied of paths) {
    const absPath = isAbsolute(supplied)
      ? supplied
      : resolve(repoRoot, supplied);
    const rel = relative(repoRoot, absPath).split('\\').join('/');
    const label = rel.startsWith('..') ? supplied : rel;

    let raw: string;
    try {
      raw = readFileSync(absPath, 'utf8');
    } catch {
      return {
        kind: 'unknown_file',
        message: `Cannot read evidence sidecar '${label}' (resolved to ${absPath}).`,
        hint: 'Paths are repo-root-relative or absolute; the producer must write the sidecar before this query runs.',
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return sidecarFailure(
        label,
        `is not valid JSON: ${message}`,
        SIDECAR_SHAPE_HINT,
      );
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return sidecarFailure(label, 'is not a JSON object', SIDECAR_SHAPE_HINT);
    }

    // Unknown top-level keys (caveats, sqlglot, generatedBy, …) are tolerated:
    // producers may enrich their output without breaking this consumer.
    const doc = parsed as Record<string, unknown>;
    if (doc.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
      return sidecarFailure(
        label,
        `declares schemaVersion ${JSON.stringify(doc.schemaVersion)} (this consumer reads ${EVIDENCE_SCHEMA_VERSION})`,
        SIDECAR_SHAPE_HINT,
      );
    }
    if (typeof doc.source !== 'string' || doc.source === '') {
      return sidecarFailure(
        label,
        'has no non-empty top-level string `source`',
        SIDECAR_SHAPE_HINT,
      );
    }
    if (!Array.isArray(doc.rows)) {
      return sidecarFailure(label, 'has no `rows` array', SIDECAR_SHAPE_HINT);
    }

    const rows: EvidenceSidecarRow[] = [];
    for (const [index, entry] of (doc.rows as unknown[]).entries()) {
      const row = validateRow(entry);
      if (typeof row === 'string') {
        return sidecarFailure(label, `row ${index} ${row}`, SIDECAR_SHAPE_HINT);
      }
      rows.push(row);
    }
    loaded.push({ source: doc.source, path: label, rows });
  }
  return loaded;
}

/**
 * Merge one sidecar's rows into the per-column aggregation, exactly as the
 * corpus walk merges TS sites. Rows naming a table or column outside the
 * enumerated schema are counted in `unknownTables` instead of dropped: a
 * producer that has drifted from the schema must be visible in the caveats,
 * not silently absent from the verdicts.
 */
function mergeSidecar(
  sidecar: LoadedSidecar,
  schema: Map<string, string[]>,
  columnAggs: Map<string, Map<string, ColumnAgg>>,
  unknownTables: Map<string, number>,
): void {
  const bumpUnknown = (key: string): void => {
    unknownTables.set(key, (unknownTables.get(key) ?? 0) + 1);
  };

  for (const row of sidecar.rows) {
    const columns = schema.get(row.table);
    const perColumn = columnAggs.get(row.table);
    if (!columns || !perColumn) {
      bumpUnknown(`${sidecar.source}:${row.table}`);
      continue;
    }
    const direction = row.direction === 'read' ? 'reads' : 'writes';

    if (row.column === '*') {
      // Table-scoped: the producer proved the TABLE was touched, not which
      // column. A dynamic read may have read any of them (wildcard); a
      // dynamic write is smoke, not proof (indirect) — so a '*' write can
      // never flip a column to 'write-only'.
      const confidence: Confidence =
        direction === 'reads' ? 'wildcard' : 'indirect';
      for (const column of columns) {
        const agg = perColumn.get(column);
        if (agg) recordEvidence(agg, direction, confidence, row.file, row.line);
      }
      continue;
    }

    const agg = perColumn.get(row.column);
    if (!agg) {
      bumpUnknown(`${sidecar.source}:${row.table}.${row.column}`);
      continue;
    }
    recordEvidence(agg, direction, row.confidence, row.file, row.line);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdicts + assembly
// ─────────────────────────────────────────────────────────────────────────────

function verdictFor(
  agg: ColumnAgg,
  tableSmokeCount: number,
): SchemaCoverageVerdict {
  const hasExactRead = agg.reads.exact > 0;
  const hasExactWrite = agg.writes.exact > 0;
  if (hasExactRead && hasExactWrite) return 'wired';
  if (hasExactRead) return 'read-only';
  if (hasExactWrite) return 'write-only';
  const softEvidence =
    agg.reads.wildcard + agg.reads.indirect + agg.writes.indirect > 0;
  if (softEvidence || tableSmokeCount > 0) return 'undecidable';
  return 'unwired';
}

/** Top refs per direction: exact first, then (file, line); deduped file:line. */
function topRefs(refs: EvidenceRef[]): string[] {
  const sorted = [...refs].sort(
    (a, b) =>
      CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line),
  );
  const out: string[] = [];
  for (const ref of sorted) {
    const key = `${ref.file}:${ref.line}`;
    if (!out.includes(key)) out.push(key);
    if (out.length === EVIDENCE_REFS_PER_DIRECTION) break;
  }
  return out;
}

function staticCaveats(
  unattributable: Map<string, number>,
  sidecars: LoadedSidecar[],
  unknownTables: Map<string, number>,
): SchemaCoverageCaveats {
  const sources = [...new Set(sidecars.map((s) => s.source))];
  const pythonMerged = sources.includes(PYTHON_EVIDENCE_SOURCE);
  return {
    scan:
      sidecars.length > 0
        ? `Verdicts combine TypeScript query-chain evidence (.from() chains in the tsconfig corpus) with merged external evidence sidecars: ${sources.join(', ')}. No SQL is parsed on the TypeScript side.`
        : 'Verdicts are based on TypeScript query-chain evidence only (.from() chains in the tsconfig corpus). No SQL is parsed.',
    invisibleSurfaces: [
      'RPC function bodies (SQL)',
      'api-schema views',
      'external PostgREST consumers',
      // A merged sidecar makes its surface visible — the entry would be a lie.
      ...(pythonMerged ? [] : ['the Python pipeline (scripts/**/*.py)']),
    ],
    unattributableSites: Object.fromEntries(
      [...unattributable.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    ...(sidecars.length > 0
      ? {
          mergedEvidence: sidecars.map(({ source, path, rows }) => ({
            source,
            path,
            rows: rows.length,
          })),
        }
      : {}),
    ...(unknownTables.size > 0
      ? {
          evidenceUnknownTables: Object.fromEntries(
            [...unknownTables.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
          ),
        }
      : {}),
  };
}

function errorResponse(
  args: Record<string, unknown>,
  kind: ErrorKind,
  message: string,
  hint: string,
  durationMs: number,
): SchemaCoverageResponse {
  return {
    query: 'schema-coverage',
    args,
    results: [],
    truncated: false,
    durationMs,
    error: { kind, message, hint },
  };
}

export async function schemaCoverage(
  args: SchemaCoverageArgs,
  project: Project,
  repoRoot: string,
): Promise<SchemaCoverageResponse> {
  const started = Date.now();
  const limit = args.limit ?? DEFAULT_LIMIT;
  const argsEcho = { ...args, limit };

  if (args.column && !args.table) {
    return errorResponse(
      argsEcho,
      'parse_error',
      'column requires table — a column alone does not identify a schema table.',
      "Example: { table: 'signup_policy', column: 'allowed_domain' }",
      Date.now() - started,
    );
  }

  const schema = enumerateSchema(repoRoot);
  if (!(schema instanceof Map)) {
    return errorResponse(
      argsEcho,
      schema.kind,
      schema.message,
      schema.hint,
      Date.now() - started,
    );
  }

  if (args.table && !schema.has(args.table)) {
    return errorResponse(
      argsEcho,
      'unknown_table',
      `Table '${args.table}' is not in Database['public']['Tables'] (${schema.size} tables in schema).`,
      'Dropped or misspelled tables report loudly instead of a silent 0/0. Run without --table to list the schema.',
      Date.now() - started,
    );
  }
  if (args.table && args.column) {
    const columns = schema.get(args.table) ?? [];
    if (!columns.includes(args.column)) {
      return errorResponse(
        argsEcho,
        'unknown_column',
        `Column '${args.column}' is not a Row column of '${args.table}' (${columns.length} columns).`,
        `Known columns: ${columns.join(', ')}`,
        Date.now() - started,
      );
    }
  }

  // Sidecars load before the walk: a malformed one must fail the query, not
  // waste a corpus traversal first.
  const sidecars = args.evidence?.length
    ? loadEvidenceSidecars(args.evidence, repoRoot)
    : [];
  if (!Array.isArray(sidecars)) {
    return errorResponse(
      argsEcho,
      sidecars.kind,
      sidecars.message,
      sidecars.hint,
      Date.now() - started,
    );
  }

  const scopeMatch = buildScopeMatcher(args.scope);

  // Aggregation state for the single corpus walk.
  const columnAggs = new Map<string, Map<string, ColumnAgg>>();
  for (const [table, columns] of schema) {
    const perColumn = new Map<string, ColumnAgg>();
    for (const column of columns) {
      perColumn.set(column, {
        reads: emptyDirection(),
        writes: emptyDirection(),
      });
    }
    columnAggs.set(table, perColumn);
  }
  const tableSmoke = new Map<string, number>();
  const unattributable = new Map<string, number>();
  const evidenceUnknownTables = new Map<string, number>();

  try {
    for (const sf of project.getSourceFiles()) {
      const relPath = toRepoRelative(repoRoot, sf.getFilePath());
      if (!scopeMatch(relPath)) continue;

      for (const site of findAllFromCalls(sf)) {
        if (isStorageFrom(site.callExpr)) continue;

        if (site.table !== null) {
          const perColumn = columnAggs.get(site.table);
          if (!perColumn) continue; // resolved but not a public-schema table
          classifyChain(
            site.callExpr,
            schema.get(site.table) ?? [],
            perColumn,
            relPath,
            sf,
          );
        } else {
          const bounded = possibleTablesFromType(site.arg);
          if (bounded) {
            for (const table of bounded) {
              if (schema.has(table)) {
                tableSmoke.set(table, (tableSmoke.get(table) ?? 0) + 1);
              }
            }
          } else if (isStringTypedArg(site.arg)) {
            unattributable.set(relPath, (unattributable.get(relPath) ?? 0) + 1);
          }
          // Non-string-typed arguments (Array.from(iterable), …) are not
          // table queries — skipped entirely.
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(
      argsEcho,
      'parse_error',
      `Unexpected error during schema-coverage traversal: ${message}`,
      'Check that the project compiles without errors.',
      Date.now() - started,
    );
  }

  // External evidence joins the SAME aggregation the walk filled — verdictFor
  // never learns where a row came from.
  for (const sidecar of sidecars) {
    mergeSidecar(sidecar, schema, columnAggs, evidenceUnknownTables);
  }

  // Assemble per-column verdict rows.
  const rows: SchemaCoverageResult[] = [];
  for (const [table, perColumn] of columnAggs) {
    if (args.table && table !== args.table) continue;
    const smoke = tableSmoke.get(table) ?? 0;
    for (const [column, agg] of perColumn) {
      if (args.column && column !== args.column) continue;
      rows.push({
        table,
        column,
        verdict: verdictFor(agg, smoke),
        exactReads: agg.reads.exact,
        exactWrites: agg.writes.exact,
        wildcardReads: agg.reads.wildcard,
        indirectReads: agg.reads.indirect,
        indirectWrites: agg.writes.indirect,
        unattributableTableSites: smoke,
        evidence: {
          reads: topRefs(agg.reads.refs),
          writes: topRefs(agg.writes.refs),
        },
      });
    }
  }

  // Worst-first: unwired, undecidable, write-only, read-only, wired;
  // alphabetical (table, column) within class.
  rows.sort(
    (a, b) =>
      VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] ||
      (a.table < b.table
        ? -1
        : a.table > b.table
          ? 1
          : a.column < b.column
            ? -1
            : a.column > b.column
              ? 1
              : 0),
  );

  const summary: Record<SchemaCoverageVerdict, number> = {
    unwired: 0,
    undecidable: 0,
    'write-only': 0,
    'read-only': 0,
    wired: 0,
  };
  for (const row of rows) summary[row.verdict]++;

  const truncated = rows.length > limit;
  return {
    query: 'schema-coverage',
    args: argsEcho,
    results: truncated ? rows.slice(0, limit) : rows,
    truncated,
    ...(truncated ? { totalEstimated: rows.length } : {}),
    durationMs: Date.now() - started,
    caveats: staticCaveats(unattributable, sidecars, evidenceUnknownTables),
    summary,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown report (owner-facing; modelled on cli.ts renderMarkdownReport)
// ─────────────────────────────────────────────────────────────────────────────

const VERDICT_SECTIONS: Array<{
  key: SchemaCoverageVerdict;
  heading: string;
  caveat: string;
}> = [
  {
    key: 'unwired',
    heading: 'Unwired columns (built, never wired)',
    caveat:
      'No TypeScript query-chain evidence and no smoke on the table. The scan blindness still applies: a column used only from RPC SQL bodies, api-schema views, external PostgREST consumers, or the Python pipeline will appear here.',
  },
  {
    key: 'undecidable',
    heading: 'Undecidable columns (smoke without proof)',
    caveat:
      'Only wildcard/indirect evidence, or the table has dynamic access sites — wiring can be neither confirmed nor ruled out statically.',
  },
  {
    key: 'write-only',
    heading: 'Write-only columns',
    caveat:
      'Exact write evidence, zero exact reads — data goes in, nothing in TypeScript reads it back.',
  },
  {
    key: 'read-only',
    heading: 'Read-only columns',
    caveat:
      'Exact read evidence, zero exact writes — displayed but never populated from TypeScript.',
  },
  {
    key: 'wired',
    heading: 'Wired columns',
    caveat: 'Exact read AND exact write evidence.',
  },
];

function evidenceCell(row: SchemaCoverageResult): string {
  const parts: string[] = [];
  if (row.evidence.reads.length > 0) {
    parts.push(`R: ${row.evidence.reads.map((r) => `\`${r}\``).join(', ')}`);
  }
  if (row.evidence.writes.length > 0) {
    parts.push(`W: ${row.evidence.writes.map((r) => `\`${r}\``).join(', ')}`);
  }
  return parts.length > 0 ? parts.join('; ') : '—';
}

export function renderSchemaCoverageReport(
  response: SchemaCoverageResponse,
): string {
  const results = response.results;
  const caveats = response.caveats;
  const lines: string[] = [];

  lines.push('# Schema Coverage Report — built-not-wired audit');
  lines.push('');
  lines.push(
    '> Generated by `bun run ast-dataflow schema-coverage --report <path>`. ' +
      "One verdict per column of `Database['public']['Tables']`, from static TypeScript query-chain evidence.",
  );
  lines.push('');

  if (caveats) {
    lines.push('## Scan caveats');
    lines.push('');
    lines.push(`- ${caveats.scan}`);
    lines.push(
      `- Invisible to this scan: ${caveats.invisibleSurfaces.join('; ')}.`,
    );
    if (caveats.mergedEvidence && caveats.mergedEvidence.length > 0) {
      lines.push('- Merged external evidence sidecars:');
      for (const merged of caveats.mergedEvidence) {
        lines.push(
          `  - ${merged.source} — \`${merged.path}\`, ${merged.rows} row(s)`,
        );
      }
    }
    const unattrib = Object.entries(caveats.unattributableSites);
    if (unattrib.length > 0) {
      lines.push(
        '- Dynamic `.from()` sites that could not be attributed to any table (access through these is invisible to every verdict below):',
      );
      for (const [file, count] of unattrib) {
        lines.push(`  - \`${file}\` — ${count} site(s)`);
      }
    } else {
      lines.push(
        '- No unattributable dynamic `.from()` sites in the scanned scope.',
      );
    }
    lines.push('');
  }

  if (response.truncated) {
    lines.push(
      `> **Truncated:** showing ${results.length} of ${response.totalEstimated} columns; the per-table rollup reflects shown rows only.`,
    );
    lines.push('');
  }

  for (const { key, heading, caveat } of VERDICT_SECTIONS) {
    const sectionRows = results.filter((r) => r.verdict === key);
    if (sectionRows.length === 0) continue;

    lines.push(`## ${heading} — ${sectionRows.length}`);
    lines.push('');
    lines.push(`> ${caveat}`);
    lines.push('');

    if (key === 'unwired') {
      for (const row of sectionRows) {
        lines.push(`### \`${row.table}.${row.column}\``);
        lines.push('');
        lines.push(
          '- **Evidence:** none — zero reads, zero writes, zero wildcard/indirect rows, zero dynamic sites bounded to the table.',
        );
        lines.push(
          '- **Caveat:** invisible surfaces (RPC bodies, api views, external consumers, Python) could still touch this column.',
        );
        lines.push('');
      }
    } else {
      lines.push(
        '| Column | Exact R/W | Wildcard R | Indirect R/W | Dynamic table sites | Evidence |',
      );
      lines.push('|---|---|---|---|---|---|');
      for (const row of sectionRows) {
        lines.push(
          `| \`${row.table}.${row.column}\` | ${row.exactReads}/${row.exactWrites} | ${row.wildcardReads} | ${row.indirectReads}/${row.indirectWrites} | ${row.unattributableTableSites} | ${evidenceCell(row)} |`,
        );
      }
      lines.push('');
    }
  }

  // Per-table rollup.
  const tables = new Map<
    string,
    { counts: Record<SchemaCoverageVerdict, number>; smoke: number }
  >();
  for (const row of results) {
    let entry = tables.get(row.table);
    if (!entry) {
      entry = {
        counts: {
          unwired: 0,
          undecidable: 0,
          'write-only': 0,
          'read-only': 0,
          wired: 0,
        },
        smoke: row.unattributableTableSites,
      };
      tables.set(row.table, entry);
    }
    entry.counts[row.verdict]++;
  }
  lines.push('## Per-table rollup');
  lines.push('');
  lines.push(
    '| Table | Columns | Wired | Read-only | Write-only | Undecidable | Unwired | Dynamic sites |',
  );
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const [table, entry] of [...tables.entries()].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    const c = entry.counts;
    const total =
      c.wired + c['read-only'] + c['write-only'] + c.undecidable + c.unwired;
    lines.push(
      `| \`${table}\` | ${total} | ${c.wired} | ${c['read-only']} | ${c['write-only']} | ${c.undecidable} | ${c.unwired} | ${entry.smoke} |`,
    );
  }
  lines.push('');

  // Summary counts (histogram over ALL rows, pre-truncation).
  const summary = response.summary;
  if (summary) {
    lines.push('## Summary');
    lines.push('');
    lines.push('| Verdict | Count |');
    lines.push('|---|---|');
    lines.push(`| unwired | ${summary.unwired} |`);
    lines.push(`| undecidable | ${summary.undecidable} |`);
    lines.push(`| write-only | ${summary['write-only']} |`);
    lines.push(`| read-only | ${summary['read-only']} |`);
    lines.push(`| wired | ${summary.wired} |`);
    const total =
      summary.unwired +
      summary.undecidable +
      summary['write-only'] +
      summary['read-only'] +
      summary.wired;
    lines.push(`| **total** | **${total}** |`);
    lines.push('');
  }

  return lines.join('\n');
}

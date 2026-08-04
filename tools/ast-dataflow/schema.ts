/**
 * Generated-Postgres-schema enumeration, shared by every schema-addressed
 * query (schema-coverage, column-reads, column-writes).
 *
 * The single reason this module exists: a query that takes a `table` and a
 * `column` must be able to tell "no sites exist" apart from "that table or
 * column does not exist". schema-coverage has always made that distinction
 * (unknown_table / unknown_column); column-reads and column-writes returned a
 * silent `[]` for a typo. The enumeration lives here so both answers come from
 * one parse of one file, and the two queries cannot drift apart again.
 *
 * The parse is ad-hoc (its own ts-morph Project, no type checking): the target
 * repo's root tsconfig typically excludes `supabase/`, so the query's main
 * project cannot see the generated types. Results are cached per
 * (path, mtime, size) so the warm MCP server pays the parse once per edit of
 * the generated file rather than once per query.
 */

import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Project,
  SyntaxKind,
  type InterfaceDeclaration,
  type PropertySignature,
  type SourceFile,
  type TypeLiteralNode,
} from 'ts-morph';
import type { ErrorKind, SchemaValidation } from './types';

/** Where the Supabase type generator writes, relative to the repo root. */
export const SCHEMA_TYPES_PATH = 'supabase/types/database.types.ts';

/** The generated types were found and parsed: table name → Row column names. */
export interface SchemaAvailable {
  available: true;
  tables: Map<string, string[]>;
  /** Repo-root-relative path of the file that was parsed. */
  source: string;
}

/**
 * The generated types could not be read or parsed. This is NOT automatically
 * an error: for schema-coverage it is fatal (the schema IS the row set), while
 * for column-reads/column-writes it only means the table/column arguments
 * could not be validated — which the response discloses in its caveats
 * instead of failing.
 */
export interface SchemaUnavailable {
  available: false;
  kind: ErrorKind;
  message: string;
  hint: string;
  source: string;
}

export type SchemaEnumeration = SchemaAvailable | SchemaUnavailable;

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

const PARSE_HINT =
  'The file must be the generated Supabase types (supabase gen types typescript).';

/**
 * Parse Database['public']['Tables'] → table name → Row column names.
 * Handles both the current generator output (`export type Database = {…}`)
 * and the legacy interface form.
 */
function enumerate(repoRoot: string): SchemaEnumeration {
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
      available: false,
      kind: 'unknown_file',
      message: `Cannot read ${SCHEMA_TYPES_PATH} under ${repoRoot}.`,
      hint: 'Regenerate the Supabase types (supabase gen types typescript) or run from the repo root.',
      source: SCHEMA_TYPES_PATH,
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
      available: false,
      kind: 'parse_error',
      message: `No 'Database' type alias or interface found in ${SCHEMA_TYPES_PATH}.`,
      hint: PARSE_HINT,
      source: SCHEMA_TYPES_PATH,
    };
  }

  const publicLit = memberTypeLiteral(container, 'public');
  const tablesLit = publicLit ? memberTypeLiteral(publicLit, 'Tables') : null;
  if (!tablesLit) {
    return {
      available: false,
      kind: 'parse_error',
      message: `Database['public']['Tables'] not found in ${SCHEMA_TYPES_PATH}.`,
      hint: PARSE_HINT,
      source: SCHEMA_TYPES_PATH,
    };
  }

  const tables = new Map<string, string[]>();
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
    tables.set(unquoteName(tableProp.getName()), columns);
  }

  if (tables.size === 0) {
    return {
      available: false,
      kind: 'parse_error',
      message: `Database['public']['Tables'] contains no tables with a Row shape in ${SCHEMA_TYPES_PATH}.`,
      hint: PARSE_HINT,
      source: SCHEMA_TYPES_PATH,
    };
  }
  return { available: true, tables, source: SCHEMA_TYPES_PATH };
}

/**
 * Cache keyed by absolute path → (mtime+size stamp, parsed enumeration).
 * A missing file is never cached: the generated types may be written after
 * the process starts (the warm MCP server outlives a `supabase gen types`).
 */
const cache = new Map<string, { stamp: string; value: SchemaEnumeration }>();

export function loadSchema(repoRoot: string): SchemaEnumeration {
  const absPath = resolve(repoRoot, SCHEMA_TYPES_PATH);
  let stamp: string;
  try {
    const stat = statSync(absPath);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return {
      available: false,
      kind: 'unknown_file',
      message: `Cannot read ${SCHEMA_TYPES_PATH} under ${repoRoot}.`,
      hint: 'Regenerate the Supabase types (supabase gen types typescript) or run from the repo root.',
      source: SCHEMA_TYPES_PATH,
    };
  }

  const hit = cache.get(absPath);
  if (hit && hit.stamp === stamp) return hit.value;

  const value = enumerate(repoRoot);
  cache.set(absPath, { stamp, value });
  return value;
}

/** Drop the parse cache. Exists so tests can rewrite a fixture schema. */
export function clearSchemaCache(): void {
  cache.clear();
}

/**
 * Levenshtein-free near-miss finder: names sharing a prefix or differing by a
 * single character. Good enough to catch the typo that motivated G3 without
 * pulling in a distance library.
 */
function nearMisses(needle: string, candidates: Iterable<string>): string[] {
  const out: string[] = [];
  for (const candidate of candidates) {
    if (candidate === needle) continue;
    const shared =
      candidate.startsWith(needle.slice(0, 4)) ||
      needle.startsWith(candidate.slice(0, 4));
    const lengthClose = Math.abs(candidate.length - needle.length) <= 2;
    if (shared && lengthClose) out.push(candidate);
    if (out.length === 5) break;
  }
  return out;
}

/** A table/column pair that does not exist in the generated types. */
export interface SchemaLookupFailure {
  kind: Extract<ErrorKind, 'unknown_table' | 'unknown_column'>;
  message: string;
  hint: string;
}

export interface SchemaLookupOutcome {
  /** Always present — the caveats disclose whether validation actually ran. */
  validation: SchemaValidation;
  /** Present only when the table or column does not exist. */
  failure?: SchemaLookupFailure;
}

/**
 * Check a (table, column) pair against the generated types.
 *
 * When the generated types are unavailable the pair is NOT rejected: the
 * outcome carries `validated: false` plus the reason, and the caller proceeds
 * with an unvalidated walk. A tool that refused to run outside a Supabase repo
 * would be useless on every other repo; a tool that silently skipped the check
 * is what G3 is fixing. Disclosure is the middle path.
 */
export function lookupTableColumn(
  repoRoot: string,
  table: string,
  column: string,
): SchemaLookupOutcome {
  const schema = loadSchema(repoRoot);
  if (!schema.available) {
    return {
      validation: {
        validated: false,
        source: schema.source,
        reason: schema.message,
      },
    };
  }

  const validation: SchemaValidation = {
    validated: true,
    source: schema.source,
    tableCount: schema.tables.size,
  };

  const columns = schema.tables.get(table);
  if (!columns) {
    const suggestions = nearMisses(table, schema.tables.keys());
    return {
      validation,
      failure: {
        kind: 'unknown_table',
        message: `Table '${table}' is not in Database['public']['Tables'] (${schema.tables.size} tables in ${schema.source}).`,
        hint:
          suggestions.length > 0
            ? `Did you mean: ${suggestions.join(', ')}? A dropped or misspelled table reports loudly instead of a silent zero-row answer.`
            : `A dropped or misspelled table reports loudly instead of a silent zero-row answer. Run schema-coverage with no --table to list the schema.`,
      },
    };
  }

  if (!columns.includes(column)) {
    const suggestions = nearMisses(column, columns);
    return {
      validation,
      failure: {
        kind: 'unknown_column',
        message: `Column '${column}' is not a Row column of '${table}' (${columns.length} columns).`,
        hint:
          suggestions.length > 0
            ? `Did you mean: ${suggestions.join(', ')}? Known columns: ${columns.join(', ')}`
            : `Known columns: ${columns.join(', ')}`,
      },
    };
  }

  return { validation };
}

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Project, SyntaxKind, ts, type Node, type SourceFile } from 'ts-morph';
import { glob } from 'tinyglobby';
import { isPair, isScalar, isSeq, parseDocument, visit } from 'yaml';
import type {
  FixtureUseKind,
  FixtureUseResult,
  FixtureUsesArgs,
  QueryResponse,
} from '../types';
import { buildErrorResponse, findEnclosing } from '../resolve';
import { truncateSpatial } from '../truncate';

const DEFAULT_LIMIT = 200;

const VALID_KINDS: readonly FixtureUseKind[] = ['key', 'value'];

/**
 * Default fixture target set, rooted at repoRoot and evaluated fresh per
 * invocation. "Fixture by convention" (D1) = a `/fixtures/` path segment OR a
 * `*-fixture.ts` basename — both attested in-repo. The `docs/ontology/*.md`
 * glob currently matches nothing in the canonical repo (the ontology docs
 * moved to the private docs-site, which inv 30 forbids scanning); it is kept
 * as a harmless no-op that self-heals if the docs return (D2).
 */
const DEFAULT_TARGETS = [
  '__tests__/**/*.json',
  '__tests__/**/fixtures/**/*.{ts,tsx}',
  '__tests__/**/*-fixture.{ts,tsx}',
  'e2e/fixtures/**/*.{ts,tsx,json,md}',
  'scripts/tests/fixtures/**/*.{ts,tsx,json,md}',
  'docs/ontology/*.md',
  'supabase/types/database.types.ts',
];

// ── shared position helpers ──────────────────────────────────────────────────

/** Offsets of each line start, for O(log n) offset→(line, column) mapping. */
function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** 1-based line/column for a 0-based character offset (inv 13). */
function offsetToLineCol(
  starts: number[],
  offset: number,
): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo] + 1 };
}

function readFileSafe(absPath: string): string | null {
  try {
    return readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

// ── JSON mode — hand-rolled string-token lexer ───────────────────────────────

type JsonFrame =
  | { type: 'object'; lastKey: string | null }
  | { type: 'array'; index: number };

interface JsonHit {
  offset: number; // 0-based offset of the opening quote
  kind: FixtureUseKind;
  context: string;
}

/** One structural path segment: `.lastKey` for objects, `[index]` for arrays. */
function appendSegment(path: string, frame: JsonFrame): string {
  if (frame.type === 'object') {
    if (frame.lastKey === null) return path;
    return path ? `${path}.${frame.lastKey}` : frame.lastKey;
  }
  return `${path}[${frame.index}]`;
}

/** Path locating a VALUE: every frame contributes (top frame = the value's slot). */
function valuePath(stack: JsonFrame[]): string {
  let path = '';
  for (const frame of stack) path = appendSegment(path, frame);
  return path;
}

/** Path locating a KEY: ancestors locate the containing object, then the key. */
function keyPath(stack: JsonFrame[], key: string): string {
  let path = '';
  for (const frame of stack.slice(0, -1)) path = appendSegment(path, frame);
  return path ? `${path}.${key}` : key;
}

/**
 * Key-vs-value is a lexical property in JSON: a string followed (after
 * whitespace) by `:` is a key; every other string is a value. The lexer
 * consumes string tokens with `\\` escapes, decodes via JSON.parse so escaped
 * spellings match the needle, and tracks a structural stack for `context`
 * paths. Malformed JSON never throws — rows found up to (and past) the bad
 * region are still emitted, because malformed fixtures remain greppable text.
 */
function scanJsonText(text: string, needle: string): JsonHit[] {
  const hits: JsonHit[] = [];
  const stack: JsonFrame[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      i++;
      while (i < text.length && text[i] !== '"') {
        i += text[i] === '\\' ? 2 : 1;
      }
      if (i >= text.length) break; // unterminated string at EOF
      const raw = text.slice(start, i + 1);
      i++; // past the closing quote
      let decoded: string | null;
      try {
        decoded = JSON.parse(raw) as string;
      } catch {
        decoded = null; // undecodable token (bad escape) — structure only
      }
      let j = i;
      while (j < text.length && ' \t\r\n'.includes(text[j])) j++;
      const isKey = text[j] === ':';
      if (decoded !== null && decoded === needle) {
        hits.push({
          offset: start,
          kind: isKey ? 'key' : 'value',
          context: isKey ? keyPath(stack, decoded) : valuePath(stack),
        });
      }
      const top = stack[stack.length - 1];
      if (isKey && top?.type === 'object') top.lastKey = decoded;
      continue;
    }
    if (ch === '{') stack.push({ type: 'object', lastKey: null });
    else if (ch === '[') stack.push({ type: 'array', index: 0 });
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === ',') {
      const top = stack[stack.length - 1];
      if (top?.type === 'array') top.index++;
    }
    i++;
  }
  return hits;
}

function scanJsonFile(
  relPath: string,
  repoRoot: string,
  needle: string,
): FixtureUseResult[] {
  const text = readFileSafe(resolve(repoRoot, relPath));
  if (text === null) return [];
  const starts = buildLineStarts(text);
  return scanJsonText(text, needle).map((hit) => ({
    file: relPath,
    ...offsetToLineCol(starts, hit.offset),
    confidence: 'indirect' as const,
    kind: hit.kind,
    fileType: 'json' as const,
    context: hit.context,
  }));
}

// ── Markdown frontmatter mode — yaml parseDocument ───────────────────────────

interface Frontmatter {
  text: string;
  /** 0-based offset of the frontmatter body within the md file. */
  start: number;
}

function extractFrontmatter(raw: string): Frontmatter | null {
  const firstNl = raw.indexOf('\n');
  if (firstNl === -1) return null;
  if (raw.slice(0, firstNl).replace(/\r$/, '') !== '---') return null;
  const start = firstNl + 1;
  const close = /^---[ \t]*$/m.exec(raw.slice(start));
  if (!close) return null;
  return { text: raw.slice(start, start + close.index), start };
}

/** Dotted YAML path from the visit ancestry, e.g. 'baseline_values[0].key'. */
function yamlContext(path: readonly unknown[], node: unknown): string {
  const chain = [...path, node];
  let ctx = '';
  for (let i = 0; i < chain.length; i++) {
    const n = chain[i];
    if (isPair(n)) {
      const keyText = isScalar(n.key) ? String(n.key.value) : '';
      if (keyText) ctx = ctx ? `${ctx}.${keyText}` : keyText;
    } else if (isSeq(n)) {
      const idx = n.items.indexOf(chain[i + 1]);
      ctx = `${ctx}[${idx >= 0 ? idx : 0}]`;
    }
  }
  return ctx;
}

/**
 * Only the frontmatter is scanned (inv 11); md body search stays cocoindex /
 * grep territory per PRODUCT Non-goals. Files with no frontmatter or a YAML
 * parse failure are skipped silently (same partial tolerance as JSON mode).
 */
function scanMarkdownFile(
  relPath: string,
  repoRoot: string,
  needle: string,
): FixtureUseResult[] {
  const text = readFileSafe(resolve(repoRoot, relPath));
  if (text === null) return [];
  const fm = extractFrontmatter(text);
  if (!fm) return [];
  const doc = parseDocument(fm.text);
  if (doc.errors.length > 0) return [];
  const starts = buildLineStarts(text);
  const out: FixtureUseResult[] = [];
  visit(doc, {
    Scalar(key, node, path) {
      if (node.value !== needle || !node.range) return;
      out.push({
        file: relPath,
        ...offsetToLineCol(starts, fm.start + node.range[0]),
        confidence: 'indirect',
        kind: key === 'key' ? 'key' : 'value',
        fileType: 'md-frontmatter',
        context: yamlContext(path, node),
      });
    },
  });
  return out;
}

// ── TS mode — ad-hoc ts-morph parses, NOT the main project ───────────────────

/** True when the literal is the NAME of a property/enum member (quoted key). */
function isQuotedPropertyName(literal: Node): boolean {
  const parent = literal.getParent();
  if (!parent) return false;
  const k = parent.getKind();
  if (
    k !== SyntaxKind.PropertyAssignment &&
    k !== SyntaxKind.PropertySignature &&
    k !== SyntaxKind.EnumMember
  ) {
    return false;
  }
  const nameNode = (parent as { getNameNode?: () => Node }).getNameNode?.();
  return nameNode?.getStart() === literal.getStart();
}

function makeTsRow(
  relPath: string,
  sf: SourceFile,
  node: Node,
  kind: FixtureUseKind,
): FixtureUseResult {
  const pos = sf.getLineAndColumnAtPos(node.getStart());
  return {
    file: relPath,
    line: pos.line,
    column: pos.column,
    confidence: 'indirect',
    kind,
    fileType: 'ts',
    context: findEnclosing(node),
  };
}

/**
 * Root tsconfig excludes `scripts` and `supabase`, so the passed-in project
 * cannot see all targets — every fixture TS file is parsed ad hoc in a
 * throwaway project instead. No type-checking is needed (everything is
 * 'indirect' confidence): this is a pure parse, fast even for the large
 * `database.types.ts`.
 *
 * Matching rules (D3): string/template literals equal to the needle → 'value',
 * unless the literal is a quoted property/enum-member name → 'key'; Identifier
 * property names (object-literal PropertyAssignment, type-literal
 * PropertySignature — the `database.types.ts` Row/Insert/Update case) → 'key'.
 */
function scanTsFiles(
  relPaths: string[],
  repoRoot: string,
  needle: string,
): FixtureUseResult[] {
  if (relPaths.length === 0) return [];
  const adhoc = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      allowJs: true,
      jsx: ts.JsxEmit.ReactJSX,
      skipLibCheck: true,
    },
  });
  const out: FixtureUseResult[] = [];
  for (const relPath of relPaths) {
    let sf: SourceFile;
    try {
      sf = adhoc.addSourceFileAtPath(resolve(repoRoot, relPath));
    } catch {
      continue; // unreadable file — partial tolerance
    }

    const literals = [
      ...sf.getDescendantsOfKind(SyntaxKind.StringLiteral),
      ...sf.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
    ];
    for (const literal of literals) {
      if (literal.getLiteralValue() !== needle) continue;
      const kind = isQuotedPropertyName(literal) ? 'key' : 'value';
      out.push(makeTsRow(relPath, sf, literal, kind));
    }

    const namedProps = [
      ...sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment),
      ...sf.getDescendantsOfKind(SyntaxKind.PropertySignature),
    ];
    for (const prop of namedProps) {
      const nameNode = prop.getNameNode();
      if (nameNode.getKind() !== SyntaxKind.Identifier) continue;
      if (nameNode.getText() !== needle) continue;
      out.push(makeTsRow(relPath, sf, nameNode, 'key'));
    }
  }
  return out;
}

// ── query entry point ────────────────────────────────────────────────────────

/**
 * Find every occurrence of an exact string in the fixture corpus — JSON
 * fixtures, fixture-flagged TS, md frontmatter, and `database.types.ts` —
 * split into key vs value occurrences (PRODUCT.md invariant 11).
 *
 * The main ts-morph project is deliberately unused: the root tsconfig
 * excludes `scripts`, `supabase`, and the tool's own fixtures, so discovery
 * is glob-driven and each file is scanned in its own mode.
 */
export async function fixtureUses(
  args: FixtureUsesArgs,
  _project: Project,
  repoRoot: string,
): Promise<QueryResponse<FixtureUseResult>> {
  const started = Date.now();
  const limit = args.limit ?? DEFAULT_LIMIT;

  if (!args.needle) {
    return buildErrorResponse<FixtureUseResult>(
      'fixture-uses',
      { ...args, limit },
      'parse_error',
      'The "needle" argument is required and must be a non-empty string.',
      'Provide the exact string to search for, e.g. --needle project_id.',
      Date.now() - started,
    );
  }

  const kinds = args.kinds;
  if (kinds) {
    const invalid = kinds.filter((k) => !VALID_KINDS.includes(k));
    if (invalid.length > 0) {
      return buildErrorResponse<FixtureUseResult>(
        'fixture-uses',
        { ...args, limit },
        'parse_error',
        `Invalid kinds value: "${invalid.join(', ')}". Valid kinds: ${VALID_KINDS.join(', ')}.`,
        "Pass --kinds as a comma-separated subset of 'key,value'.",
        Date.now() - started,
      );
    }
  }

  const patterns = args.scope
    ? args.scope
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean)
    : DEFAULT_TARGETS;

  const discovered = await glob(patterns, {
    cwd: repoRoot,
    ignore: ['**/node_modules/**'],
  });
  const files = [...new Set(discovered)].sort();

  const rows: FixtureUseResult[] = [];
  const tsFiles: string[] = [];
  for (const relPath of files) {
    if (relPath.endsWith('.json')) {
      rows.push(...scanJsonFile(relPath, repoRoot, args.needle));
    } else if (relPath.endsWith('.ts') || relPath.endsWith('.tsx')) {
      tsFiles.push(relPath);
    } else if (relPath.endsWith('.md')) {
      rows.push(...scanMarkdownFile(relPath, repoRoot, args.needle));
    }
    // Any other extension (e.g. binary assets pulled in via --scope) is
    // silently skipped.
  }
  rows.push(...scanTsFiles(tsFiles, repoRoot, args.needle));

  const filtered = kinds ? rows.filter((r) => kinds.includes(r.kind)) : rows;

  const t = truncateSpatial(filtered, limit);
  return {
    query: 'fixture-uses',
    args: { ...args, limit },
    results: t.rows,
    truncated: t.truncated,
    totalEstimated: t.totalEstimated,
    durationMs: Date.now() - started,
  };
}

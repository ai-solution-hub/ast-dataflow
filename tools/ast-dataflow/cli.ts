#!/usr/bin/env bun
import { resolve } from 'node:path';
import {
  callers,
  columnReads,
  columnWrites,
  deadExports,
  enumUses,
  flowTrace,
  importers,
  reexportChain,
  references,
  stringLiteralUses,
  typeEvolution,
  typeDriftDetect,
  createProject,
} from '../lib/ast-dataflow';
import type { ReferenceKind, TypeDriftResult } from '../lib/ast-dataflow';

interface ParsedArgs {
  query: string | undefined;
  flags: Record<string, string | boolean>;
}

function parse(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { query: undefined, flags: {} };
  if (argv.length === 0) return out;
  out.query = argv[0];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out.flags[key] = true;
    } else {
      out.flags[key] = next;
      i++;
    }
  }
  return out;
}

const REFERENCE_KINDS: ReferenceKind[] = [
  'read',
  'write',
  'typeReference',
  'jsxComponent',
  'reexport',
  'typeOnly',
];

/**
 * Emit a query response to stdout (PRODUCT.md P-29).
 *
 * Rules:
 * - Always exits 0 when `response.error` is present (structured error, not crash).
 * - When `--pretty` is set and `response.error` is present, emits a human-readable
 *   "error: <kind> — <message>" line before the JSON envelope so the error is
 *   immediately visible without parsing JSON.
 * - The full JSON envelope is always emitted so downstream tools can branch on
 *   `error.kind` without parsing stderr.
 */
function emitResponse(
  response: {
    error?: { kind: string; message: string; hint?: string };
    [k: string]: unknown;
  },
  pretty: boolean,
): void {
  if (pretty && response.error) {
    console.error(`error: ${response.error.kind} — ${response.error.message}`);
    if (response.error.hint) {
      console.error(`hint: ${response.error.hint}`);
    }
  }
  console.log(JSON.stringify(response, null, pretty ? 2 : 0));
}

function printCatalogue(): void {
  console.log(
    JSON.stringify(
      {
        queries: [
          {
            name: 'callers',
            args: ['--symbol <file:name>', '--limit N', '--pretty'],
            example:
              'bun run ast-dataflow callers --symbol lib/supabase/safe.ts:sb',
          },
          {
            name: 'importers',
            args: ['--module <module-path>', '--limit N', '--json', '--pretty'],
            example:
              "bun run ast-dataflow importers --module '@/lib/ai/digest'",
          },
          {
            name: 'references',
            args: [
              '--symbol <file:name>',
              `--kind ${REFERENCE_KINDS.join('|')}`,
              '--limit N',
              '--json',
              '--pretty',
            ],
            example:
              "bun run ast-dataflow references --symbol 'types/bid.ts:BidState'",
          },
          {
            name: 'column-reads',
            args: [
              '--table <table-name>',
              '--column <column-name>',
              '--exclude-tests',
              '--limit N',
              '--pretty',
            ],
            example:
              'bun run ast-dataflow column-reads --table bid_questions --column project_id',
          },
          {
            name: 'column-writes',
            args: [
              '--table <table-name>',
              '--column <column-name>',
              '--exclude-tests',
              '--limit N',
              '--pretty',
            ],
            example:
              'bun run ast-dataflow column-writes --table bid_questions --column project_id',
          },
          {
            name: 'type-evolution',
            args: [
              '--type <TypeName>',
              '--property <propertyName>',
              '--file <relative-path>',
              '--exclude-tests',
              '--limit N',
              '--pretty',
            ],
            example:
              'bun scripts/ast-dataflow-cli.ts type-evolution --type BidQuestion --property project_id',
          },
          {
            name: 'dead-exports',
            args: [
              '--symbol <name>',
              '--symbols <file>',
              '--exclude-tests',
              '--limit N',
              '--pretty',
            ],
            example:
              'bun scripts/ast-dataflow-cli.ts dead-exports --symbol unusedHelper --exclude-tests',
          },
          {
            name: 'reexport-chain',
            args: [
              '--symbol <name>',
              '--from <file>',
              '--exclude-tests',
              '--limit N',
              '--pretty',
            ],
            example:
              'bun scripts/ast-dataflow-cli.ts reexport-chain --symbol DialogClose --from components/ui/dialog.tsx',
          },
          // --- enum-uses ---
          {
            name: 'enum-uses',
            args: [
              '--enum <EnumName>',
              '--member <MemberName>',
              '--limit N',
              '--pretty',
            ],
            example:
              'bun scripts/ast-dataflow-cli.ts enum-uses --enum OrderStatus --member PENDING',
          },
          // --- string-literal-uses ---
          {
            name: 'string-literal-uses',
            args: ['--value <literal>', '--limit N', '--pretty'],
            example:
              "bun scripts/ast-dataflow-cli.ts string-literal-uses --value '@/lib/supabase/safe'",
          },
          // --- type-drift-detect ---
          {
            name: 'type-drift-detect',
            args: [
              '[--limit N]',
              '[--scope GLOB[,GLOB...]]',
              '[--interface-pattern <regex>]',
              '[--ci]',
              '[--update-baseline]',
              '[--json | --pretty]',
            ],
            example:
              'bun run ast-dataflow type-drift-detect --pretty',
          },
          // --- flow-trace ---
          {
            name: 'flow-trace',
            args: [
              '--origin-file <repo-root-relative-path>',
              '--origin-line <N>',
              '--origin-column <N>',
              '[--max-depth <N>]',
              '[--inter-function]',
              '[--limit <N>]',
              '[--exclude-tests]',
              '[--json | --pretty]',
            ],
            example:
              'bun scripts/ast-dataflow-cli.ts flow-trace --origin-file lib/bid/bid-queries.ts --origin-line 42 --origin-column 9 --inter-function --pretty',
          },
        ],
        notes:
          'S9 — callers + importers + references + column-reads + column-writes + type-evolution + dead-exports + reexport-chain + enum-uses + string-literal-uses + flow-trace + type-drift-detect queries are wired. See docs/specs/ast-dataflow-tool/PRODUCT.md for the full surface.',
      },
      null,
      2,
    ),
  );
}

/**
 * Render the type-drift-detect results as a human-readable Markdown report.
 * Follows PRODUCT.md D-12: summary table + four sections (fetcher-only first).
 */
function renderMarkdownReport(results: TypeDriftResult[]): string {
  const counts: Record<string, number> = {
    'fetcher-only': 0,
    'route-only': 0,
    enforced: 0,
    unused: 0,
  };
  for (const r of results) {
    counts[r.classification] = (counts[r.classification] ?? 0) + 1;
  }

  const lines: string[] = [];
  lines.push('# Type-Drift Detector Report');
  lines.push('');
  lines.push(
    '> Generated by `bun run ast-dataflow type-drift-detect`. ' +
      'Interfaces that are used in fetchers but not annotated in the matching route handler.',
  );
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Classification | Count |');
  lines.push('|---|---|');
  lines.push(`| fetcher-only | ${counts['fetcher-only']} |`);
  lines.push(`| route-only | ${counts['route-only']} |`);
  lines.push(`| enforced | ${counts['enforced']} |`);
  lines.push(`| unused | ${counts['unused']} |`);
  lines.push(`| **total** | **${results.length}** |`);
  lines.push('');

  const sections: Array<{
    key: TypeDriftResult['classification'];
    heading: string;
  }> = [
    { key: 'fetcher-only', heading: 'Fetcher-Only (Gap — no route annotation)' },
    { key: 'route-only', heading: 'Route-Only (Lower-risk — no matching fetcher generic)' },
    { key: 'enforced', heading: 'Enforced (Symmetric usage)' },
    { key: 'unused', heading: 'Unused (Neither fetcher nor route)' },
  ];

  for (const { key, heading } of sections) {
    const sectionRows = results.filter((r) => r.classification === key);
    if (sectionRows.length === 0) continue;

    lines.push(`## ${heading}`);
    lines.push('');

    for (const row of sectionRows) {
      lines.push(`### \`${row.interface}\``);
      lines.push('');
      lines.push(
        `- **Declared at:** \`${row.declaredAt.file}:${row.declaredAt.line}\``,
      );
      lines.push(`- **Classification:** ${row.classification}`);
      lines.push(`- **Confidence:** ${row.confidence}`);

      if (row.fetchers.length > 0) {
        lines.push('- **Fetcher call sites:**');
        for (const f of row.fetchers) {
          const urlStr = f.url ? ` → \`${f.url}\`` : ' (unresolved URL)';
          lines.push(`  - \`${f.file}:${f.line}\`${urlStr}`);
        }
      }

      if (row.routes.length > 0) {
        lines.push('- **Route annotations:**');
        for (const r2 of row.routes) {
          lines.push(
            `  - \`${r2.file}:${r2.line}\` (confidence: ${r2.confidence})`,
          );
        }
      }

      if (row.candidateRoutes.length > 0) {
        lines.push('- **Candidate routes (not annotated):**');
        for (const cr of row.candidateRoutes) {
          lines.push(
            `  - \`${cr.file}:${cr.line}\` (${cr.matchReason}, confidence: ${cr.confidence})`,
          );
        }
      }

      if (row.testOnly) {
        lines.push('- **Note:** only referenced in test files');
      }

      if (row.allowlisted) {
        lines.push(`- **Allowlisted:** ${row.allowlisted.reason}`);
      }

      lines.push('');
      lines.push(`> **Remediation:** ${row.remediationHint}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  const parsed = parse(process.argv.slice(2));
  if (!parsed.query) {
    printCatalogue();
    return;
  }

  const repoRoot = process.cwd();
  const tsConfigFilePath = resolve(repoRoot, 'tsconfig.json');
  const { project } = createProject({ tsConfigFilePath, repoRoot });

  switch (parsed.query) {
    case 'callers': {
      const symbol = parsed.flags.symbol;
      if (typeof symbol !== 'string') {
        console.error('callers requires --symbol <file:name>');
        process.exit(2);
      }
      const limitArg = parsed.flags.limit;
      const limit =
        typeof limitArg === 'string'
          ? Number.parseInt(limitArg, 10)
          : undefined;
      const response = await callers(
        { symbol, ...(limit ? { limit } : {}) },
        project,
        repoRoot,
      );
      const pretty = parsed.flags.pretty === true;
      emitResponse(response, pretty);
      return;
    }
    case 'importers': {
      const modulePath = parsed.flags.module;
      if (typeof modulePath !== 'string') {
        console.error('importers requires --module <module-path>');
        console.error(
          "Example: bun run ast-dataflow importers --module '@/lib/ai/digest'",
        );
        process.exit(2);
      }
      const limitArg = parsed.flags.limit;
      const limit =
        typeof limitArg === 'string'
          ? Number.parseInt(limitArg, 10)
          : undefined;
      const response = await importers(
        { modulePath, ...(limit ? { limit } : {}) },
        project,
        repoRoot,
      );
      const pretty = parsed.flags.pretty === true;
      emitResponse(response, pretty);
      return;
    }
    case 'references': {
      const symbol = parsed.flags.symbol;
      if (typeof symbol !== 'string') {
        console.error('references requires --symbol <file:name>');
        console.error(
          "Example: bun run ast-dataflow references --symbol 'types/bid.ts:BidState'",
        );
        process.exit(2);
      }
      const limitArg = parsed.flags.limit;
      const limit =
        typeof limitArg === 'string'
          ? Number.parseInt(limitArg, 10)
          : undefined;
      const kindArg = parsed.flags.kind;
      const kind =
        typeof kindArg === 'string' &&
        REFERENCE_KINDS.includes(kindArg as ReferenceKind)
          ? (kindArg as ReferenceKind)
          : undefined;
      if (kindArg && !kind) {
        console.error(
          `Invalid --kind value: "${kindArg}". Valid kinds: ${REFERENCE_KINDS.join(', ')}`,
        );
        process.exit(2);
      }
      const response = await references(
        { symbol, ...(limit ? { limit } : {}), ...(kind ? { kind } : {}) },
        project,
        repoRoot,
      );
      const pretty = parsed.flags.pretty === true;
      emitResponse(response, pretty);
      return;
    }
    case 'column-reads': {
      const table = parsed.flags.table;
      const column = parsed.flags.column;
      if (typeof table !== 'string' || !table) {
        console.error('column-reads requires --table <table-name>');
        console.error(
          'Example: bun run ast-dataflow column-reads --table bid_questions --column project_id',
        );
        process.exit(2);
      }
      if (typeof column !== 'string' || !column) {
        console.error('column-reads requires --column <column-name>');
        console.error(
          'Example: bun run ast-dataflow column-reads --table bid_questions --column project_id',
        );
        process.exit(2);
      }
      const limitArg = parsed.flags.limit;
      const limit =
        typeof limitArg === 'string'
          ? Number.parseInt(limitArg, 10)
          : undefined;
      const excludeTests = parsed.flags['exclude-tests'] === true;
      const response = await columnReads(
        {
          table,
          column,
          ...(limit ? { limit } : {}),
          ...(excludeTests ? { excludeTests } : {}),
        },
        project,
        repoRoot,
      );
      const pretty = parsed.flags.pretty === true;
      emitResponse(response, pretty);
      return;
    }
    case 'column-writes': {
      const table = parsed.flags.table;
      const column = parsed.flags.column;
      if (typeof table !== 'string' || !table) {
        console.error('column-writes requires --table <table-name>');
        console.error(
          'Example: bun run ast-dataflow column-writes --table bid_questions --column project_id',
        );
        process.exit(2);
      }
      if (typeof column !== 'string' || !column) {
        console.error('column-writes requires --column <column-name>');
        console.error(
          'Example: bun run ast-dataflow column-writes --table bid_questions --column project_id',
        );
        process.exit(2);
      }
      const limitArg = parsed.flags.limit;
      const limit =
        typeof limitArg === 'string'
          ? Number.parseInt(limitArg, 10)
          : undefined;
      const excludeTests = parsed.flags['exclude-tests'] === true;
      const response = await columnWrites(
        {
          table,
          column,
          ...(limit ? { limit } : {}),
          ...(excludeTests ? { excludeTests } : {}),
        },
        project,
        repoRoot,
      );
      const pretty = parsed.flags.pretty === true;
      emitResponse(response, pretty);
      return;
    }
    case 'type-evolution': {
      const typeName = parsed.flags.type;
      const property = parsed.flags.property;
      if (typeof typeName !== 'string' || !typeName) {
        console.error('type-evolution requires --type <TypeName>');
        console.error(
          'Example: bun scripts/ast-dataflow-cli.ts type-evolution --type BidQuestion --property project_id',
        );
        process.exit(2);
      }
      if (typeof property !== 'string' || !property) {
        console.error('type-evolution requires --property <propertyName>');
        console.error(
          'Example: bun scripts/ast-dataflow-cli.ts type-evolution --type BidQuestion --property project_id',
        );
        process.exit(2);
      }
      const limitArg = parsed.flags.limit;
      const limit =
        typeof limitArg === 'string'
          ? Number.parseInt(limitArg, 10)
          : undefined;
      const fileArg = parsed.flags.file;
      const file = typeof fileArg === 'string' ? fileArg : undefined;
      const excludeTests = parsed.flags['exclude-tests'] === true;
      const response = await typeEvolution(
        {
          type: typeName,
          property,
          ...(file ? { file } : {}),
          ...(limit ? { limit } : {}),
          ...(excludeTests ? { excludeTests } : {}),
        },
        project,
        repoRoot,
      );
      const pretty = parsed.flags.pretty === true;
      emitResponse(response, pretty);
      return;
    }
    case 'dead-exports': {
      const symbolArg = parsed.flags.symbol;
      const symbolsFileArg = parsed.flags.symbols;
      const limitArg = parsed.flags.limit;
      const limit =
        typeof limitArg === 'string'
          ? Number.parseInt(limitArg, 10)
          : undefined;
      const excludeTests = parsed.flags['exclude-tests'] === true;
      const response = await deadExports(
        {
          ...(typeof symbolArg === 'string' ? { symbol: symbolArg } : {}),
          ...(typeof symbolsFileArg === 'string'
            ? { symbolsFile: symbolsFileArg }
            : {}),
          ...(limit ? { limit } : {}),
          ...(excludeTests ? { excludeTests } : {}),
        },
        project,
        repoRoot,
      );
      const pretty = parsed.flags.pretty === true;
      emitResponse(response, pretty);
      return;
    }
    case 'reexport-chain': {
      const symbolArg = parsed.flags.symbol;
      if (typeof symbolArg !== 'string' || !symbolArg) {
        console.error('reexport-chain requires --symbol <name>');
        console.error(
          'Example: bun scripts/ast-dataflow-cli.ts reexport-chain --symbol DialogClose --from components/ui/dialog.tsx',
        );
        process.exit(2);
      }
      const fromArg = parsed.flags.from;
      const from = typeof fromArg === 'string' ? fromArg : undefined;
      const limitArg = parsed.flags.limit;
      const limit =
        typeof limitArg === 'string'
          ? Number.parseInt(limitArg, 10)
          : undefined;
      const excludeTests = parsed.flags['exclude-tests'] === true;
      const response = await reexportChain(
        {
          symbol: symbolArg,
          ...(from ? { from } : {}),
          ...(limit ? { limit } : {}),
          ...(excludeTests ? { excludeTests } : {}),
        },
        project,
        repoRoot,
      );
      const pretty = parsed.flags.pretty === true;
      emitResponse(response, pretty);
      return;
    }
    // --- enum-uses ---
    case 'enum-uses': {
      const enumName = parsed.flags.enum;
      if (typeof enumName !== 'string' || !enumName) {
        console.error('enum-uses requires --enum <EnumName>');
        console.error(
          'Example: bun scripts/ast-dataflow-cli.ts enum-uses --enum OrderStatus',
        );
        process.exit(2);
      }
      const memberArg = parsed.flags.member;
      const member = typeof memberArg === 'string' ? memberArg : undefined;
      const limitArg = parsed.flags.limit;
      const limit =
        typeof limitArg === 'string'
          ? Number.parseInt(limitArg, 10)
          : undefined;
      const response = await enumUses(
        {
          enum: enumName,
          ...(member ? { member } : {}),
          ...(limit ? { limit } : {}),
        },
        project,
        repoRoot,
      );
      const pretty = parsed.flags.pretty === true;
      emitResponse(response, pretty);
      return;
    }
    // --- string-literal-uses ---
    case 'string-literal-uses': {
      const valueArg = parsed.flags.value;
      if (typeof valueArg !== 'string' || !valueArg) {
        console.error('string-literal-uses requires --value <literal>');
        console.error(
          "Example: bun scripts/ast-dataflow-cli.ts string-literal-uses --value '@/lib/supabase/safe'",
        );
        process.exit(2);
      }
      const limitArg = parsed.flags.limit;
      const limit =
        typeof limitArg === 'string'
          ? Number.parseInt(limitArg, 10)
          : undefined;
      const response = await stringLiteralUses(
        {
          value: valueArg,
          ...(limit ? { limit } : {}),
        },
        project,
        repoRoot,
      );
      const pretty = parsed.flags.pretty === true;
      emitResponse(response, pretty);
      return;
    }
    // --- flow-trace ---
    case 'flow-trace': {
      const originFile = parsed.flags['origin-file'];
      const originLineRaw = parsed.flags['origin-line'];
      const originColumnRaw = parsed.flags['origin-column'];

      if (typeof originFile !== 'string' || !originFile) {
        console.error(
          'flow-trace requires --origin-file <repo-root-relative-path>',
        );
        console.error(
          'Example: bun scripts/ast-dataflow-cli.ts flow-trace --origin-file lib/bid/bid-queries.ts --origin-line 42 --origin-column 9',
        );
        process.exit(2);
      }
      if (typeof originLineRaw !== 'string' || !originLineRaw) {
        console.error('flow-trace requires --origin-line <N>');
        process.exit(2);
      }
      if (typeof originColumnRaw !== 'string' || !originColumnRaw) {
        console.error('flow-trace requires --origin-column <N>');
        process.exit(2);
      }

      const originLine = Number.parseInt(originLineRaw, 10);
      const originColumn = Number.parseInt(originColumnRaw, 10);
      if (Number.isNaN(originLine) || originLine < 1) {
        console.error('--origin-line must be a positive integer');
        process.exit(2);
      }
      if (Number.isNaN(originColumn) || originColumn < 1) {
        console.error('--origin-column must be a positive integer');
        process.exit(2);
      }

      const maxDepthRaw = parsed.flags['max-depth'];
      const maxDepth =
        typeof maxDepthRaw === 'string'
          ? Number.parseInt(maxDepthRaw, 10)
          : undefined;
      if (maxDepth !== undefined && (Number.isNaN(maxDepth) || maxDepth < 1 || maxDepth > 20)) {
        console.error('--max-depth must be an integer between 1 and 20');
        process.exit(2);
      }

      const interFunction = parsed.flags['inter-function'] === true;
      const limitArg = parsed.flags.limit;
      const limit =
        typeof limitArg === 'string'
          ? Number.parseInt(limitArg, 10)
          : undefined;
      const excludeTests = parsed.flags['exclude-tests'] === true;
      const pretty = parsed.flags.pretty === true;

      // Validate for unknown flags (PRODUCT.md invariant 29).
      const knownFlags = new Set([
        'origin-file',
        'origin-line',
        'origin-column',
        'max-depth',
        'inter-function',
        'limit',
        'exclude-tests',
        'json',
        'pretty',
      ]);
      for (const flag of Object.keys(parsed.flags)) {
        if (!knownFlags.has(flag)) {
          console.error(`Unknown flag: --${flag}`);
          console.error(
            'Valid flags: --origin-file, --origin-line, --origin-column, --max-depth, --inter-function, --limit, --exclude-tests, --json, --pretty',
          );
          process.exit(2);
        }
      }

      const response = await flowTrace(
        {
          originFile,
          originLine,
          originColumn,
          ...(maxDepth !== undefined ? { maxDepth } : {}),
          ...(interFunction ? { interFunction } : {}),
          ...(limit ? { limit } : {}),
          ...(excludeTests ? { excludeTests } : {}),
        },
        project,
        repoRoot,
      );
      emitResponse(response, pretty);
      return;
    }
    // --- type-drift-detect ---
    case 'type-drift-detect': {
      const limitArg = parsed.flags.limit;
      const limit =
        typeof limitArg === 'string'
          ? Number.parseInt(limitArg, 10)
          : undefined;
      const scopeArg = parsed.flags.scope;
      const scope = typeof scopeArg === 'string' ? scopeArg : undefined;
      const ifacePatternArg = parsed.flags['interface-pattern'];
      const interfacePattern =
        typeof ifacePatternArg === 'string' ? ifacePatternArg : undefined;
      const ci = parsed.flags.ci === true;
      const updateBaseline = parsed.flags['update-baseline'] === true;
      const jsonMode = parsed.flags.json === true;
      const pretty = parsed.flags.pretty === true;

      const response = await typeDriftDetect(
        {
          ...(limit ? { limit } : {}),
          ...(scope ? { scope } : {}),
          ...(interfacePattern ? { interfacePattern } : {}),
          ...(ci ? { ci } : {}),
          ...(updateBaseline ? { updateBaseline } : {}),
          ...(jsonMode ? { json: true } : {}),
          ...(pretty ? { pretty } : {}),
        },
        project,
        repoRoot,
      );

      const typedResponse = response as typeof response & {
        newSinceBaseline?: string[];
      };

      if (ci && typedResponse.newSinceBaseline?.length) {
        // Emit new rows as JSONL on stdout for CI consumers
        for (const row of response.results.filter(
          (r: TypeDriftResult) =>
            r.classification === 'fetcher-only' &&
            typedResponse.newSinceBaseline?.includes(r.interface),
        )) {
          console.log(JSON.stringify(row));
        }
        console.error(
          `type-drift-detect: ${typedResponse.newSinceBaseline.length} new fetcher-only interface(s) not in baseline: ${typedResponse.newSinceBaseline.join(', ')}`,
        );
        process.exit(1);
      }

      if (updateBaseline) {
        // Write fetcher-only rows to baseline file
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const { join: pathJoin } = await import('node:path');
        const baselineDir = pathJoin(repoRoot, 'docs', 'generated');
        mkdirSync(baselineDir, { recursive: true });
        const fetcherOnlyRows = response.results
          .filter(
            (r: TypeDriftResult) =>
              r.classification === 'fetcher-only' && !r.allowlisted,
          )
          .map((r: TypeDriftResult) => ({
            interface: r.interface,
            declaredAt: { file: r.declaredAt.file },
          }));
        writeFileSync(
          pathJoin(baselineDir, 'type-drift-baseline.json'),
          JSON.stringify(fetcherOnlyRows, null, 2),
        );
        console.error(
          `type-drift-detect: baseline updated with ${fetcherOnlyRows.length} fetcher-only interface(s).`,
        );
      }

      if (jsonMode || ci) {
        // JSONL: one row per line
        for (const row of response.results) {
          console.log(JSON.stringify(row));
        }
      } else {
        // Markdown (default --pretty or no flag)
        console.log(renderMarkdownReport(response.results));
      }

      // Also regenerate the docs/generated/type-drift-report.md when --ci
      if (ci) {
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const { join: pathJoin } = await import('node:path');
        const docsDir = pathJoin(repoRoot, 'docs', 'generated');
        mkdirSync(docsDir, { recursive: true });
        writeFileSync(
          pathJoin(docsDir, 'type-drift-report.md'),
          renderMarkdownReport(response.results),
        );
      }

      return;
    }
    default: {
      console.error(`Unknown query: ${parsed.query}`);
      console.error(
        'Valid queries: callers, importers, references, column-reads, column-writes, type-evolution, dead-exports, reexport-chain, enum-uses, string-literal-uses, flow-trace, type-drift-detect',
      );
      process.exit(2);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

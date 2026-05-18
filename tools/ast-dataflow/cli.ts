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
  createProject,
} from '@/lib/ast-dataflow';
import type { ReferenceKind } from '@/lib/ast-dataflow';

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
          'S7 — callers + importers + references + column-reads + column-writes + type-evolution + dead-exports + reexport-chain + enum-uses + string-literal-uses + flow-trace queries are wired. See docs/specs/ast-dataflow-tool/PRODUCT.md for the full surface.',
      },
      null,
      2,
    ),
  );
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
    default: {
      console.error(`Unknown query: ${parsed.query}`);
      console.error(
        'Valid queries: callers, importers, references, column-reads, column-writes, type-evolution, dead-exports, reexport-chain, enum-uses, string-literal-uses, flow-trace',
      );
      process.exit(2);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

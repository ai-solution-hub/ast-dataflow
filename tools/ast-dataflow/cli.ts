#!/usr/bin/env bun
import { resolve } from 'node:path';
import { callers, importers, references, createProject } from '@/lib/ast-dataflow';
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
  response: { error?: { kind: string; message: string; hint?: string }; [k: string]: unknown },
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
        ],
        notes:
          'S3 — callers + importers + references queries are wired. See docs/specs/ast-dataflow-tool/PRODUCT.md for the full surface.',
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
        typeof limitArg === 'string' ? Number.parseInt(limitArg, 10) : undefined;
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
        console.error("importers requires --module <module-path>");
        console.error("Example: bun run ast-dataflow importers --module '@/lib/ai/digest'");
        process.exit(2);
      }
      const limitArg = parsed.flags.limit;
      const limit =
        typeof limitArg === 'string' ? Number.parseInt(limitArg, 10) : undefined;
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
        console.error("Example: bun run ast-dataflow references --symbol 'types/bid.ts:BidState'");
        process.exit(2);
      }
      const limitArg = parsed.flags.limit;
      const limit =
        typeof limitArg === 'string' ? Number.parseInt(limitArg, 10) : undefined;
      const kindArg = parsed.flags.kind;
      const kind =
        typeof kindArg === 'string' && REFERENCE_KINDS.includes(kindArg as ReferenceKind)
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
    default: {
      console.error(`Unknown query: ${parsed.query}`);
      console.error('Valid queries: callers, importers, references');
      process.exit(2);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

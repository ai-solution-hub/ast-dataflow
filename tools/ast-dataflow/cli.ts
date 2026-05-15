#!/usr/bin/env bun
import { resolve } from 'node:path';
import { callers, importers, createProject } from '@/lib/ast-dataflow';

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
        ],
        notes:
          'S2 — callers + importers queries are wired. See docs/specs/ast-dataflow-tool/PRODUCT.md for the full surface.',
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
      console.log(JSON.stringify(response, null, pretty ? 2 : 0));
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
      console.log(JSON.stringify(response, null, pretty ? 2 : 0));
      return;
    }
    default: {
      console.error(`Unknown query: ${parsed.query}`);
      console.error('Valid queries: callers, importers');
      process.exit(2);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

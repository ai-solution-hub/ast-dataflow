#!/usr/bin/env bun
/**
 * Warm MCP stdio server for the ast-dataflow query catalogue (fixCache.md
 * Stage 1). Holds the ts-morph Project in memory across tool calls so
 * repeat queries cost 0.08–2.1 s instead of the ~5 s per-invocation Project
 * rebuild the CLI pays. One server per Claude Code session (client-owned
 * subprocess, spawned on stdio) — the CLI remains the always-available cold
 * path, so nothing ever blocks on a shared daemon (inv 21).
 *
 * Run: bun run ast-dataflow-mcp            (stdio server, from repo root)
 *      bun run ast-dataflow-mcp --corpus-info   (print corpus stats and exit)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { QUERY_NAMES, REQUIRED_ARGS } from './dispatch';
import type { QueryArgMap, QueryName } from './dispatch';
import {
  createSerialQueue,
  createWarmState,
  sweepStaleness,
  warmDispatch,
} from './staleness';
import type { WarmState } from './staleness';

const repoRoot = process.cwd();

/** Built lazily on the first tool call — construction costs ~5 s on the full
 *  corpus and the server must come up fast enough for the MCP handshake. */
let state: WarmState | undefined;

function getState(): WarmState {
  state ??= createWarmState({ repoRoot });
  return state;
}

/** All tool work funnels through one promise chain (inv 21): ts-morph is
 *  single-threaded, so overlapping tools/call requests run in order. */
const queue = createSerialQueue();

function textResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function corpusInfo(warm: WarmState): {
  fileCount: number;
  tsconfigPath: string;
} {
  return {
    fileCount: warm.project.getSourceFiles().length,
    tsconfigPath: warm.tsConfigFilePath,
  };
}

const TOOLS = [
  {
    name: 'ast_dataflow',
    description:
      'Run one ast-dataflow query against a warm, type-checked ts-morph view of the repo. ' +
      'Same catalogue and JSON envelope as `bun run ast-dataflow <query>`; `args` mirrors the CLI flags as camelCase keys ' +
      "(e.g. callers/callees/references: {symbol: 'lib/supabase/safe.ts:sb'}; importers: {modulePath}; " +
      'column-reads/column-writes: {table, column}; type-evolution: {type, property}; enum-uses: {enum, member?}; ' +
      'string-literal-uses: {value}; fixture-uses: {needle}; reexport-chain: {symbol, from?}; ' +
      'flow-trace: {originFile, originLine, originColumn}; plus optional limit/excludeTests/scope where the CLI accepts them). ' +
      'Responses add meta: {refreshedFiles, addedFiles, removedFiles, staleFiles} — the per-call staleness sweep; ' +
      'a non-empty staleFiles means those files could not be refreshed and answers may be stale for them.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          enum: [...QUERY_NAMES],
          description: 'The query to run.',
        },
        args: {
          type: 'object',
          description:
            'Query arguments (camelCase keys, same shapes as the CLI flags). Run the CLI with no arguments for the full catalogue.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'corpus_info',
    description:
      'Report the warm corpus: resolved source-file count and the tsconfig path driving file enumeration.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const;

async function handleAstDataflow(
  rawArgs: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const query = rawArgs?.query;
  if (
    typeof query !== 'string' ||
    !(QUERY_NAMES as readonly string[]).includes(query)
  ) {
    return errorResult(
      `Unknown query: ${String(query)}. Valid queries: ${QUERY_NAMES.join(', ')}`,
    );
  }
  const queryName = query as QueryName;
  const args = (rawArgs?.args ?? {}) as QueryArgMap[QueryName];
  const missing = REQUIRED_ARGS[queryName].filter(
    (key) => (args as Record<string, unknown>)[key] === undefined,
  );
  if (missing.length > 0) {
    return errorResult(
      `Query '${queryName}' requires args: ${missing.join(', ')}. Run the CLI with no arguments for the full catalogue.`,
    );
  }
  return queue.enqueue(async () => {
    const response = await warmDispatch(getState(), queryName, args);
    return textResult(response);
  });
}

async function main(): Promise<void> {
  if (process.argv.includes('--corpus-info')) {
    const warm = createWarmState({ repoRoot });
    console.log(JSON.stringify(corpusInfo(warm), null, 2));
    return;
  }

  const server = new Server(
    { name: 'ast-dataflow', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...TOOLS],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    try {
      if (name === 'ast_dataflow') {
        return await handleAstDataflow(rawArgs);
      }
      if (name === 'corpus_info') {
        return await queue.enqueue(async () => {
          const warm = getState();
          const meta = sweepStaleness(warm);
          return textResult({ ...corpusInfo(warm), meta });
        });
      }
      return errorResult(`Unknown tool: ${name}`);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout carries JSON-RPC only — all logging goes to stderr.
  console.error(`ast-dataflow MCP server ready (repoRoot: ${repoRoot})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});

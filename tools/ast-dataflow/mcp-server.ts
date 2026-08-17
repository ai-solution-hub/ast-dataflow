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
import { mcpPathPolicy } from './path-policy';
import {
  createSerialQueue,
  createWarmState,
  sweepStaleness,
  warmDispatch,
} from './staleness';
import type { WarmState } from './staleness';

const repoRoot = process.cwd();

/**
 * Caller-supplied file paths are confined to the repo root on this surface
 * (issue #1): the caller is a model, not the operator holding the shell. An
 * operator who needs the server to read a sidecar written elsewhere — e.g.
 * an evidence sidecar a producer wrote under $TMPDIR — opts in by spawning
 * the server with AST_DATAFLOW_ALLOWED_ROOTS set. Fixed at spawn, so no
 * request can widen it. The CLI is unconfined and remains the unrestricted
 * path.
 */
const pathPolicy = mcpPathPolicy(
  repoRoot,
  process.env.AST_DATAFLOW_ALLOWED_ROOTS,
);

/** Built lazily on the first tool call — construction costs ~5 s on the full
 *  corpus and the server must come up fast enough for the MCP handshake. */
let state: WarmState | undefined;

function getState(): WarmState {
  state ??= createWarmState({ repoRoot, pathPolicy });
  return state;
}

/** All tool work funnels through one promise chain: ts-morph is
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
      "(e.g. callers/callees/references: {symbol: 'lib/db.ts:getClient'}; importers: {modulePath}; " +
      'column-reads/column-writes: {table, column}; type-evolution: {type, property}; enum-uses: {enum, member?}; ' +
      'string-literal-uses: {value}; fixture-uses: {needle}; reexport-chain: {symbol, from?}; ' +
      'flow-trace: {originFile, originLine, originColumn}; plus optional limit/excludeTests/scope where the CLI accepts them). ' +
      'Every response carries caveats: {scan, searched, invisibleSurfaces, corpus, summaryBasis, narrowing?, schemaValidation?} ' +
      'plus a summary histogram — read them before treating a zero as absence. `searched` lists the AST shapes actually matched, ' +
      '`invisibleSurfaces` what the scan structurally cannot see, and `corpus` the file count and tsconfig the answer covers. ' +
      'On column-reads/column-writes, schemaValidation.validated:false means the table and column were never checked to exist. ' +
      'When truncated is true, caveats.narrowing names the filters that would narrow the query and the limit that would show the rest. ' +
      'Responses also add meta: {refreshedFiles, addedFiles, removedFiles, staleFiles} — the per-call staleness sweep; ' +
      'a non-empty staleFiles means those files could not be refreshed and answers may be stale for them. ' +
      'Arguments naming files to read (schema-coverage evidence, dead-exports symbolsFile, fixture-uses scope) are confined ' +
      "to this server's allowed roots — the repo root unless the operator widened it at spawn; a path outside them returns " +
      "error.kind 'path_not_allowed' and reads nothing. The CLI is unconfined if a path outside the repo is genuinely needed.",
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
  console.error(
    `ast-dataflow MCP server ready (repoRoot: ${repoRoot}; ` +
      `path roots: ${pathPolicy.allowedRoots.join(', ')})`,
  );
}

main().catch((err) => {
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exit(1);
});

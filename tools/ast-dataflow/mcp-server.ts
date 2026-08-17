#!/usr/bin/env bun
/**
 * Warm MCP stdio server for the ast-dataflow query catalogue (fixCache.md
 * Stage 1). Holds the ts-morph Project in memory across tool calls so
 * repeat queries cost 0.08–2.1 s instead of the ~5 s per-invocation Project
 * rebuild the CLI pays. One server per Claude Code session (client-owned
 * subprocess, spawned on stdio) — the CLI remains the always-available cold
 * path, so nothing ever blocks on a shared daemon (inv 21).
 *
 * Registration is `McpServer` + `registerTool` (issue #2, audit HIGH-3):
 * the SDK validates every call against the strict Zod schemas in
 * mcp-schemas.ts before any handler runs, advertises the input/output
 * schemas and read-only annotations in `tools/list`, and rejects unknown
 * tools and malformed arguments itself. The handlers only ever see
 * arguments that already passed the per-query strict schema.
 *
 * Run: bun run ast-dataflow-mcp            (stdio server, from repo root)
 *      bun run ast-dataflow-mcp --corpus-info   (print corpus stats and exit)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import packageJson from '../../package.json';
import type { QueryArgMap, QueryName } from './dispatch';
import {
  AST_DATAFLOW_INPUT,
  AST_DATAFLOW_OUTPUT,
  CORPUS_INFO_OUTPUT,
  NO_ARGS_INPUT,
} from './mcp-schemas';
import { mcpPathPolicy } from './path-policy';
import type { PathPolicy } from './path-policy';
import {
  createSerialQueue,
  createWarmState,
  sweepStaleness,
  warmDispatch,
} from './staleness';
import type { WarmState } from './staleness';

/**
 * Every query is read-only: the two write modes in the catalogue
 * (type-drift-detect --ci / --update-baseline report and baseline files)
 * live in cli.ts, not in the query functions, and their flags are rejected
 * by the MCP schemas. Without an explicit annotation `destructiveHint`
 * defaults to TRUE, so these read-only tools rendered as destructive
 * (audit MEDIUM-5).
 */
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const AST_DATAFLOW_DESCRIPTION = `Run one ast-dataflow query against a warm, type-checked ts-morph view of the repo. Same catalogue and JSON envelope as \`bun run ast-dataflow <query>\`, at warm-process speed.

Args:
- query: the query to run — callers, callees, importers, references, column-reads, column-writes, type-evolution, dead-exports, reexport-chain, enum-uses, string-literal-uses, fixture-uses, flow-trace, type-drift-detect, schema-coverage.
- args: camelCase mirror of that query's CLI flags, validated strictly (unknown keys are rejected, never ignored). Required per query: callers/callees/references/reexport-chain {symbol: '<file>:<name>'}; importers {modulePath}; column-reads/column-writes {table, column}; type-evolution {type, property}; enum-uses {enum}; string-literal-uses {value}; fixture-uses {needle}; flow-trace {originFile, originLine, originColumn}. dead-exports, type-drift-detect and schema-coverage require none. Optional where the CLI accepts them: limit, scope (comma-separated globs), excludeTests, kind, kinds, member, file, from, includeExternal, maxDepth, interFunction, interfacePattern, table, column, evidence.

Returns: the uniform JSON envelope (also as structuredContent): {query, args, results, truncated, totalEstimated?, durationMs, summary?, caveats, error?, meta}. caveats: {scan, searched, invisibleSurfaces, corpus, summaryBasis, narrowing?, schemaValidation?} plus a summary histogram — read them before treating a zero as absence. \`searched\` lists the AST shapes actually matched, \`invisibleSurfaces\` what the scan structurally cannot see, and \`corpus\` the file count, tsconfig and any scope the answer covers. On column-reads/column-writes, schemaValidation.validated:false means the table and column were never checked to exist. When truncated is true, caveats.narrowing names the filters that would narrow the query and the limit that would show the rest. meta is the per-call staleness sweep; a non-empty meta.staleFiles means those files could not be refreshed and answers may be stale for them.

Examples:
- {"query": "callers", "args": {"symbol": "lib/db.ts:getClient"}}
- {"query": "column-reads", "args": {"table": "users", "column": "email"}}
- {"query": "dead-exports", "args": {"scope": "lib/**", "excludeTests": true}}

Error Handling: a call that fails validation (unknown query, unknown or malformed argument) is rejected with isError and a message naming the offending key and the valid keys for that query. A query that runs but cannot answer returns the envelope with a structured error {kind, message, hint} and isError — kinds include unknown_file, parse_error, ambiguous_symbol, out_of_corpus, not_callable, unknown_table, unknown_column, path_not_allowed. Arguments naming files to read (schema-coverage evidence, dead-exports symbolsFile, fixture-uses scope) are confined to this server's allowed roots — the repo root unless the operator widened it at spawn; a path outside them returns error.kind 'path_not_allowed' and reads nothing. The type-drift-detect flags ci, updateBaseline, json and pretty are CLI-only presentation/baseline modes and are rejected over MCP. The CLI is unconfined if a path outside the repo is genuinely needed.`;

export interface CreateMcpServerOptions {
  /** The repo the corpus is built from; fixed for the server's lifetime. */
  repoRoot: string;
  /**
   * Raw AST_DATAFLOW_ALLOWED_ROOTS value, read once at spawn (issue #1) —
   * no request can widen it.
   */
  allowedRoots?: string | undefined;
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

/**
 * Build the MCP server: tool registration, path policy, warm state and the
 * serial queue, without binding a transport — main() connects stdio, tests
 * connect an in-memory pair. One warm state per server instance.
 */
export function createMcpServer(opts: CreateMcpServerOptions): {
  server: McpServer;
  pathPolicy: PathPolicy;
} {
  const { repoRoot } = opts;

  /**
   * Caller-supplied file paths are confined to the repo root on this surface
   * (issue #1): the caller is a model, not the operator holding the shell.
   * An operator who needs the server to read a sidecar written elsewhere —
   * e.g. an evidence sidecar a producer wrote under $TMPDIR — opts in by
   * spawning the server with AST_DATAFLOW_ALLOWED_ROOTS set. Fixed at
   * spawn, so no request can widen it. The CLI is unconfined and remains
   * the unrestricted path.
   */
  const pathPolicy = mcpPathPolicy(repoRoot, opts.allowedRoots);

  /** Built lazily on the first tool call — construction costs ~5 s on the
   *  full corpus and the server must come up fast enough for the MCP
   *  handshake. */
  let state: WarmState | undefined;

  function getState(): WarmState {
    state ??= createWarmState({ repoRoot, pathPolicy });
    return state;
  }

  /** All tool work funnels through one promise chain: ts-morph is
   *  single-threaded, so overlapping tools/call requests run in order. */
  const queue = createSerialQueue();

  const server = new McpServer({
    name: 'ast-dataflow',
    version: packageJson.version,
  });

  server.registerTool(
    'ast_dataflow',
    {
      title: 'ast-dataflow query',
      description: AST_DATAFLOW_DESCRIPTION,
      inputSchema: AST_DATAFLOW_INPUT,
      outputSchema: AST_DATAFLOW_OUTPUT,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ query, args }) => {
      // Both levels are already validated: the SDK parsed {query, args}
      // against AST_DATAFLOW_INPUT, whose refinement ran the strict
      // per-query schema — so the cast records what the schema proved.
      const queryName = query as QueryName;
      const queryArgs = (args ?? {}) as QueryArgMap[QueryName];
      return queue.enqueue(async (): Promise<CallToolResult> => {
        const response = await warmDispatch(getState(), queryName, queryArgs);
        return {
          content: [{ type: 'text', text: JSON.stringify(response) }],
          structuredContent: response as unknown as Record<string, unknown>,
          // A structured query failure is an error result (audit MEDIUM-6):
          // isError uniformly whenever the envelope carries `error`, with
          // the envelope kept intact so callers still get {kind, message,
          // hint} — path_not_allowed, unknown_table, … — as documented.
          ...(response.error ? { isError: true } : {}),
        };
      });
    },
  );

  server.registerTool(
    'corpus_info',
    {
      title: 'ast-dataflow corpus info',
      description:
        'Report the warm corpus: resolved source-file count and the tsconfig path driving file enumeration. ' +
        'Args: none. Returns {fileCount, tsconfigPath, meta} (also as structuredContent), where meta is the per-call staleness sweep.',
      inputSchema: NO_ARGS_INPUT,
      outputSchema: CORPUS_INFO_OUTPUT,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () =>
      queue.enqueue(async (): Promise<CallToolResult> => {
        const warm = getState();
        const meta = sweepStaleness(warm);
        const payload = { ...corpusInfo(warm), meta };
        return {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          structuredContent: payload as unknown as Record<string, unknown>,
        };
      }),
  );

  return { server, pathPolicy };
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();

  if (process.argv.includes('--corpus-info')) {
    const warm = createWarmState({ repoRoot });
    console.log(JSON.stringify(corpusInfo(warm), null, 2));
    return;
  }

  const { server, pathPolicy } = createMcpServer({
    repoRoot,
    allowedRoots: process.env.AST_DATAFLOW_ALLOWED_ROOTS,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout carries JSON-RPC only — all logging goes to stderr.
  console.error(
    `ast-dataflow MCP server ready (repoRoot: ${repoRoot}; ` +
      `path roots: ${pathPolicy.allowedRoots.join(', ')})`,
  );
}

// Bun sets import.meta.main for the entry module; under a test runner the
// module is imported for createMcpServer and must not seize stdio.
if (import.meta.main) {
  main().catch((err) => {
    console.error(
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
    process.exit(1);
  });
}

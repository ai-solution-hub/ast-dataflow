/**
 * MCP surface — registerTool migration (issue #2, audit HIGH-2/HIGH-3,
 * MEDIUM-4/5/6).
 *
 * These tests drive the REAL server object over a linked in-memory
 * client/server transport pair, so what is asserted is the wire behaviour a
 * caller observes: what tools/list advertises, what a malformed call gets
 * back, and what a valid call carries. Only stdio framing is out of frame
 * here (unchanged by the migration; broader MCP coverage is issue #3).
 *
 * The load-bearing change under test: unknown or misspelled arguments were
 * silently accepted, ignored, and echoed back as if honoured (audit HIGH-2,
 * measured with `excludeTests` on callers and `limmit: 1`); they are now
 * rejected before any query code runs, with a message naming the valid keys.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QUERY_NAMES } from '@/tools/ast-dataflow/dispatch';
import type { QueryName } from '@/tools/ast-dataflow/dispatch';
import { AST_DATAFLOW_INPUT } from '@/tools/ast-dataflow/mcp-schemas';
import { createMcpServer } from '@/tools/ast-dataflow/mcp-server';

const FIXTURE_ROOT = resolve(__dirname, 'fixtures', '09-dead-exports');

interface TextContent {
  type: 'text';
  text: string;
}

/** The envelope fields these tests read from structuredContent. */
interface EnvelopeView {
  query: string;
  args: Record<string, unknown>;
  results: Array<{ file: string; symbol: string }>;
  truncated: boolean;
  caveats?: {
    corpus: { fileCount: number; scope?: string };
    narrowing?: string[];
  };
  error?: { kind: string; message: string; hint?: string };
  meta?: { staleFiles: string[] };
}

async function connect(repoRoot: string): Promise<{
  client: Client;
  server: McpServer;
  close: () => Promise<void>;
}> {
  const { server } = createMcpServer({ repoRoot });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'mcp-surface-test', version: '0.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    server,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** callTool returns a union with the legacy `toolResult` shape; this suite
 *  always talks current-protocol, so pin the modern result type once. */
async function callTool(
  client: Client,
  params: { name: string; arguments: Record<string, unknown> },
): Promise<CallToolResult> {
  return (await client.callTool(params)) as CallToolResult;
}

function firstText(result: CallToolResult): string {
  const content = result.content as TextContent[];
  expect(content[0]?.type).toBe('text');
  return content[0].text;
}

// ---------------------------------------------------------------------------
// Strict schemas — every query has a wire contract (HIGH-2's root fix)
// ---------------------------------------------------------------------------

/**
 * Minimal valid args per query — doubles as the required-argument register
 * the old REQUIRED_ARGS table carried. Keyed by QueryName so a new query
 * cannot ship without documenting its minimal call here.
 */
const MINIMAL_ARGS: Record<QueryName, Record<string, unknown>> = {
  callers: { symbol: 'a.ts:x' },
  callees: { symbol: 'a.ts:x' },
  importers: { modulePath: 'lib/a' },
  references: { symbol: 'a.ts:x' },
  'column-reads': { table: 't', column: 'c' },
  'column-writes': { table: 't', column: 'c' },
  'type-evolution': { type: 'T', property: 'p' },
  'dead-exports': {},
  'reexport-chain': { symbol: 'x' },
  'enum-uses': { enum: 'E' },
  'string-literal-uses': { value: 'v' },
  'fixture-uses': { needle: 'n' },
  'flow-trace': { originFile: 'a.ts', originLine: 1, originColumn: 1 },
  'type-drift-detect': {},
  'schema-coverage': {},
};

describe('mcp-schemas — strict per-query argument validation', () => {
  it('accepts the minimal valid call for every query in the catalogue', () => {
    for (const query of QUERY_NAMES) {
      const parsed = AST_DATAFLOW_INPUT.safeParse({
        query,
        args: MINIMAL_ARGS[query],
      });
      expect(parsed.success, `query '${query}' minimal args`).toBe(true);
    }
  });

  it('rejects an unknown argument on every query in the catalogue', () => {
    for (const query of QUERY_NAMES) {
      const parsed = AST_DATAFLOW_INPUT.safeParse({
        query,
        args: { ...MINIMAL_ARGS[query], definitelyNotAnArg: 1 },
      });
      expect(parsed.success, `query '${query}' unknown arg`).toBe(false);
    }
  });

  it("names the misspelled key and the valid keys (audit's measured 'limmit' case)", () => {
    const parsed = AST_DATAFLOW_INPUT.safeParse({
      query: 'callers',
      args: { symbol: 'a.ts:x', limmit: 1 },
    });
    expect(parsed.success).toBe(false);
    const messages = parsed.success
      ? ''
      : parsed.error.issues.map((i) => i.message).join(' ');
    expect(messages).toContain("'limmit'");
    expect(messages).toContain('Valid arguments: symbol, limit, scope');
  });

  it("rejects a real flag of ANOTHER query (audit's measured excludeTests-on-callers case)", () => {
    const parsed = AST_DATAFLOW_INPUT.safeParse({
      query: 'callers',
      args: { symbol: 'a.ts:x', excludeTests: true },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects the CLI-only type-drift-detect flags and says why (UNDECIDABLE-2)', () => {
    for (const flag of ['ci', 'updateBaseline', 'json', 'pretty']) {
      const parsed = AST_DATAFLOW_INPUT.safeParse({
        query: 'type-drift-detect',
        args: { [flag]: true },
      });
      expect(parsed.success, `flag '${flag}'`).toBe(false);
      const messages = parsed.success
        ? ''
        : parsed.error.issues.map((i) => i.message).join(' ');
      expect(messages).toContain('CLI presentation/baseline modes');
    }
  });
});

// ---------------------------------------------------------------------------
// tools/list — what the server advertises (MEDIUM-4/5, MEDIUM-10)
// ---------------------------------------------------------------------------

describe('MCP surface — tool listing', () => {
  it(
    'advertises both tools with read-only annotations, a strict input schema and an output schema',
    { timeout: 30_000 },
    async () => {
      const { client, close } = await connect(FIXTURE_ROOT);
      try {
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual([
          'ast_dataflow',
          'corpus_info',
        ]);

        for (const tool of tools) {
          expect(tool.annotations).toMatchObject({
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          });
          expect(tool.outputSchema).toBeDefined();
          expect(tool.title).toBeDefined();
        }

        const astDataflow = tools.find((t) => t.name === 'ast_dataflow');
        const inputSchema = astDataflow?.inputSchema as unknown as {
          properties: { query: { enum: string[] } };
          required: string[];
          additionalProperties: boolean;
        };
        // The full catalogue is in the advertised enum, and unknown
        // top-level keys are refused by the schema itself.
        expect(inputSchema.properties.query.enum).toEqual([...QUERY_NAMES]);
        expect(inputSchema.required).toEqual(['query']);
        expect(inputSchema.additionalProperties).toBe(false);
        // The description follows the Args/Returns/Examples/Error-Handling
        // template (audit MEDIUM-10).
        for (const section of [
          'Args:',
          'Returns:',
          'Examples:',
          'Error Handling:',
        ]) {
          expect(astDataflow?.description).toContain(section);
        }
      } finally {
        await close();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// tools/call — rejection happens before any query code runs
// ---------------------------------------------------------------------------

describe('MCP surface — argument rejection', () => {
  // Rejection precedes the handler, so none of these builds the corpus:
  // one connection serves them all and stays fast.
  let harness: Awaited<ReturnType<typeof connect>>;

  beforeAll(async () => {
    harness = await connect(FIXTURE_ROOT);
  });

  afterAll(async () => {
    await harness.close();
  });

  it('rejects a misspelled argument as isError, naming it and the valid keys', async () => {
    const result = await callTool(harness.client, {
      name: 'ast_dataflow',
      arguments: { query: 'callers', args: { symbol: 'a.ts:x', limmit: 1 } },
    });
    expect(result.isError).toBe(true);
    const text = firstText(result);
    expect(text).toContain("'limmit'");
    expect(text).toContain('Valid arguments: symbol, limit, scope');
  });

  it('rejects a missing required argument as isError, naming the path', async () => {
    const result = await callTool(harness.client, {
      name: 'ast_dataflow',
      arguments: { query: 'callers', args: {} },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('args.symbol');
  });

  it('rejects an unknown query as isError, listing the catalogue', async () => {
    const result = await callTool(harness.client, {
      name: 'ast_dataflow',
      arguments: { query: 'calers', args: {} },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('"callers"');
  });

  it('rejects an unknown top-level key as isError', async () => {
    const result = await callTool(harness.client, {
      name: 'ast_dataflow',
      arguments: {
        query: 'callers',
        args: { symbol: 'a.ts:x' },
        bogus: true,
      },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('bogus');
  });

  it('rejects the CLI-only type-drift-detect flags as isError', async () => {
    const result = await callTool(harness.client, {
      name: 'ast_dataflow',
      arguments: { query: 'type-drift-detect', args: { ci: true } },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('CLI presentation/baseline modes');
  });

  it('rejects arguments on corpus_info as isError', async () => {
    const result = await callTool(harness.client, {
      name: 'corpus_info',
      arguments: { verbose: true },
    });
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tools/call — valid calls: envelope, structured content, isError-on-error
// ---------------------------------------------------------------------------

describe('MCP surface — query execution', () => {
  let harness: Awaited<ReturnType<typeof connect>>;
  let outsideDir: string;

  beforeAll(async () => {
    harness = await connect(FIXTURE_ROOT);
    outsideDir = mkdtempSync(join(tmpdir(), 'ast-dataflow-mcp-test-'));
  });

  afterAll(async () => {
    await harness.close();
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it(
    'dead-exports honours scope over MCP and the envelope records it',
    { timeout: 30_000 },
    async () => {
      const result = await callTool(harness.client, {
        name: 'ast_dataflow',
        arguments: {
          query: 'dead-exports',
          args: { scope: 'definitely-unused.ts' },
        },
      });
      expect(result.isError).toBeFalsy();
      const envelope = result.structuredContent as unknown as EnvelopeView;
      // The scan narrowed to the one in-scope file: same-file-only.ts's
      // dead export (visible in an unscoped run) is absent.
      expect(envelope.results.map((r) => r.symbol)).toEqual(['unusedHelper']);
      expect(
        envelope.results.every((r) => r.file === 'definitely-unused.ts'),
      ).toBe(true);
      expect(envelope.caveats?.corpus.scope).toBe('definitely-unused.ts');
      // structuredContent and the text content carry the same envelope.
      expect(JSON.parse(firstText(result))).toEqual(result.structuredContent);
      expect(envelope.meta).toBeDefined();
    },
  );

  it(
    'a structured query failure is an isError result with the envelope intact',
    { timeout: 30_000 },
    async () => {
      const missing = join(outsideDir, 'missing-symbols.txt');
      const result = await callTool(harness.client, {
        name: 'ast_dataflow',
        arguments: {
          query: 'dead-exports',
          args: { symbolsFile: missing },
        },
      });
      expect(result.isError).toBe(true);
      const envelope = result.structuredContent as unknown as EnvelopeView;
      expect(envelope.error?.kind).toBe('path_not_allowed');
      expect(envelope.results).toEqual([]);
    },
  );

  it(
    'the path_not_allowed refusal is identical whether or not the file exists',
    { timeout: 30_000 },
    async () => {
      const existing = join(outsideDir, 'symbols.txt');
      writeFileSync(existing, 'unusedHelper\n');
      const call = (symbolsFile: string) =>
        callTool(harness.client, {
          name: 'ast_dataflow',
          arguments: { query: 'dead-exports', args: { symbolsFile } },
        });
      const forExisting = await call(existing);
      const forMissing = await call(join(outsideDir, 'no-such-file.txt'));
      expect(forExisting.isError).toBe(true);
      expect(forMissing.isError).toBe(true);
      const errorOf = (r: { structuredContent?: unknown }) => {
        const env = r.structuredContent as unknown as EnvelopeView;
        return {
          ...env.error,
          message: env.error?.message.replace(
            /Path '[^']*'/,
            "Path '<supplied>'",
          ),
        };
      };
      // Same kind, same hint, same message tail after the (different)
      // supplied path — nothing observable depends on what is on disk.
      expect(errorOf(forExisting)).toEqual(errorOf(forMissing));
    },
  );

  it(
    'corpus_info returns the corpus and the staleness sweep as structured content',
    { timeout: 30_000 },
    async () => {
      const result = await callTool(harness.client, {
        name: 'corpus_info',
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      const payload = result.structuredContent as unknown as {
        fileCount: number;
        tsconfigPath: string;
        meta: { staleFiles: string[] };
      };
      expect(payload.fileCount).toBeGreaterThan(0);
      expect(payload.tsconfigPath).toContain('tsconfig.json');
      expect(payload.meta.staleFiles).toEqual([]);
      expect(JSON.parse(firstText(result))).toEqual(result.structuredContent);
    },
  );
});

import type { Project } from 'ts-morph';
import { callees } from './queries/callees';
import { callers } from './queries/callers';
import { columnReads } from './queries/column-reads';
import { columnWrites } from './queries/column-writes';
import { deadExports } from './queries/dead-exports';
import { enumUses } from './queries/enum-uses';
import { fixtureUses } from './queries/fixture-uses';
import { flowTrace } from './queries/flow-trace';
import { importers } from './queries/importers';
import { reexportChain } from './queries/reexport-chain';
import { references } from './queries/references';
import { schemaCoverage } from './queries/schema-coverage';
import { stringLiteralUses } from './queries/string-literal-uses';
import { typeDriftDetect } from './queries/type-drift-detect';
import { typeEvolution } from './queries/type-evolution';
import type {
  CalleesArgs,
  CalleesResponse,
  CallersArgs,
  CallSiteResult,
  ColumnReadResult,
  ColumnReadsArgs,
  ColumnWriteResult,
  ColumnWritesArgs,
  DeadExportResult,
  DeadExportsArgs,
  EnumUseResult,
  EnumUsesArgs,
  FixtureUseResult,
  FixtureUsesArgs,
  FlowTraceArgs,
  FlowTraceRow,
  ImporterResult,
  ImportersArgs,
  QueryResponse,
  ReexportChainArgs,
  ReexportChainResult,
  ReferenceResult,
  ReferencesArgs,
  SchemaCoverageArgs,
  SchemaCoverageResponse,
  StringLiteralUseResult,
  StringLiteralUsesArgs,
  TypeDriftDetectArgs,
  TypeDriftResult,
  TypeEvolutionArgs,
  TypeEvolutionResult,
} from './types';

/**
 * The full query catalogue, shared by the CLI switch and the MCP server's
 * `ast_dataflow` tool enum so the two surfaces cannot drift (fixCache.md
 * Stage 1: CLI/MCP parity is structural, not by convention).
 */
export const QUERY_NAMES = [
  'callers',
  'callees',
  'importers',
  'references',
  'column-reads',
  'column-writes',
  'type-evolution',
  'dead-exports',
  'reexport-chain',
  'enum-uses',
  'string-literal-uses',
  'fixture-uses',
  'flow-trace',
  'type-drift-detect',
  'schema-coverage',
] as const;

export type QueryName = (typeof QUERY_NAMES)[number];

export interface QueryArgMap {
  callers: CallersArgs;
  callees: CalleesArgs;
  importers: ImportersArgs;
  references: ReferencesArgs;
  'column-reads': ColumnReadsArgs;
  'column-writes': ColumnWritesArgs;
  'type-evolution': TypeEvolutionArgs;
  'dead-exports': DeadExportsArgs;
  'reexport-chain': ReexportChainArgs;
  'enum-uses': EnumUsesArgs;
  'string-literal-uses': StringLiteralUsesArgs;
  'fixture-uses': FixtureUsesArgs;
  'flow-trace': FlowTraceArgs;
  'type-drift-detect': TypeDriftDetectArgs;
  'schema-coverage': SchemaCoverageArgs;
}

export interface QueryResponseMap {
  callers: QueryResponse<CallSiteResult>;
  callees: CalleesResponse;
  importers: QueryResponse<ImporterResult>;
  references: QueryResponse<ReferenceResult>;
  'column-reads': QueryResponse<ColumnReadResult>;
  'column-writes': QueryResponse<ColumnWriteResult>;
  'type-evolution': QueryResponse<TypeEvolutionResult>;
  'dead-exports': QueryResponse<DeadExportResult>;
  'reexport-chain': QueryResponse<ReexportChainResult>;
  'enum-uses': QueryResponse<EnumUseResult>;
  'string-literal-uses': QueryResponse<StringLiteralUseResult>;
  'fixture-uses': QueryResponse<FixtureUseResult>;
  'flow-trace': QueryResponse<FlowTraceRow>;
  'type-drift-detect': QueryResponse<TypeDriftResult> & {
    newSinceBaseline?: string[];
  };
  'schema-coverage': SchemaCoverageResponse;
}

export type DispatchResponse = QueryResponseMap[QueryName];

/**
 * Required argument keys per query, for callers that receive args over a wire
 * (the MCP server) rather than through the CLI's per-flag validation. The CLI
 * keeps its own presence checks so its exit-2 messages stay byte-identical.
 */
export const REQUIRED_ARGS: Record<QueryName, readonly string[]> = {
  callers: ['symbol'],
  callees: ['symbol'],
  importers: ['modulePath'],
  references: ['symbol'],
  'column-reads': ['table', 'column'],
  'column-writes': ['table', 'column'],
  'type-evolution': ['type', 'property'],
  'dead-exports': [],
  'reexport-chain': ['symbol'],
  'enum-uses': ['enum'],
  'string-literal-uses': ['value'],
  'fixture-uses': ['needle'],
  'flow-trace': ['originFile', 'originLine', 'originColumn'],
  'type-drift-detect': [],
  'schema-coverage': [],
};

async function dispatchInner(
  query: QueryName,
  args: QueryArgMap[QueryName],
  project: Project,
  repoRoot: string,
): Promise<DispatchResponse> {
  switch (query) {
    case 'callers':
      return callers(args as CallersArgs, project, repoRoot);
    case 'callees':
      return callees(args as CalleesArgs, project, repoRoot);
    case 'importers':
      return importers(args as ImportersArgs, project, repoRoot);
    case 'references':
      return references(args as ReferencesArgs, project, repoRoot);
    case 'column-reads':
      return columnReads(args as ColumnReadsArgs, project, repoRoot);
    case 'column-writes':
      return columnWrites(args as ColumnWritesArgs, project, repoRoot);
    case 'type-evolution':
      return typeEvolution(args as TypeEvolutionArgs, project, repoRoot);
    case 'dead-exports':
      return deadExports(args as DeadExportsArgs, project, repoRoot);
    case 'reexport-chain':
      return reexportChain(args as ReexportChainArgs, project, repoRoot);
    case 'enum-uses':
      return enumUses(args as EnumUsesArgs, project, repoRoot);
    case 'string-literal-uses':
      return stringLiteralUses(
        args as StringLiteralUsesArgs,
        project,
        repoRoot,
      );
    case 'fixture-uses':
      return fixtureUses(args as FixtureUsesArgs, project, repoRoot);
    case 'flow-trace':
      return flowTrace(args as FlowTraceArgs, project, repoRoot);
    case 'type-drift-detect':
      return typeDriftDetect(args as TypeDriftDetectArgs, project, repoRoot);
    case 'schema-coverage':
      return schemaCoverage(args as SchemaCoverageArgs, project, repoRoot);
    default: {
      const exhaustive: never = query;
      throw new Error(`Unknown query: ${String(exhaustive)}`);
    }
  }
}

/**
 * Route one query invocation to its implementation. Args arrive already
 * parsed (the CLI keeps its flag parsing; the MCP server passes the tool
 * call's `args` object straight through) — dispatch owns only the
 * query-name → query-function mapping.
 */
export async function dispatch<Q extends QueryName>(
  query: Q,
  args: QueryArgMap[Q],
  project: Project,
  repoRoot: string,
): Promise<QueryResponseMap[Q]> {
  return (await dispatchInner(
    query,
    args,
    project,
    repoRoot,
  )) as QueryResponseMap[Q];
}

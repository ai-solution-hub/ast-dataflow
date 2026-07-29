import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  schemaCoverage,
  createProject,
  renderSchemaCoverageReport,
} from '@/tools/ast-dataflow';

const FIXTURE_DIR = resolve(__dirname, 'fixtures', '21-schema-coverage');
const CLI_PATH = resolve(__dirname, '..', 'cli.ts');

function makeProject() {
  return createProject({
    tsConfigFilePath: resolve(FIXTURE_DIR, 'tsconfig.json'),
    repoRoot: FIXTURE_DIR,
  });
}

async function runCoverage(
  args: Parameters<typeof schemaCoverage>[0] = {},
): Promise<Awaited<ReturnType<typeof schemaCoverage>>> {
  const { project, repoRoot } = makeProject();
  return schemaCoverage(args, project, repoRoot);
}

function row(
  response: Awaited<ReturnType<typeof schemaCoverage>>,
  table: string,
  column: string,
) {
  return response.results.find((r) => r.table === table && r.column === column);
}

describe('schema-coverage — per-column verdicts', () => {
  it('reports a column with exact read AND exact write evidence as wired', async () => {
    const response = await runCoverage();
    expect(row(response, 'bid_projects', 'id')).toMatchObject({
      verdict: 'wired',
      exactReads: 2, // select + eq on the same chain
      exactWrites: 1,
      wildcardReads: 0,
      indirectReads: 0,
      indirectWrites: 0,
      evidence: {
        reads: ['wired-clean.ts:29'],
        writes: ['wired-clean.ts:38'],
      },
    });
  });

  it('reports a column that is only ever read as read-only', async () => {
    const response = await runCoverage();
    expect(row(response, 'bid_projects', 'title')).toMatchObject({
      verdict: 'read-only',
      exactReads: 1,
      exactWrites: 0,
      evidence: { reads: ['wired-clean.ts:29'], writes: [] },
    });
  });

  it('reports a column that is only ever written as write-only', async () => {
    const response = await runCoverage();
    expect(row(response, 'bid_projects', 'owner_id')).toMatchObject({
      verdict: 'write-only',
      exactReads: 0,
      exactWrites: 1,
      evidence: { reads: [], writes: ['wired-clean.ts:38'] },
    });
  });

  it('reports a zero-evidence column on a smoke-free table as unwired', async () => {
    const response = await runCoverage();
    expect(row(response, 'bid_projects', 'budget_gbp')).toMatchObject({
      verdict: 'unwired',
      exactReads: 0,
      exactWrites: 0,
      wildcardReads: 0,
      indirectReads: 0,
      indirectWrites: 0,
      unattributableTableSites: 0,
      evidence: { reads: [], writes: [] },
    });
  });

  it('emits exactly one verdict row per schema column', async () => {
    const response = await runCoverage();
    // 3 tables × 4 Row columns in the miniature schema.
    expect(response.results).toHaveLength(12);
    const keys = response.results.map((r) => `${r.table}.${r.column}`);
    expect(new Set(keys).size).toBe(12);
  });
});

describe('schema-coverage — wildcard/indirect never count as wiring', () => {
  it('downgrades a wildcard-only column to undecidable', async () => {
    const response = await runCoverage();
    expect(row(response, 'feed_articles', 'id')).toMatchObject({
      verdict: 'undecidable',
      wildcardReads: 1,
      exactReads: 0,
      exactWrites: 0,
      evidence: { reads: ['wildcard-poisoned.ts:32'], writes: [] },
    });
  });

  it('keeps a column with only wildcard reads + an untyped indirect write undecidable', async () => {
    const response = await runCoverage();
    expect(row(response, 'feed_articles', 'retention_class')).toMatchObject({
      verdict: 'undecidable',
      wildcardReads: 1,
      indirectWrites: 1,
      exactReads: 0,
      exactWrites: 0,
      evidence: {
        reads: ['wildcard-poisoned.ts:32'],
        writes: ['wildcard-poisoned.ts:50'],
      },
    });
  });

  it('never upgrades one-sided exact evidence to wired via table wildcard smoke', async () => {
    const response = await runCoverage();
    expect(row(response, 'feed_articles', 'headline')).toMatchObject({
      verdict: 'read-only',
      exactReads: 1,
      wildcardReads: 1,
    });
    expect(row(response, 'feed_articles', 'extraction_method')).toMatchObject({
      verdict: 'write-only',
      exactWrites: 1,
      wildcardReads: 1,
    });
  });

  it('lists exact-confidence evidence refs before wildcard refs', async () => {
    const response = await runCoverage();
    // headline: exact select at line 37, wildcard select at line 32.
    expect(row(response, 'feed_articles', 'headline')?.evidence.reads).toEqual([
      'wildcard-poisoned.ts:37',
      'wildcard-poisoned.ts:32',
    ]);
  });
});

describe('schema-coverage — .from(CONST) one-hop attribution', () => {
  it('proves wiring through a literal-typed const table argument', async () => {
    const response = await runCoverage();
    // The baseline audit false negative: signup_policy.allowed_domain is only
    // reached via .from(SIGNUP_POLICY_TABLE).
    expect(row(response, 'signup_policy', 'allowed_domain')).toMatchObject({
      verdict: 'wired',
      exactReads: 1,
      exactWrites: 1,
      evidence: {
        reads: ['const-table.ts:38'],
        writes: ['const-table.ts:46'],
      },
    });
  });
});

describe('schema-coverage — dynamic .from() sites', () => {
  it('downgrades untouched columns of a table with a type-bounded dynamic site to undecidable', async () => {
    const response = await runCoverage();
    // .from(policyTable()) produces no rows, but its return type bounds the
    // smoke to signup_policy — untouched columns must not read as unwired.
    for (const column of ['enforced', 'id', 'updated_at']) {
      expect(row(response, 'signup_policy', column)).toMatchObject({
        verdict: 'undecidable',
        exactReads: 0,
        exactWrites: 0,
        wildcardReads: 0,
        indirectReads: 0,
        indirectWrites: 0,
        unattributableTableSites: 1,
      });
    }
  });

  it('counts a widened-string dynamic site per file in caveats without poisoning other tables', async () => {
    const response = await runCoverage();
    // Exactly the string-typed dynamic site — the Array.from(iterable) decoy
    // in the same file is not a table query and must not be counted.
    expect(response.caveats?.unattributableSites).toEqual({
      'unattributable-global.ts': 1,
    });
    // The globally-unattributable site must not flip the clean table's
    // verdict — budget_gbp stays unwired.
    expect(row(response, 'bid_projects', 'budget_gbp')?.verdict).toBe(
      'unwired',
    );
  });

  it('declares the TS-only scan blindness as static caveats', async () => {
    const response = await runCoverage();
    expect(response.caveats?.scan).toContain(
      'TypeScript query-chain evidence only',
    );
    expect(response.caveats?.invisibleSurfaces).toHaveLength(4);
    expect(response.caveats?.invisibleSurfaces).toContain(
      'RPC function bodies (SQL)',
    );
  });
});

describe('schema-coverage — scoping', () => {
  it('scopes the report to one table via args.table', async () => {
    const response = await runCoverage({ table: 'bid_projects' });
    expect(response.results).toHaveLength(4);
    for (const r of response.results) {
      expect(r.table).toBe('bid_projects');
    }
  });

  it('scopes the report to one column via args.table + args.column', async () => {
    const response = await runCoverage({
      table: 'signup_policy',
      column: 'allowed_domain',
    });
    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({
      table: 'signup_policy',
      column: 'allowed_domain',
      verdict: 'wired',
    });
  });

  it('restricts the corpus scan (not the schema) via a scope glob', async () => {
    const response = await runCoverage({ scope: 'wired-clean.ts' });
    // All 12 schema columns still get verdicts…
    expect(response.results).toHaveLength(12);
    // …but with the poisoning files out of scope, the smoke disappears.
    expect(row(response, 'feed_articles', 'retention_class')?.verdict).toBe(
      'unwired',
    );
    expect(row(response, 'signup_policy', 'enforced')?.verdict).toBe('unwired');
    expect(response.caveats?.unattributableSites).toEqual({});
  });
});

describe('schema-coverage — ordering + envelope', () => {
  it('orders rows worst-first: unwired, undecidable, write-only, read-only, wired', async () => {
    const response = await runCoverage();
    expect(response.results.map((r) => `${r.table}.${r.column}`)).toEqual([
      'bid_projects.budget_gbp',
      'feed_articles.id',
      'feed_articles.retention_class',
      'signup_policy.enforced',
      'signup_policy.id',
      'signup_policy.updated_at',
      'bid_projects.owner_id',
      'feed_articles.extraction_method',
      'bid_projects.title',
      'feed_articles.headline',
      'bid_projects.id',
      'signup_policy.allowed_domain',
    ]);
  });

  it('caps rows with a plain limit, keeping the worst-first head intact', async () => {
    const response = await runCoverage({ limit: 3 });
    expect(response.results).toHaveLength(3);
    expect(response.truncated).toBe(true);
    expect(response.totalEstimated).toBe(12);
    expect(response.results[0]).toMatchObject({
      table: 'bid_projects',
      column: 'budget_gbp',
      verdict: 'unwired',
    });
  });

  it('computes the verdict histogram over all rows, unaffected by the limit cap', async () => {
    const capped = await runCoverage({ limit: 3 });
    expect(capped.summary).toEqual({
      unwired: 1,
      undecidable: 5,
      'write-only': 2,
      'read-only': 2,
      wired: 2,
    });
  });
});

describe('schema-coverage — structured errors', () => {
  it('rejects a table that is not in the schema with unknown_table', async () => {
    const response = await runCoverage({ table: 'bid_questions' });
    expect(response.error?.kind).toBe('unknown_table');
    expect(response.results).toEqual([]);
  });

  it('rejects a column that is not in the table with unknown_column', async () => {
    const response = await runCoverage({
      table: 'bid_projects',
      column: 'no_such_column',
    });
    expect(response.error?.kind).toBe('unknown_column');
    expect(response.results).toEqual([]);
  });

  it('rejects a column argument without a table as parse_error', async () => {
    const response = await runCoverage({ column: 'allowed_domain' });
    expect(response.error?.kind).toBe('parse_error');
    expect(response.results).toEqual([]);
  });
});

describe('schema-coverage — external evidence sidecars', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'schema-coverage-evidence-'));

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Write a sidecar to the tmpdir and return its absolute path. */
  function sidecar(name: string, doc: unknown): string {
    const path = join(tmpDir, name);
    writeFileSync(
      path,
      typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2),
    );
    return path;
  }

  /** A contract-v1 row with the boilerplate filled in. */
  function pyRow(over: Record<string, unknown>) {
    return {
      table: 'bid_projects',
      column: 'title',
      direction: 'write',
      confidence: 'exact',
      method: 'declare_row',
      file: 'scripts/pipeline/writer.py',
      line: 12,
      source: 'declarative',
      ...over,
    };
  }

  function pySidecar(
    name: string,
    rows: unknown[],
    source = 'ast-dataflow-py',
  ) {
    return sidecar(name, {
      schemaVersion: 1,
      source,
      // Unknown top-level keys — and unknown keys nested inside them — must be
      // tolerated and ignored, so a producer can enrich its output freely.
      generatedBy: 'tools/ast_dataflow_py',
      caveats: { sqlglot: false, sqlSitesUnresolvedDynamic: 3 },
      rows,
    });
  }

  it('flips a TS read-only column to wired on an exact external write', async () => {
    const path = pySidecar('exact-write.json', [pyRow({})]);
    const response = await runCoverage({ evidence: [path] });
    const title = row(response, 'bid_projects', 'title');
    expect(title).toMatchObject({
      verdict: 'wired',
      exactReads: 1,
      exactWrites: 1,
    });
    expect(title?.evidence.writes).toContain('scripts/pipeline/writer.py:12');
  });

  it('leaves an unwired column undecidable — never write-only — on indirect-only evidence', async () => {
    const path = pySidecar('indirect-write.json', [
      pyRow({
        column: 'budget_gbp',
        confidence: 'indirect',
        method: 'table-schema',
        line: 41,
      }),
    ]);
    const response = await runCoverage({ evidence: [path] });
    expect(row(response, 'bid_projects', 'budget_gbp')).toMatchObject({
      verdict: 'undecidable',
      exactWrites: 0,
      indirectWrites: 1,
      evidence: { reads: [], writes: ['scripts/pipeline/writer.py:41'] },
    });
  });

  it('spreads a table-scoped write row over every column as indirect smoke', async () => {
    const path = pySidecar('star-write.json', [
      pyRow({ column: '*', confidence: 'exact', method: 'dynamic_table' }),
    ]);
    const response = await runCoverage({ evidence: [path] });
    // The row's own 'exact' confidence is discarded: a table-scoped write is
    // smoke, so exact write counts stay exactly as the TS scan left them
    // (insert on wired-clean.ts:38 names id + owner_id only).
    const exactWritesBefore: Record<string, number> = {
      budget_gbp: 0,
      id: 1,
      owner_id: 1,
      title: 0,
    };
    for (const [column, exactWrites] of Object.entries(exactWritesBefore)) {
      const r = row(response, 'bid_projects', column);
      expect(r?.indirectWrites).toBeGreaterThanOrEqual(1);
      expect(r?.exactWrites).toBe(exactWrites);
    }
    // The previously unwired column is now undecidable, not write-only.
    expect(row(response, 'bid_projects', 'budget_gbp')?.verdict).toBe(
      'undecidable',
    );
    // Untouched tables are unaffected.
    expect(row(response, 'feed_articles', 'headline')?.verdict).toBe(
      'read-only',
    );
  });

  it('spreads a table-scoped read row over every column as wildcard reads', async () => {
    const path = pySidecar('star-read.json', [
      pyRow({ column: '*', direction: 'read', method: 'dynamic_table' }),
    ]);
    const response = await runCoverage({ evidence: [path] });
    for (const column of ['budget_gbp', 'id', 'owner_id', 'title']) {
      expect(row(response, 'bid_projects', column)?.wildcardReads).toBe(1);
    }
    expect(row(response, 'bid_projects', 'budget_gbp')?.verdict).toBe(
      'undecidable',
    );
    // Wildcard reads are not wiring evidence — owner_id stays write-only.
    expect(row(response, 'bid_projects', 'owner_id')?.verdict).toBe(
      'write-only',
    );
  });

  it('counts rows naming an unknown table or column in a caveat instead of dropping them', async () => {
    const path = pySidecar('unknown.json', [
      pyRow({ table: 'no_such_table' }),
      pyRow({ table: 'no_such_table', column: 'whatever', line: 13 }),
      pyRow({ column: 'no_such_column', line: 14 }),
    ]);
    const response = await runCoverage({ evidence: [path] });
    expect(response.error).toBeUndefined();
    expect(response.results).toHaveLength(12);
    expect(response.caveats?.evidenceUnknownTables).toEqual({
      'ast-dataflow-py:bid_projects.no_such_column': 1,
      'ast-dataflow-py:no_such_table': 2,
    });
    // A dropped-table row must not silently become wiring evidence anywhere.
    expect(row(response, 'bid_projects', 'title')?.verdict).toBe('read-only');
  });

  it('reports merged sidecars in the caveats and retires the Python invisible surface', async () => {
    const path = pySidecar('caveats.json', [pyRow({})]);
    const response = await runCoverage({ evidence: [path] });
    expect(response.caveats?.scan).toContain('ast-dataflow-py');
    expect(response.caveats?.scan).toContain('external evidence sidecars');
    expect(response.caveats?.invisibleSurfaces).toHaveLength(3);
    expect(response.caveats?.invisibleSurfaces).not.toContain(
      'the Python pipeline (scripts/**/*.py)',
    );
    expect(response.caveats?.mergedEvidence).toEqual([
      { source: 'ast-dataflow-py', path, rows: 1 },
    ]);
    expect(response.caveats?.evidenceUnknownTables).toBeUndefined();
  });

  it('keeps the Python invisible surface when the merged sidecar is from another producer', async () => {
    const path = pySidecar(
      'other-source.json',
      [pyRow({})],
      'ast-dataflow-sql',
    );
    const response = await runCoverage({ evidence: [path] });
    expect(response.caveats?.invisibleSurfaces).toHaveLength(4);
    expect(response.caveats?.invisibleSurfaces).toContain(
      'the Python pipeline (scripts/**/*.py)',
    );
  });

  it('merges every sidecar when several are supplied', async () => {
    const first = pySidecar('multi-a.json', [pyRow({})]);
    const second = pySidecar(
      'multi-b.json',
      [pyRow({ column: 'budget_gbp', direction: 'read', line: 20 })],
      'ast-dataflow-sql',
    );
    const response = await runCoverage({ evidence: [first, second] });
    expect(row(response, 'bid_projects', 'title')?.verdict).toBe('wired');
    expect(row(response, 'bid_projects', 'budget_gbp')?.verdict).toBe(
      'read-only',
    );
    expect(response.caveats?.mergedEvidence).toHaveLength(2);
  });

  it('lists merged sidecars in the Markdown report caveat header', async () => {
    const path = pySidecar('report.json', [pyRow({})]);
    const report = renderSchemaCoverageReport(
      await runCoverage({ evidence: [path] }),
    );
    expect(report).toContain('- Merged external evidence sidecars:');
    expect(report).toContain(`ast-dataflow-py — \`${path}\`, 1 row(s)`);
  });

  it('accepts a repo-root-relative path and reports it relative', async () => {
    // The checked-in fixture sidecar, addressed the way CI would address a
    // producer's output: relative to the repo root (here, the fixture dir).
    const response = await runCoverage({ evidence: ['evidence-py.json'] });
    expect(response.caveats?.mergedEvidence).toEqual([
      { source: 'ast-dataflow-py', path: 'evidence-py.json', rows: 1 },
    ]);
    // Wildcard-only before, now exact-read + the untyped TS write → read-only.
    expect(row(response, 'feed_articles', 'retention_class')).toMatchObject({
      verdict: 'read-only',
      exactReads: 1,
      wildcardReads: 1,
      indirectWrites: 1,
      evidence: {
        reads: ['scripts/pipeline/retention.py:88', 'wildcard-poisoned.ts:32'],
      },
    });
  });
});

describe('schema-coverage — evidence sidecar rejection', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'schema-coverage-bad-'));

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function badSidecar(name: string, body: string): string {
    const path = join(tmpDir, name);
    writeFileSync(path, body);
    return path;
  }

  it('rejects a malformed sidecar with a parse_error naming the file', async () => {
    const path = badSidecar('malformed.json', '{ "schemaVersion": 1, rows: [');
    const response = await runCoverage({ evidence: [path] });
    expect(response.error?.kind).toBe('parse_error');
    expect(response.error?.message).toContain(path);
    expect(response.error?.message).toContain('not valid JSON');
    expect(response.results).toEqual([]);
  });

  it('rejects a sidecar declaring an unsupported schemaVersion', async () => {
    const path = badSidecar(
      'version.json',
      JSON.stringify({ schemaVersion: 2, source: 'ast-dataflow-py', rows: [] }),
    );
    const response = await runCoverage({ evidence: [path] });
    expect(response.error?.kind).toBe('parse_error');
    expect(response.error?.message).toContain('schemaVersion 2');
    expect(response.results).toEqual([]);
  });

  it('rejects a sidecar with no rows array', async () => {
    const path = badSidecar(
      'no-rows.json',
      JSON.stringify({ schemaVersion: 1, source: 'ast-dataflow-py' }),
    );
    const response = await runCoverage({ evidence: [path] });
    expect(response.error?.kind).toBe('parse_error');
    expect(response.error?.message).toContain('`rows` array');
  });

  it('rejects a row with a direction outside the contract, naming the row index', async () => {
    const path = badSidecar(
      'bad-row.json',
      JSON.stringify({
        schemaVersion: 1,
        source: 'ast-dataflow-py',
        rows: [
          {
            table: 'bid_projects',
            column: 'title',
            direction: 'delete',
            confidence: 'exact',
            method: 'declare_row',
            file: 'scripts/x.py',
            line: 1,
            source: 'declarative',
          },
        ],
      }),
    );
    const response = await runCoverage({ evidence: [path] });
    expect(response.error?.kind).toBe('parse_error');
    expect(response.error?.message).toContain("row 0 has direction 'delete'");
  });

  it('rejects an unreadable sidecar path with unknown_file', async () => {
    const response = await runCoverage({
      evidence: [join(tmpDir, 'never-written.json')],
    });
    expect(response.error?.kind).toBe('unknown_file');
    expect(response.error?.message).toContain('never-written.json');
    expect(response.results).toEqual([]);
  });
});

describe('schema-coverage — verdicts without evidence are unchanged', () => {
  it('omits the sidecar caveat fields and keeps the TS-only scan disclosure', async () => {
    const response = await runCoverage();
    expect(response.caveats?.scan).toBe(
      'Verdicts are based on TypeScript query-chain evidence only (.from() chains in the tsconfig corpus). No SQL is parsed.',
    );
    expect(response.caveats?.invisibleSurfaces).toContain(
      'the Python pipeline (scripts/**/*.py)',
    );
    expect(response.caveats).not.toHaveProperty('mergedEvidence');
    expect(response.caveats).not.toHaveProperty('evidenceUnknownTables');
  });

  it('treats an empty evidence list as no evidence at all', async () => {
    const withoutFlag = await runCoverage();
    const emptyList = await runCoverage({ evidence: [] });
    expect(emptyList.results).toEqual(withoutFlag.results);
    expect(emptyList.caveats).toEqual(withoutFlag.caveats);
    expect(emptyList.summary).toEqual(withoutFlag.summary);
  });
});

describe('schema-coverage — CLI report output', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'schema-coverage-'));
  const reportPath = join(tmpDir, 'report.md');

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runCli(args: string[]): string {
    return execFileSync('bun', [CLI_PATH, 'schema-coverage', ...args], {
      cwd: FIXTURE_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], // keep CLI stderr out of the test log
    });
  }

  it(
    'emits a JSON envelope and writes no report file when --report is absent',
    { timeout: 60_000 },
    () => {
      const stdout = runCli([]);
      const envelope = JSON.parse(stdout);
      expect(envelope.query).toBe('schema-coverage');
      expect(envelope.results).toHaveLength(12);
      expect(existsSync(reportPath)).toBe(false);
    },
  );

  it(
    'merges every --evidence occurrence, comma-separated or repeated',
    { timeout: 60_000 },
    () => {
      const rows = (column: string) => [
        {
          table: 'bid_projects',
          column,
          direction: 'write',
          confidence: 'exact',
          method: 'declare_row',
          file: 'scripts/pipeline/writer.py',
          line: 12,
          source: 'declarative',
        },
      ];
      const paths = ['a', 'b', 'c'].map((name, i) => {
        const path = join(tmpDir, `evidence-${name}.json`);
        writeFileSync(
          path,
          JSON.stringify({
            schemaVersion: 1,
            source: 'ast-dataflow-py',
            rows: rows(['title', 'title', 'budget_gbp'][i]),
          }),
        );
        return path;
      });
      const stdout = runCli([
        '--evidence',
        `${paths[0]},${paths[1]}`,
        '--evidence',
        paths[2],
      ]);
      const envelope = JSON.parse(stdout);
      expect(envelope.caveats.mergedEvidence).toHaveLength(3);
      expect(
        envelope.results.find(
          (r: { table: string; column: string }) =>
            r.table === 'bid_projects' && r.column === 'title',
        ).exactWrites,
      ).toBe(2); // title has no TS exact write — both rows come from sidecars
    },
  );

  it(
    'writes the Markdown report only when --report is passed, unwired first with caveats attached',
    { timeout: 60_000 },
    () => {
      runCli(['--report', reportPath]);
      expect(existsSync(reportPath)).toBe(true);
      const report = readFileSync(reportPath, 'utf8');
      expect(report.startsWith('# Schema Coverage Report')).toBe(true);
      // Section order: unwired detail before undecidable, rollup, summary.
      const unwiredIdx = report.indexOf('## Unwired columns');
      const undecidableIdx = report.indexOf('## Undecidable columns');
      const rollupIdx = report.indexOf('## Per-table rollup');
      const summaryIdx = report.indexOf('## Summary');
      expect(unwiredIdx).toBeGreaterThan(-1);
      expect(undecidableIdx).toBeGreaterThan(unwiredIdx);
      expect(rollupIdx).toBeGreaterThan(undecidableIdx);
      expect(summaryIdx).toBeGreaterThan(rollupIdx);
      // The unwired verdict carries its caveats and the scan blindness.
      expect(report).toContain('`bid_projects.budget_gbp`');
      expect(report).toContain('## Scan caveats');
      expect(report).toContain('`unattributable-global.ts` — 1 site(s)');
    },
  );
});

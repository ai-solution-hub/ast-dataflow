import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { schemaCoverage, createProject } from '@/tools/ast-dataflow';

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

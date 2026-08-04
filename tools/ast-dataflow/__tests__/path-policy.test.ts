/**
 * Per-surface path policy for caller-supplied fs paths (issue #1, audit
 * HIGH-1).
 *
 * These tests drive `dispatch`, not the query functions, because dispatch is
 * the seam both surfaces cross — a policy proven only against the pure
 * checker would pass while the shipped surfaces stayed open. The pure
 * checker is exercised directly only for the cases a fixture cannot stage
 * (sibling-prefix roots, exhaustiveness).
 *
 * Corpora are the committed synthetic fixtures plus a per-run temp directory;
 * "outside the repo root" means outside the FIXTURE root, so no test depends
 * on anything above this checkout.
 */
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProject } from '@/tools/ast-dataflow';
import { QUERY_NAMES, dispatch } from '@/tools/ast-dataflow/dispatch';
import {
  PATH_ARGS,
  checkArgPaths,
  mcpPathPolicy,
} from '@/tools/ast-dataflow/path-policy';
import type { PathPolicy } from '@/tools/ast-dataflow/path-policy';
import type {
  DeadExportsArgs,
  FixtureUsesArgs,
  SchemaCoverageArgs,
} from '@/tools/ast-dataflow/types';

const COVERAGE_FIXTURE = resolve(__dirname, 'fixtures', '21-schema-coverage');
const DEAD_EXPORTS_FIXTURE = resolve(__dirname, 'fixtures', '09-dead-exports');

/** A valid contract-v1 sidecar, so a merge failure can only be the policy. */
const SIDECAR = JSON.stringify({
  schemaVersion: 1,
  source: 'ast-dataflow-py',
  rows: [
    {
      table: 'feed_articles',
      column: 'retention_class',
      direction: 'read',
      confidence: 'exact',
      method: 'declare_row',
      file: 'pipeline/retention.py',
      line: 12,
      source: 'declarative',
    },
  ],
});

let outsideDir: string;
let outsideSidecar: string;
let outsideSymbols: string;

beforeAll(() => {
  outsideDir = mkdtempSync(join(tmpdir(), 'ast-dataflow-path-policy-'));
  outsideSidecar = join(outsideDir, 'evidence.json');
  outsideSymbols = join(outsideDir, 'symbols.txt');
  writeFileSync(outsideSidecar, SIDECAR);
  writeFileSync(outsideSymbols, 'unusedHelper\n');
});

afterAll(() => {
  rmSync(outsideDir, { recursive: true, force: true });
});

function projectAt(fixtureDir: string) {
  return createProject({
    tsConfigFilePath: resolve(fixtureDir, 'tsconfig.json'),
    repoRoot: fixtureDir,
  });
}

/** The MCP default: the repo root and nothing else. */
function confined(fixtureDir: string): PathPolicy {
  return mcpPathPolicy(fixtureDir, undefined);
}

async function coverage(
  args: SchemaCoverageArgs,
  policy?: PathPolicy,
): Promise<Awaited<ReturnType<typeof dispatch<'schema-coverage'>>>> {
  const { project, repoRoot } = projectAt(COVERAGE_FIXTURE);
  return dispatch('schema-coverage', args, project, repoRoot, policy);
}

async function deadExports(
  args: DeadExportsArgs,
  policy?: PathPolicy,
): Promise<Awaited<ReturnType<typeof dispatch<'dead-exports'>>>> {
  const { project, repoRoot } = projectAt(DEAD_EXPORTS_FIXTURE);
  return dispatch('dead-exports', args, project, repoRoot, policy);
}

async function fixtureUses(
  args: FixtureUsesArgs,
  policy?: PathPolicy,
): Promise<Awaited<ReturnType<typeof dispatch<'fixture-uses'>>>> {
  const { project, repoRoot } = projectAt(COVERAGE_FIXTURE);
  return dispatch('fixture-uses', args, project, repoRoot, policy);
}

// ---------------------------------------------------------------------------
// CLI surface — unconfined, because the census depends on it
// ---------------------------------------------------------------------------

describe('CLI surface — caller-supplied paths stay unconfined', () => {
  it('merges an evidence sidecar written outside the repo root', async () => {
    // The shipped census (run_census.py) defaults its sidecar output to
    // $TMPDIR and passes the absolute path here. Confining this breaks it.
    const response = await coverage({ evidence: [outsideSidecar] });

    expect(response.error).toBeUndefined();
    expect(response.caveats?.mergedEvidence).toEqual([
      { source: 'ast-dataflow-py', path: outsideSidecar, rows: 1 },
    ]);
  });

  it('reads a symbolsFile written outside the repo root', async () => {
    const response = await deadExports({ symbolsFile: outsideSymbols });

    expect(response.error).toBeUndefined();
    expect(response.results.map((r) => r.symbol)).toEqual(['unusedHelper']);
  });

  it('accepts a fixture-uses scope glob that leaves the repo root', async () => {
    const response = await fixtureUses({ needle: 'x', scope: '../*.json' });

    expect(response.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MCP surface — allowlist, default [repoRoot]
// ---------------------------------------------------------------------------

describe('MCP surface — paths outside the allowed roots are refused', () => {
  it('refuses an evidence sidecar outside the repo root', async () => {
    const response = await coverage(
      { evidence: [outsideSidecar] },
      confined(COVERAGE_FIXTURE),
    );

    expect(response.error?.kind).toBe('path_not_allowed');
    expect(response.results).toEqual([]);
    expect(response.caveats?.mergedEvidence).toBeUndefined();
  });

  it('refuses an evidence sidecar reached by traversal from inside', async () => {
    const response = await coverage(
      { evidence: ['../../../../etc/hosts'] },
      confined(COVERAGE_FIXTURE),
    );

    expect(response.error?.kind).toBe('path_not_allowed');
  });

  it('refuses a symbolsFile outside the repo root', async () => {
    const response = await deadExports(
      { symbolsFile: outsideSymbols },
      confined(DEAD_EXPORTS_FIXTURE),
    );

    expect(response.error?.kind).toBe('path_not_allowed');
    expect(response.results).toEqual([]);
  });

  it('refuses a fixture-uses scope glob that traverses out of the repo', async () => {
    const response = await fixtureUses(
      { needle: 'retention_class', scope: '../../*.json' },
      confined(COVERAGE_FIXTURE),
    );

    expect(response.error?.kind).toBe('path_not_allowed');
  });

  it('refuses an absolute fixture-uses scope glob', async () => {
    // Measured against tinyglobby: '/etc/*.conf' with cwd at the repo root
    // returns host files, so this pattern shape really does escape.
    const response = await fixtureUses(
      { needle: 'retention_class', scope: '/etc/*.conf' },
      confined(COVERAGE_FIXTURE),
    );

    expect(response.error?.kind).toBe('path_not_allowed');
  });
});

describe('MCP surface — paths inside the allowed roots still work', () => {
  it('merges an evidence sidecar inside the repo root', async () => {
    const response = await coverage(
      { evidence: ['evidence-py.json'] },
      confined(COVERAGE_FIXTURE),
    );

    expect(response.error).toBeUndefined();
    expect(response.caveats?.mergedEvidence).toEqual([
      { source: 'ast-dataflow-py', path: 'evidence-py.json', rows: 1 },
    ]);
  });

  it('runs a fixture-uses scope glob that stays inside the repo root', async () => {
    const response = await fixtureUses(
      { needle: 'retention_class', scope: '*.json' },
      confined(COVERAGE_FIXTURE),
    );

    expect(response.error).toBeUndefined();
    expect(response.results.map((r) => r.file)).toContain('evidence-py.json');
  });

  it('merges an outside sidecar once the operator adds its root', async () => {
    // The census-over-MCP opt-in: AST_DATAFLOW_ALLOWED_ROOTS at spawn.
    const response = await coverage(
      { evidence: [outsideSidecar] },
      mcpPathPolicy(COVERAGE_FIXTURE, outsideDir),
    );

    expect(response.error).toBeUndefined();
    expect(response.caveats?.mergedEvidence).toEqual([
      { source: 'ast-dataflow-py', path: outsideSidecar, rows: 1 },
    ]);
  });

  it('leaves a non-fs scope argument alone even when it contains ..', async () => {
    // Same query, two arguments, two answers: schema-coverage's `evidence`
    // names a file to open and is policed, while its `scope` compiles to an
    // in-memory matcher over files the corpus already holds and never opens
    // anything. Policing the second would restrict a query that reads nothing.
    const response = await coverage(
      { scope: '../**/*.ts' },
      confined(COVERAGE_FIXTURE),
    );

    expect(response.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The oracle: a refusal must not report on the filesystem
// ---------------------------------------------------------------------------

describe('refusal cannot be used as a file-existence oracle', () => {
  const probe = () => join(outsideDir, 'oracle-probe.json');

  it('returns byte-identical refusals whether or not the file exists', async () => {
    const path = probe();
    const policy = confined(COVERAGE_FIXTURE);

    const missing = await coverage({ evidence: [path] }, policy);
    writeFileSync(path, SIDECAR);
    const present = await coverage({ evidence: [path] }, policy);
    unlinkSync(path);

    expect(missing.error).toEqual(present.error);
    expect(present.error?.kind).toBe('path_not_allowed');
  });

  it('refuses a real file and a made-up one with the same error kind', async () => {
    const policy = confined(COVERAGE_FIXTURE);

    const real = await coverage({ evidence: [outsideSidecar] }, policy);
    const imaginary = await coverage(
      { evidence: [join(outsideDir, 'no-such-file.json')] },
      policy,
    );

    expect(real.error?.kind).toBe(imaginary.error?.kind);
    expect(real.error?.hint).toBe(imaginary.error?.hint);
  });

  it('is a distinction the unconfined CLI surface really does leak', async () => {
    // Without the policy the two states answer differently — unknown_file for
    // the missing one, a clean merge for the present one. That difference is
    // the oracle, and the assertions above are what removes it.
    const path = probe();

    const missing = await coverage({ evidence: [path] });
    writeFileSync(path, SIDECAR);
    const present = await coverage({ evidence: [path] });
    unlinkSync(path);

    expect(missing.error?.kind).toBe('unknown_file');
    expect(present.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The policy itself
// ---------------------------------------------------------------------------

describe('path policy — shape', () => {
  it('declares the fs path arguments of every query in the catalogue', () => {
    // Exhaustiveness is a type error too; this measures it, so a new query
    // cannot ship an ungoverned path argument by omission.
    expect(Object.keys(PATH_ARGS).sort()).toEqual([...QUERY_NAMES].sort());
  });

  it('allows everything when no policy is supplied', () => {
    for (const query of QUERY_NAMES) {
      expect(
        checkArgPaths(
          query,
          {
            evidence: ['/etc/passwd'],
            symbolsFile: '/etc/passwd',
            scope: '..',
          },
          '/repo',
          undefined,
        ),
        query,
      ).toBeNull();
    }
  });

  it('does not treat a sibling directory as being inside a root', () => {
    const policy: PathPolicy = { allowedRoots: ['/repo'] };

    expect(
      checkArgPaths(
        'dead-exports',
        { symbolsFile: '/repo-evil/s.txt' },
        '/repo',
        policy,
      ),
    ).not.toBeNull();
    expect(
      checkArgPaths(
        'dead-exports',
        { symbolsFile: '/repo/s.txt' },
        '/repo',
        policy,
      ),
    ).toBeNull();
  });

  it('allows the root itself and rejects its parent', () => {
    const policy: PathPolicy = { allowedRoots: ['/repo'] };

    expect(
      checkArgPaths('dead-exports', { symbolsFile: '/repo' }, '/repo', policy),
    ).toBeNull();
    expect(
      checkArgPaths('dead-exports', { symbolsFile: '..' }, '/repo', policy),
    ).not.toBeNull();
  });
});

describe('path policy — MCP configuration', () => {
  it('defaults to the repo root alone', () => {
    expect(mcpPathPolicy('/repo', undefined).allowedRoots).toEqual(['/repo']);
  });

  it('adds operator-configured roots, delimited like PATH', () => {
    expect(
      mcpPathPolicy('/repo', '/var/census:/opt/evidence').allowedRoots,
    ).toEqual(['/repo', '/var/census', '/opt/evidence']);
  });

  it('resolves a relative configured root against the repo root', () => {
    expect(mcpPathPolicy('/repo', '../shared').allowedRoots).toEqual([
      '/repo',
      '/shared',
    ]);
  });

  it('ignores empty and whitespace-only entries', () => {
    expect(mcpPathPolicy('/repo', ' : ').allowedRoots).toEqual(['/repo']);
    expect(mcpPathPolicy('/repo', '').allowedRoots).toEqual(['/repo']);
  });
});

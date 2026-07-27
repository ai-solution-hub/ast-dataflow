import {
  appendFileSync,
  chmodSync,
  cpSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSerialQueue,
  createWarmState,
  warmDispatch,
} from '@/tools/ast-dataflow/staleness';

const FIXTURE_DIR = resolve(__dirname, 'fixtures', '22-staleness');

// Each test works on a throwaway copy of the fixture so on-disk edits,
// permission flips, and deletions never dirty the checked-in fixture.
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'ast-staleness-'));
  cpSync(FIXTURE_DIR, tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('warm-process staleness sweep', () => {
  it('refreshes only the edited file and updates query answers (inv 20)', async () => {
    const state = createWarmState({ repoRoot: tempDir });

    const first = await warmDispatch(state, 'callers', {
      symbol: 'target.ts:target',
    });
    expect(first.results).toHaveLength(1);
    // Nothing changed since construction — a quiet sweep reports no churn.
    expect(first.meta).toEqual({
      refreshedFiles: [],
      addedFiles: [],
      removedFiles: [],
      staleFiles: [],
    });

    appendFileSync(
      join(tempDir, 'caller.ts'),
      '\nexport function consumerTwo(): string {\n  return target();\n}\n',
    );

    const second = await warmDispatch(state, 'callers', {
      symbol: 'target.ts:target',
    });
    expect(second.meta.refreshedFiles).toEqual(['caller.ts']);
    expect(second.meta.addedFiles).toEqual([]);
    expect(second.meta.removedFiles).toEqual([]);
    expect(second.meta.staleFiles).toEqual([]);
    expect(second.results).toHaveLength(2);
    expect(second.results.map((r) => r.enclosing).sort()).toEqual([
      'fn:consumerOne',
      'fn:consumerTwo',
    ]);
  });

  it('picks up a file created on disk and drops it from answers when deleted', async () => {
    const state = createWarmState({ repoRoot: tempDir });

    const baseline = await warmDispatch(state, 'callers', {
      symbol: 'target.ts:target',
    });
    expect(baseline.results).toHaveLength(1);

    writeFileSync(
      join(tempDir, 'late-caller.ts'),
      "import { target } from './target';\n\nexport function lateConsumer(): string {\n  return target();\n}\n",
    );

    const afterAdd = await warmDispatch(state, 'callers', {
      symbol: 'target.ts:target',
    });
    expect(afterAdd.meta.addedFiles).toEqual(['late-caller.ts']);
    expect(afterAdd.meta.removedFiles).toEqual([]);
    expect(afterAdd.results).toHaveLength(2);
    expect(afterAdd.results.map((r) => r.file).sort()).toEqual([
      'caller.ts',
      'late-caller.ts',
    ]);

    unlinkSync(join(tempDir, 'late-caller.ts'));

    const afterRemove = await warmDispatch(state, 'callers', {
      symbol: 'target.ts:target',
    });
    expect(afterRemove.meta.removedFiles).toEqual(['late-caller.ts']);
    expect(afterRemove.meta.addedFiles).toEqual([]);
    expect(afterRemove.results).toHaveLength(1);
    expect(afterRemove.results[0].file).toBe('caller.ts');
  });

  it('reports a file whose refresh fails in meta.staleFiles and retries it next sweep (inv 22)', async () => {
    const state = createWarmState({ repoRoot: tempDir });
    await warmDispatch(state, 'callers', { symbol: 'target.ts:target' });

    const callerPath = join(tempDir, 'caller.ts');
    appendFileSync(
      callerPath,
      '\nexport function consumerTwo(): string {\n  return target();\n}\n',
    );
    // Unreadable but stat-able: the sweep detects the mtime+size change, the
    // refresh read throws — the stale-loud path (does not hold when running
    // as root, which ignores file modes).
    chmodSync(callerPath, 0o000);

    try {
      const stale = await warmDispatch(state, 'callers', {
        symbol: 'target.ts:target',
      });
      expect(stale.meta.staleFiles).toEqual(['caller.ts']);
      expect(stale.meta.refreshedFiles).toEqual([]);
      // Still answers — from the last-good AST (the pre-edit call site).
      expect(stale.results).toHaveLength(1);
    } finally {
      chmodSync(callerPath, 0o644);
    }

    const recovered = await warmDispatch(state, 'callers', {
      symbol: 'target.ts:target',
    });
    expect(recovered.meta.staleFiles).toEqual([]);
    expect(recovered.meta.refreshedFiles).toEqual(['caller.ts']);
    expect(recovered.results).toHaveLength(2);
  });
});

describe('warm-process call serialisation (inv 21)', () => {
  it('runs overlapping dispatches strictly in submission order', async () => {
    const state = createWarmState({ repoRoot: tempDir });
    const queue = createSerialQueue();
    const events: string[] = [];

    const first = queue.enqueue(async () => {
      events.push('first-start');
      const response = await warmDispatch(state, 'callers', {
        symbol: 'target.ts:target',
      });
      events.push('first-end');
      return response;
    });
    // Submitted while the first dispatch is still in flight.
    const second = queue.enqueue(async () => {
      events.push('second-start');
      const response = await warmDispatch(state, 'callers', {
        symbol: 'target.ts:target',
      });
      events.push('second-end');
      return response;
    });

    const [r1, r2] = await Promise.all([first, second]);
    expect(events).toEqual([
      'first-start',
      'first-end',
      'second-start',
      'second-end',
    ]);
    expect(r1.results).toHaveLength(1);
    expect(r2.results).toHaveLength(1);
  });

  it('keeps serving calls after a dispatch rejects', async () => {
    const queue = createSerialQueue();
    await expect(
      queue.enqueue(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(queue.enqueue(async () => 'still-serving')).resolves.toBe(
      'still-serving',
    );
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { SyncConfig, SyncExecutionResult } from '@sandforge/shared';

import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { consultProductionGuard } from '../../core/precheck/consultProductionGuard.js';
import { runPipelineSync, syncGuardVerdict } from './pipelineSync.js';
import { syncGuardRequest } from './SyncOpsHandler.js';

/** A saved configuration, as far as the guard reads one. */
function config(operations: Array<'insert' | 'update' | 'upsert' | 'delete'>): SyncConfig {
  return {
    id: 'cfg-1',
    name: 'Accounts',
    description: '',
    sourceOrgId: 'org-a',
    targetOrgId: 'org-b',
    direction: 'source_to_target',
    mode: 'full',
    objects: operations.map((operation, index) => ({
      objectApiName: `Object${index}__c`,
      operation,
      fieldMappings: [],
      transformRules: [],
      excludedFields: [],
      addOnFields: [],
      batchSize: 200,
      insertOrder: index,
    })),
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

/** What Sync's run answers. */
function result(overrides: Partial<SyncExecutionResult> = {}): SyncExecutionResult {
  return {
    configId: 'cfg-1',
    operationId: 'sync-op',
    status: 'success',
    objectResults: [],
    totalProcessed: 0,
    totalSuccess: 0,
    totalFailed: 0,
    totalSkipped: 0,
    duration: 0,
    timestamp: '2026-10-13T08:00:00.000Z',
    ...overrides,
  };
}

describe('syncGuardRequest', () => {
  it('judges the run by its most severe object, on the target org, as Sync does', () => {
    expect(syncGuardRequest(config(['insert', 'delete', 'upsert']), 'Sandbox')).toEqual({
      orgId: 'org-b',
      orgTier: 'development',
      operation: 'delete',
      objectName: 'Object0__c, Object1__c, Object2__c',
      recordCount: 'unknown',
      module: 'sync',
    });
  });

  it('judges a delta run that carries the source deletions as the delete it is', () => {
    // The step's own copy of the request judged it by its upsert, let it
    // through beforehand, and the run then refused it as a delete.
    const deleting: SyncConfig = { ...config(['upsert']), mode: 'delta', propagateDeletes: true };

    expect(syncGuardRequest(deleting, 'Sandbox').operation).toBe('delete');
    expect(
      syncGuardVerdict(
        new ProductionGuard({ requestConfirmation: vi.fn() }),
        syncGuardRequest(deleting, 'Production'),
      ),
    ).toEqual(expect.objectContaining({ decision: 'refused' }));
  });

  it('reads a target registered as production, and one the registry does not know, as production', () => {
    // A Developer Edition is registered as a production org: the guard asks
    // about it as about any production org.
    expect(syncGuardRequest(config(['insert']), 'Production').orgTier).toBe('production');
    expect(syncGuardRequest(config(['insert']), undefined).orgTier).toBe('production');
  });
});

describe('syncGuardVerdict', () => {
  const guard = new ProductionGuard({ requestConfirmation: vi.fn() });

  it('lets a sandbox target through without a question', () => {
    expect(syncGuardVerdict(guard, syncGuardRequest(config(['upsert']), 'Sandbox'))).toEqual({
      decision: 'allowed',
    });
  });

  it('says the guard asks about a production target', () => {
    expect(syncGuardVerdict(guard, syncGuardRequest(config(['upsert']), 'Production'))).toEqual({
      decision: 'asks',
    });
  });

  it('says the guard refuses a delete on production, and why', () => {
    const verdict = syncGuardVerdict(guard, syncGuardRequest(config(['delete']), 'Production'));
    expect(verdict.decision).toBe('refused');
    expect(verdict).toMatchObject({ reason: expect.stringContaining('delete is not allowed') });
  });

  it('refuses where no guard runs, as Sync does', () => {
    expect(syncGuardVerdict(undefined, syncGuardRequest(config(['insert']), 'Sandbox'))).toEqual({
      decision: 'refused',
      reason: 'no Production Guard runs in this window',
    });
  });

  it('asks nobody to work it out', () => {
    const ask = vi.fn();
    syncGuardVerdict(
      new ProductionGuard({ requestConfirmation: ask }),
      syncGuardRequest(config(['upsert']), 'Production'),
    );
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('runPipelineSync', () => {
  it("gives Sync's guard the step's answer instead of a question", async () => {
    const ask = vi.fn().mockResolvedValue(false);
    const guard = new ProductionGuard({ requestConfirmation: ask });
    const execute = vi.fn(async (run: SyncConfig) => {
      const { decision } = await consultProductionGuard(guard, syncGuardRequest(run, 'Production'));
      return result({ error: decision });
    });

    const approved = await runPipelineSync({ execute }, config(['upsert']), { approved: true });
    const notApproved = await runPipelineSync({ execute }, config(['upsert']), {
      approved: false,
    });

    expect(approved.error).toBe('confirmed');
    expect(notApproved.error).toBe('declined');
    expect(ask).not.toHaveBeenCalled();
  });

  it('cancels the Sync run it started when the step is stopped', async () => {
    const registry = new BackgroundOperationRegistry();
    const step = new AbortController();
    const syncRun = new AbortController();
    const execute = vi.fn(async () => {
      // Sync consults its guard before it registers.
      await Promise.resolve();
      const done = new Promise<SyncExecutionResult>((resolve) => {
        syncRun.signal.addEventListener('abort', () =>
          resolve(result({ status: 'partial', cancelled: true })),
        );
      });
      registry.register('sync-op', 'sync', 'Scheduled sync of 1 object(s)', done, syncRun);
      return done;
    });

    const pending = runPipelineSync(
      { execute, registry },
      config(['insert']),
      { approved: false },
      step.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(syncRun.signal.aborted).toBe(false);
    step.abort();

    await expect(pending).resolves.toMatchObject({ cancelled: true });
    expect(registry.get('sync-op')?.status).toBe('aborted');
  });

  it('stops, as it starts, a Sync run the step was cancelled during', async () => {
    const registry = new BackgroundOperationRegistry();
    const step = new AbortController();
    const syncRun = new AbortController();
    const execute = vi.fn(async () => {
      step.abort();
      await Promise.resolve();
      registry.register('sync-op', 'sync', 'Scheduled sync', new Promise(() => undefined), syncRun);
      return result({ status: 'partial', cancelled: true });
    });

    await runPipelineSync(
      { execute, registry },
      config(['insert']),
      { approved: false },
      step.signal,
    );

    expect(syncRun.signal.aborted).toBe(true);
  });

  it('leaves alone a Sync another caller started meanwhile', async () => {
    const registry = new BackgroundOperationRegistry();
    const page = new AbortController();
    const step = new AbortController();
    let release: (value: SyncExecutionResult) => void = () => undefined;
    const execute = vi.fn(
      () =>
        new Promise<SyncExecutionResult>((resolve) => {
          release = resolve;
        }),
    );

    const pending = runPipelineSync(
      { execute, registry },
      config(['insert']),
      { approved: false },
      step.signal,
    );
    // A Sync started from its page while the step's run is under way: not
    // from the step's call.
    registry.register('page-op', 'sync', 'Sync 1 object(s)', new Promise(() => undefined), page);
    step.abort();
    release(result());
    await pending;

    expect(page.signal.aborted).toBe(false);
  });
});

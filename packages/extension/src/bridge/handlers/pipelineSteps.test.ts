import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  CompareResult,
  PipelineApprovalRecord,
  PipelineStep,
  PipelineStepType,
  SyncExecutionResult,
} from '@sandforge/shared';
import { ApprovalGate } from '../../modules/automation/ApprovalGate.js';
import { StepCancelledError, StepExecutor } from '../../modules/automation/StepExecutor.js';
import type { StepContext } from '../../modules/automation/StepExecutor.js';
import type { HealthSignal } from '../../modules/monitor/HealthCheck.js';
import type { HealthSignalName } from '../../modules/monitor/MonitorOpsFactory.js';
import { describeSyncConfigs, registerPipelineSteps } from './pipelineSteps.js';
import type { PipelineStepRunners, SyncGuardVerdict } from './pipelineSteps.js';

/** Two registered orgs, by id, and the names the user knows them by. */
const ORGS: Record<string, string> = { 'org-a': 'uat', 'org-b': 'dev' };

/** A snapshot of `objects`, as DataOps answers one. */
function snapshot(operationId: string, objects: Array<[string, number, boolean?]>) {
  return {
    operationId,
    objects: objects.map(([objectApiName, recordCount, truncated = false]) => ({
      objectApiName,
      recordCount,
      truncated,
    })),
    totalRecords: objects.reduce((sum, [, count]) => sum + count, 0),
    partial: objects.some(([, , truncated]) => truncated === true),
    timestamp: '2026-09-23T00:00:00.000Z',
  };
}

/** A comparison, as the Compare flow answers one. */
function comparison(): CompareResult {
  return {
    configId: 'cfg-1',
    sourceOrgId: 'org-a',
    targetOrgId: 'org-b',
    mode: 'metadata',
    summary: {
      totalItems: 12,
      added: 2,
      removed: 1,
      modified: 3,
      unchanged: 5,
      notCompared: 1,
      byType: {},
    },
    content: {
      compared: 8,
      notCompared: { unreadable: 1, read_failed: 0, over_budget: 0 },
      budget: { components: 400, seconds: 120 },
    },
    diffs: [],
    timestamp: '2026-09-23T00:00:00.000Z',
    duration: 1500,
  };
}

/** A health signal as the Monitor reads one. */
function signal(overrides: Partial<HealthSignal> & Pick<HealthSignal, 'name'>): HealthSignal {
  return { status: 'ok', score: 100, message: 'fine', ...overrides };
}

function runners(overrides: Partial<PipelineStepRunners> = {}): PipelineStepRunners {
  let next = 0;
  return {
    orgName: (orgId) => ORGS[orgId],
    newId: () => `snap-${++next}`,
    backup: vi.fn(async (request) => snapshot(request.operationId, [['Account', 3]])),
    compare: vi.fn(async () => comparison()),
    readOrgHealth: vi.fn(async (_orgId: string, signals: readonly HealthSignalName[]) =>
      signals.map((name) => signal({ name, message: `${name} fine` })),
    ),
    notify: vi.fn(),
    ...overrides,
  };
}

function step(
  type: PipelineStepType,
  config: Record<string, unknown>,
  extra: Partial<PipelineStep> = {},
): PipelineStep {
  return { id: `s-${type}`, name: 'Step', type, config, continueOnError: false, ...extra };
}

function context(overrides: Partial<StepContext> = {}): StepContext {
  return {
    variables: {},
    previousResults: [],
    pipelineId: 'p-1',
    pipelineName: 'Nightly check',
    runId: 'run-1',
    ...overrides,
  };
}

describe('registerPipelineSteps', () => {
  let executor: StepExecutor;
  let flows: PipelineStepRunners;

  beforeEach(() => {
    executor = new StepExecutor();
    flows = runners();
    registerPipelineSteps(executor, flows);
  });

  describe('the steps that write to an org', () => {
    it.each(['restore', 'delete'] as const)(
      'still refuses a %s step: it runs from its own page',
      (type) => {
        expect(executor.check(step(type, {}))).toContain('cannot run in a pipeline yet');
      },
    );
  });

  describe('Approval', () => {
    /** An answer, as the gate gives one. */
    function answered(record: PipelineApprovalRecord): PipelineStepRunners['askApproval'] {
      return vi.fn(async () => record);
    }

    function withApproval(askApproval: PipelineStepRunners['askApproval']): StepExecutor {
      const own = new StepExecutor();
      registerPipelineSteps(own, runners({ askApproval }));
      return own;
    }

    it('is refused before the run where there is no window to ask in', () => {
      expect(executor.check(step('approval', {}))).toBe(
        'Approval step "Step" cannot ask anyone: there is no VS Code window to ask in.',
      );
    });

    it('is refused before the run for a wait it cannot keep, or a message too long', () => {
      const own = withApproval(answered({ decision: 'approved', at: 'now' }));
      expect(own.check(step('approval', { timeoutMinutes: 0 }))).toContain(
        'from 1 to 1440 (a day)',
      );
      expect(own.check(step('approval', { message: 'x'.repeat(501) }))).toContain(
        'longer than 500 characters',
      );
      expect(own.check(step('approval', {}))).toBeUndefined();
    });

    it('asks for an hour by default, with the message, and goes on once approved', async () => {
      const askApproval = answered({
        decision: 'approved',
        via: 'notification',
        at: '2026-10-13T08:00:20.000Z',
        by: 'sha256:0123456789ab',
      });
      const own = withApproval(askApproval);

      const result = await own.execute(
        step('approval', { message: '  Check the comparison first.  ' }),
        context(),
      );

      expect(askApproval).toHaveBeenCalledWith(
        {
          stepId: 's-approval',
          stepName: 'Step',
          pipelineName: 'Nightly check',
          message: 'Check the comparison first.',
          timeoutMs: 3_600_000,
        },
        expect.any(AbortSignal),
      );
      expect(result.status).toBe('completed');
      expect(result.summary).toBe(
        'Approved in the VS Code notification at 2026-10-13T08:00:20.000Z.',
      );
      expect(result.approval).toEqual({
        decision: 'approved',
        via: 'notification',
        at: '2026-10-13T08:00:20.000Z',
        by: 'sha256:0123456789ab',
      });
    });

    it('fails, rejected, when the person rejects it on the page', async () => {
      const own = withApproval(
        answered({ decision: 'rejected', via: 'page', at: '2026-10-13T08:01:00.000Z' }),
      );

      const result = await own.execute(step('approval', {}), context());

      expect(result.status).toBe('failed');
      expect(result.error).toBe(
        'Approval step "Step" was rejected on the Automation page at 2026-10-13T08:01:00.000Z.',
      );
      expect(result.approval?.decision).toBe('rejected');
    });

    it('fails, not approved in time, when nobody answers within its wait', async () => {
      const askApproval = answered({ decision: 'timedOut', at: '2026-10-13T08:05:00.000Z' });
      const own = withApproval(askApproval);

      const result = await own.execute(step('approval', { timeoutMinutes: 5 }), context());

      expect(askApproval).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 300_000 }),
        expect.any(AbortSignal),
      );
      expect(result.status).toBe('failed');
      expect(result.error).toBe(
        'Approval step "Step" was not approved in time: nobody answered within 5 minutes.',
      );
    });

    it('lets go of the question when the run is cancelled while it waits', async () => {
      const gate = new ApprovalGate({ ask: () => new Promise(() => undefined) });
      const own = withApproval((ask, signal) => gate.ask({ ...ask, operationId: 'op-1' }, signal));
      const run = new AbortController();

      const pending = own.execute(step('approval', {}), context({ signal: run.signal }));
      await Promise.resolve();
      expect(gate.isWaiting('op-1', 's-approval')).toBe(true);
      run.abort();
      const result = await pending;

      expect(result.status).toBe('failed');
      expect(result.error).toBe('Step "Step" was stopped before it finished.');
      expect(gate.isWaiting('op-1', 's-approval')).toBe(false);
    });
  });

  describe('Sync', () => {
    /** A saved Sync configuration, as the Sync page stores one. */
    function savedConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        id: 'cfg-1',
        name: 'Accounts to dev',
        description: '',
        sourceOrgId: 'org-a',
        targetOrgId: 'org-b',
        direction: 'source_to_target',
        mode: 'full',
        objects: [
          {
            objectApiName: 'Account',
            operation: 'upsert',
            externalIdField: 'Ext_Id__c',
            batchSize: 200,
            fieldMappings: [],
            transformRules: [],
            excludedFields: [],
            addOnFields: [],
            insertOrder: 0,
          },
        ],
        conflictStrategy: 'source_wins',
        enableRollback: false,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        ...overrides,
      };
    }

    /** What Sync's run answers, counts and all. */
    function syncResult(overrides: Partial<SyncExecutionResult> = {}): SyncExecutionResult {
      return {
        configId: 'cfg-1',
        operationId: 'sync-op-1',
        status: 'success',
        objectResults: [
          {
            objectApiName: 'Account',
            operation: 'upsert',
            processed: 12,
            success: 12,
            failed: 0,
            skipped: 0,
            conflictCount: 0,
            errors: [],
          },
        ],
        totalProcessed: 12,
        totalSuccess: 12,
        totalFailed: 0,
        totalSkipped: 0,
        duration: 900,
        timestamp: '2026-10-13T08:02:00.000Z',
        ...overrides,
      };
    }

    function syncFlows(
      guard: SyncGuardVerdict,
      overrides: Partial<PipelineStepRunners> = {},
    ): PipelineStepRunners {
      const configs: Record<string, unknown> = { 'cfg-1': savedConfig() };
      return runners({
        savedSyncConfig: (id) => configs[id],
        listSyncConfigs: () => Object.values(configs),
        syncGuard: vi.fn(() => guard),
        runSync: vi.fn(async () => syncResult()),
        ...overrides,
      });
    }

    function withSync(flowsForSync: PipelineStepRunners): StepExecutor {
      const own = new StepExecutor();
      registerPipelineSteps(own, flowsForSync);
      return own;
    }

    const sync = step('sync', { configId: 'cfg-1' });
    const approval = step('approval', {});
    const alone = { steps: [sync], index: 0, declared: new Set<string>() };
    const afterApproval = { steps: [approval, sync], index: 1, declared: new Set<string>() };

    it('is refused where Sync is not available', () => {
      expect(executor.check(sync, alone)).toBe(
        'Sync step "Step" cannot run here: Sync is not available in this window.',
      );
    });

    it('refuses a step that names no configuration, one deleted, and one that no longer validates', () => {
      const own = withSync(
        syncFlows(
          { decision: 'allowed' },
          {
            savedSyncConfig: (id) =>
              id === 'old' ? savedConfig({ id: 'old', dryRun: true }) : undefined,
          },
        ),
      );

      expect(own.check(step('sync', {}), alone)).toBe(
        'Sync step "Step" names no saved Sync configuration: choose the one it runs.',
      );
      expect(own.check(step('sync', { configId: 'gone' }), alone)).toBe(
        'Sync step "Step" names a Sync configuration that is no longer saved (gone): choose another.',
      );
      expect(own.check(step('sync', { configId: 'old' }), alone)).toContain(
        'names a Sync configuration that no longer validates (dryRun:',
      );
    });

    it('refuses a target Production Guard asks about unless an Approval step comes before it', () => {
      const own = withSync(syncFlows({ decision: 'asks' }));

      expect(own.check(sync, alone)).toBe(
        'Sync step "Step" writes to dev, which Production Guard asks about before a write, and ' +
          'nobody may be there to answer when the pipeline runs: put an Approval step before it.',
      );
      expect(own.check(sync, afterApproval)).toBeUndefined();
    });

    it('lets a target the guard lets through run with no Approval step', () => {
      expect(withSync(syncFlows({ decision: 'allowed' })).check(sync, alone)).toBeUndefined();
    });

    it('refuses what the guard refuses, an Approval step before it or not', () => {
      const own = withSync(
        syncFlows({ decision: 'refused', reason: 'delete is not allowed on production org org-b' }),
      );

      expect(own.check(sync, afterApproval)).toBe(
        'Sync step "Step" writes where Production Guard refuses it, whatever anyone answers: ' +
          'delete is not allowed on production org org-b.',
      );
    });

    it('runs after an approval, hands the guard that answer, and carries Sync’s counts and summary', async () => {
      const runSync = vi.fn(async () =>
        Object.assign(syncResult(), { summary: { delta: { since: '2026-10-12', read: 12 } } }),
      );
      const own = withSync(syncFlows({ decision: 'asks' }, { runSync }));
      const signal = new AbortController().signal;

      const result = await own.execute(
        sync,
        context({
          signal,
          previousResults: [
            {
              stepId: 's-approval',
              stepName: 'Before',
              stepType: 'approval',
              status: 'completed',
              approval: { decision: 'approved', via: 'page', at: '2026-10-13T08:01:00.000Z' },
            },
          ],
        }),
      );

      expect(runSync).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'cfg-1', targetOrgId: 'org-b' }),
        { approved: true },
        expect.any(AbortSignal),
      );
      expect(result.status).toBe('completed');
      expect(result.summary).toBe(
        'Synced "Accounts to dev" into dev: 12 records written, 0 failed and 0 skipped of 12 read.',
      );
      expect(result.output).toMatchObject({
        configId: 'cfg-1',
        operationId: 'sync-op-1',
        totalProcessed: 12,
        totalSuccess: 12,
        totalFailed: 0,
        objects: [{ objectApiName: 'Account', operation: 'upsert', success: 12 }],
        summary: { delta: { since: '2026-10-12', read: 12 } },
      });
    });

    it('runs into a sandbox with no approval, and tells the guard nobody approved', async () => {
      const runSync = vi.fn(async () => syncResult());
      const own = withSync(syncFlows({ decision: 'allowed' }, { runSync }));

      await own.execute(sync, context());

      expect(runSync).toHaveBeenCalledWith(
        expect.anything(),
        { approved: false },
        expect.any(AbortSignal),
      );
    });

    it('tells the guard nobody approved when the Approval before it was rejected', async () => {
      const runSync = vi.fn(async () => syncResult());
      const own = withSync(syncFlows({ decision: 'asks' }, { runSync }));

      await own.execute(
        sync,
        context({
          previousResults: [
            {
              stepId: 's-approval',
              stepName: 'Before',
              stepType: 'approval',
              status: 'failed',
              approval: { decision: 'rejected', via: 'page', at: '2026-10-13T08:01:00.000Z' },
            },
          ],
        }),
      );

      expect(runSync).toHaveBeenCalledWith(
        expect.anything(),
        { approved: false },
        expect.any(AbortSignal),
      );
    });

    it('fails a run that wrote part of its records, with the counts', async () => {
      const own = withSync(
        syncFlows(
          { decision: 'allowed' },
          {
            runSync: vi.fn(async () =>
              syncResult({ status: 'partial', totalSuccess: 9, totalFailed: 3 }),
            ),
          },
        ),
      );

      const result = await own.execute(sync, context());

      expect(result.status).toBe('failed');
      expect(result.error).toBe(
        'Sync step "Step" ran "Accounts to dev" into dev and did not complete: ' +
          '9 records written, 3 failed and 0 skipped of 12 read.',
      );
      expect(result.output).toMatchObject({ totalFailed: 3 });
    });

    it('ends cancelled, without a retry, when its run is cancelled from Live Operations', async () => {
      const runSync = vi.fn(async () =>
        syncResult({ status: 'partial', cancelled: true, error: 'Cancelled by the user.' }),
      );
      const own = withSync(syncFlows({ decision: 'allowed' }, { runSync }));

      const result = await own.execute({ ...sync, retries: 2 }, context());

      expect(result.cancelled).toBe(true);
      expect(runSync).toHaveBeenCalledTimes(1);
    });

    it('fails, without running, a configuration deleted after the pipeline started', async () => {
      const runSync = vi.fn(async () => syncResult());
      const own = withSync(
        syncFlows({ decision: 'allowed' }, { runSync, savedSyncConfig: () => undefined }),
      );

      const result = await own.execute(sync, context());

      expect(result.status).toBe('failed');
      expect(result.error).toContain('is no longer saved');
      expect(runSync).not.toHaveBeenCalled();
    });

    it('describes each saved configuration with what the guard does with it', () => {
      const flowsForSync = syncFlows(
        { decision: 'asks' },
        {
          listSyncConfigs: () => [
            savedConfig(),
            savedConfig({ id: 'cfg-old', name: 'Old', dryRun: true }),
            'not a configuration',
          ],
        },
      );

      expect(describeSyncConfigs(flowsForSync)).toEqual([
        {
          id: 'cfg-1',
          name: 'Accounts to dev',
          valid: true,
          sourceOrgId: 'org-a',
          targetOrgId: 'org-b',
          guard: 'asks',
        },
        { id: 'cfg-old', name: 'Old', valid: false },
      ]);
    });
  });

  describe('Backup', () => {
    it('is refused before the run until it names a known org and the API names of its objects', () => {
      expect(executor.check(step('backup', { objects: ['Account'] }))).toBe(
        'Backup step "Step" names no org: choose the org it backs up.',
      );
      expect(executor.check(step('backup', { orgId: 'org-z', objects: ['Account'] }))).toBe(
        'Backup step "Step" names an org SandForge does not know (org-z): connect it, or choose the org it backs up again.',
      );
      expect(executor.check(step('backup', { orgId: 'org-a' }))).toContain('names no object');
      expect(executor.check(step('backup', { orgId: 'org-a', objects: ['__custom__'] }))).toBe(
        'Backup step "Step" names what is not an object API name: __custom__.',
      );
      const tooMany = Array.from({ length: 101 }, (_, i) => `Object${i}`);
      expect(executor.check(step('backup', { orgId: 'org-a', objects: tooMany }))).toContain(
        'at most 100',
      );
      expect(
        executor.check(step('backup', { orgId: 'org-a', objects: ['Account'] })),
      ).toBeUndefined();
    });

    it("takes a snapshot through DataOps's flow and says what it holds", async () => {
      const signal = new AbortController().signal;
      const result = await executor.execute(
        step('backup', { orgId: 'org-a', objects: ['Account'] }),
        context({ signal }),
      );

      expect(flows.backup).toHaveBeenCalledWith(
        { operationId: 'snap-1', orgId: 'org-a', objects: ['Account'] },
        expect.any(AbortSignal),
      );
      expect(result.status).toBe('completed');
      expect(result.summary).toBe('Backed up 3 records of 1 object from uat.');
      expect(result.output).toMatchObject({
        operationId: 'snap-1',
        totalRecords: 3,
        partial: false,
      });
    });

    it('says a snapshot is only part of an object the org holds more of', async () => {
      flows.backup = vi.fn(async (request) =>
        snapshot(request.operationId, [
          ['Account', 2000, true],
          ['Contact', 1],
        ]),
      );
      const result = await executor.execute(
        step('backup', { orgId: 'org-a', objects: ['Account', 'Contact'] }),
        context(),
      );

      expect(result.summary).toBe(
        'Backed up 2001 records of 2 objects from uat; only part of Account: the org holds more rows than one backup reads.',
      );
    });

    it('takes a new snapshot on each retry, as DataOps refuses an id it has seen', async () => {
      flows.backup = vi
        .fn()
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockImplementation(async (request: { operationId: string }) =>
          snapshot(request.operationId, [['Account', 1]]),
        );

      const result = await executor.execute(
        step('backup', { orgId: 'org-a', objects: ['Account'] }, { retries: 1 }),
        context(),
      );

      expect(result.status).toBe('completed');
      expect(vi.mocked(flows.backup).mock.calls.map(([request]) => request.operationId)).toEqual([
        'snap-1',
        'snap-2',
      ]);
    });

    it('takes no new snapshot when the one it took was cancelled from Live Operations', async () => {
      flows.backup = vi
        .fn()
        .mockRejectedValue(new StepCancelledError('Backup was cancelled before it finished.'));

      const result = await executor.execute(
        step('backup', { orgId: 'org-a', objects: ['Account'] }, { retries: 2 }),
        context(),
      );

      expect(flows.backup).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        status: 'failed',
        error: 'Backup was cancelled before it finished.',
        cancelled: true,
      });
    });
  });

  describe('Compare', () => {
    it('is refused before the run without two different known orgs and a type', () => {
      expect(executor.check(step('compare', { targetOrgId: 'org-b', types: ['Flow'] }))).toBe(
        'Compare step "Step" names no org: choose the org it compares from.',
      );
      expect(
        executor.check(
          step('compare', { sourceOrgId: 'org-a', targetOrgId: 'org-a', types: ['Flow'] }),
        ),
      ).toBe('Compare step "Step" compares an org with itself: choose two different orgs.');
      expect(executor.check(step('compare', { sourceOrgId: 'org-a', targetOrgId: 'org-b' }))).toBe(
        'Compare step "Step" names no component type: choose what it compares.',
      );
      expect(
        executor.check(
          step('compare', { sourceOrgId: 'org-a', targetOrgId: 'org-b', types: ['Flow'] }),
        ),
      ).toBeUndefined();
    });

    it("runs the Compare page's diff and keeps its counts, not its diffs", async () => {
      const result = await executor.execute(
        step('compare', { sourceOrgId: 'org-a', targetOrgId: 'org-b', types: ['ApexClass'] }),
        context(),
      );

      expect(flows.compare).toHaveBeenCalledWith(
        {
          sourceOrgId: 'org-a',
          targetOrgId: 'org-b',
          types: ['ApexClass'],
        },
        expect.any(AbortSignal),
      );
      expect(result.summary).toBe(
        'Compared 1 component type of uat with dev: 1 only in uat, 2 only in dev, 3 modified, 5 unchanged, 1 not compared.',
      );
      expect(result.output).not.toHaveProperty('diffs');
      expect(result.output).toMatchObject({ summary: { modified: 3 } });
    });

    it('hands on how many components differ, for a Condition after it, leaving out what was not compared', async () => {
      const result = await executor.execute(
        step('compare', { sourceOrgId: 'org-a', targetOrgId: 'org-b', types: ['ApexClass'] }),
        context(),
      );

      // 1 only in the source, 2 only in the target, 3 modified.
      expect(result.output).toMatchObject({ variables: { compareDifferenceCount: '6' } });
    });

    it('hands the comparison the signal that stops the step, so a run given up on stops reading the orgs', async () => {
      // The comparison took no signal: a run cancelled, or out of time, moved
      // on while it went on listing and reading both orgs to its end.
      let given: AbortSignal | undefined;
      flows.compare = vi.fn((_request, signal?: AbortSignal) => {
        given = signal;
        return new Promise<never>(() => {});
      });
      const run = new AbortController();

      const comparing = executor.execute(
        step('compare', { sourceOrgId: 'org-a', targetOrgId: 'org-b', types: ['Flow'] }),
        context({ signal: run.signal }),
      );
      await vi.waitFor(() => expect(flows.compare).toHaveBeenCalled());
      expect(given?.aborted).toBe(false);
      run.abort();

      expect((await comparing).error).toBe('Step "Step" was stopped before it finished.');
      expect(given?.aborted).toBe(true);
    });
  });

  describe('Pre-check', () => {
    it('is refused before the run when it names a check the Monitor does not read', () => {
      expect(
        executor.check(step('precheck', { orgId: 'org-a', checks: ['rowCount', 'apiLimits'] })),
      ).toBe(
        'Pre-check step "Step" names checks SandForge does not have: rowCount. It can check apiLimits, storage, recentErrors, failedJobs.',
      );
      expect(executor.check(step('precheck', { orgId: 'org-a', checks: [] }))).toContain(
        'names no check',
      );
      expect(
        executor.check(step('precheck', { orgId: 'org-a', checks: ['storage', 'storage'] })),
      ).toBe('Pre-check step "Step" names the same check twice.');
    });

    it('reads only the signals it names, and hands on what it read', async () => {
      flows.readOrgHealth = vi.fn(async () => [
        signal({ name: 'apiLimits', status: 'warning', message: 'API usage at 65%', percent: 65 }),
        signal({ name: 'activeJobs', message: '0 active, 0 failed of 12 recent jobs', count: 0 }),
      ]);

      const result = await executor.execute(
        step('precheck', { orgId: 'org-a', checks: ['apiLimits', 'failedJobs'] }),
        context(),
      );

      expect(flows.readOrgHealth).toHaveBeenCalledWith('org-a', ['apiLimits', 'activeJobs']);
      expect(result.status).toBe('completed');
      expect(result.summary).toBe(
        '2 checks passed on uat: API usage at 65% (warning); 0 active, 0 failed of 12 recent jobs.',
      );
      expect(result.output?.['variables']).toEqual({ apiUsagePercent: '65', failedJobCount: '0' });
    });

    it('fails the step on a critical reading, and on one it could not read', async () => {
      flows.readOrgHealth = vi.fn(async () => [
        signal({ name: 'apiLimits', status: 'critical', message: 'API usage at 91%', percent: 91 }),
        signal({ name: 'storage', status: 'unknown', message: 'Unable to fetch storage' }),
      ]);

      const result = await executor.execute(
        step('precheck', { orgId: 'org-a', checks: ['apiLimits', 'storage'] }, { name: 'Gate' }),
        context(),
      );

      expect(result.status).toBe('failed');
      expect(result.error).toBe(
        'Pre-check "Gate" failed on uat: API usage at 91% (critical); Unable to fetch storage (could not be read).',
      );
      // What could not be read hands nothing on.
      expect(result.output?.['variables']).toEqual({ apiUsagePercent: '91' });
    });
  });

  describe('Notification', () => {
    it('is refused before the run without a message, or with no window to show it in', () => {
      expect(executor.check(step('notification', { message: ' ' }))).toBe(
        'Notification step "Step" has no message: write what the notification says.',
      );
      expect(executor.check(step('notification', { message: 'x'.repeat(501) }))).toContain(
        'longer than 500 characters',
      );

      const headless = new StepExecutor();
      registerPipelineSteps(headless, runners({ notify: undefined }));
      expect(headless.check(step('notification', { message: 'Done' }))).toBe(
        'Notification step "Step" cannot show a notification: there is no VS Code window to show it in.',
      );
    });

    it("shows its message in VS Code under the pipeline's name, and does not wait for it to be read", async () => {
      const result = await executor.execute(
        step('notification', { message: 'Snapshot taken.' }),
        context(),
      );

      expect(flows.notify).toHaveBeenCalledWith('Nightly check: Snapshot taken.');
      expect(result.status).toBe('completed');
      expect(result.summary).toBe('Showed a notification in VS Code.');
    });
  });
});

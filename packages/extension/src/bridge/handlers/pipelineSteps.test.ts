import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CompareResult, PipelineStep, PipelineStepType } from '@sandforge/shared';
import { StepCancelledError, StepExecutor } from '../../modules/automation/StepExecutor.js';
import type { StepContext } from '../../modules/automation/StepExecutor.js';
import type { HealthSignal } from '../../modules/monitor/HealthCheck.js';
import type { HealthSignalName } from '../../modules/monitor/MonitorOpsFactory.js';
import { registerPipelineSteps } from './pipelineSteps.js';
import type { PipelineStepRunners } from './pipelineSteps.js';

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
    it.each(['seed', 'sync', 'restore', 'anonymize', 'delete'] as const)(
      'still refuses a %s step: it writes to an org, and a pipeline runs unattended',
      (type) => {
        expect(executor.check(step(type, {}))).toContain('cannot run in a pipeline yet');
      },
    );
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

import { describe, expect, it, vi } from 'vitest';
import type {
  GuardTier,
  PipelineStep,
  PipelineStepResult,
  PipelineStepType,
  RewindResult,
  SeedExecutionResult,
  SeedTemplate,
} from '@sandforge/shared';
import {
  PREBUILT_SEED_TEMPLATES,
  rewindGrantDigest,
  pipelineRewindStepConfigSchema,
} from '@sandforge/shared';

import { StepCancelledError, StepExecutor } from '../../modules/automation/StepExecutor.js';
import type { StepCheckContext, StepContext } from '../../modules/automation/StepExecutor.js';
import { CheckpointStepRefused } from './CheckpointHandler.js';
import type { MaskingResult } from './anonymizePipeline.js';
import {
  describeMaskingTemplates,
  describeSeedTemplates,
  registerPipelineSteps,
  rewindStepInfo,
} from './pipelineSteps.js';
import type { PipelineStepRunners, RewindCheckpoint } from './pipelineSteps.js';

/** The orgs of the registry, by id: their names and the guard's tier of each. */
const ORGS: Record<string, { name: string; tier: GuardTier; organizationId: string }> = {
  'org-dev': { name: 'dev', tier: 'development', organizationId: '00D000000000001AAA' },
  'org-scratch': { name: 'scratch', tier: 'scratch', organizationId: '00D000000000002AAA' },
  'org-uat': { name: 'uat', tier: 'staging', organizationId: '00D000000000003AAA' },
  'org-prod': { name: 'prod', tier: 'production', organizationId: '00D000000000004AAA' },
};

const CHECKPOINT_ID = 'ck-20261030-020000-abcd';

/** A Seed template the Seed page saved, read from a shipped one. */
const SAVED: SeedTemplate = { ...PREBUILT_SEED_TEMPLATES[0], id: 'tpl-saved', name: 'Saved' };

/** The same template, one of its rules an AI rule. */
const WITH_AI: SeedTemplate = {
  ...SAVED,
  id: 'tpl-ai',
  name: 'With AI',
  objects: SAVED.objects.map((object, index) =>
    index === 0
      ? {
          ...object,
          fieldRules: object.fieldRules.map((rule, at) =>
            at === 0 ? { ...rule, ruleType: 'ai_generate' as const } : rule,
          ),
        }
      : object,
  ),
};

const SEED_TEMPLATES: Record<string, unknown> = {
  'tpl-saved': SAVED,
  'tpl-ai': WITH_AI,
  'tpl-broken': { id: 'tpl-broken', name: 'Broken', objects: 'none' },
};

function seedResult(overrides: Partial<SeedExecutionResult> = {}): SeedExecutionResult {
  return {
    templateId: 'tpl-saved',
    operationId: 'run-1',
    status: 'success',
    objectResults: [
      {
        objectApiName: 'Account',
        recordsCreated: 6,
        recordsFailed: 0,
        createdIds: [],
        errors: [],
      },
    ],
    totalRecordsCreated: 6,
    totalRecordsFailed: 0,
    duration: 10,
    timestamp: '2026-10-30T02:00:00.000Z',
    ...overrides,
  };
}

function maskingResult(overrides: Partial<MaskingResult> = {}): MaskingResult {
  return {
    templateId: 'tpl-gdpr-standard',
    status: 'success',
    recordsProcessed: 6,
    recordsFailed: 0,
    recordsNotMasked: 0,
    objects: [{ objectApiName: 'Contact', total: 6, processed: 6, failed: 0, notMasked: 0 }],
    message: 'Masked',
    errors: [],
    fieldsNotFound: [],
    snapshot: { operationId: 'snap-1', totalRecords: 6 },
    ...overrides,
  };
}

function rewindResult(overrides: Partial<RewindResult> = {}): RewindResult {
  return {
    checkpointId: CHECKPOINT_ID,
    rewindId: 'rw-20261030-020100-ef01',
    status: 'success',
    deleted: [{ objectApiName: 'Account', planned: 2, deleted: 2, alreadyGone: 0 }],
    restored: [{ objectApiName: 'Case', planned: 1, restored: 1, keptChanged: 0 }],
    undeleted: [{ objectApiName: 'Contact', planned: 1, undeleted: 1, alreadyBack: 0 }],
    residual: [],
    passes: 1,
    undo: { until: '2026-11-14T02:01:00.000Z', cannot: [] },
    apiRequests: { used: 12, leftToday: 14_000 },
    finishedAt: '2026-10-30T02:01:00.000Z',
    ...overrides,
  } as unknown as RewindResult;
}

/** The checkpoints kept on this machine, as read before a check. */
const KEPT: Record<string, RewindCheckpoint> = {
  [CHECKPOINT_ID]: {
    kept: true,
    organizationId: '00D000000000001',
    name: 'Baseline',
    valid: true,
  },
};

function runners(overrides: Partial<PipelineStepRunners> = {}): PipelineStepRunners {
  return {
    orgName: (orgId) => ORGS[orgId]?.name,
    newId: () => 'id-1',
    backup: vi.fn(),
    compare: vi.fn(),
    readOrgHealth: vi.fn(),
    orgTier: (orgId) => ORGS[orgId]?.tier,
    organizationIdsOf: (orgId) => (ORGS[orgId] ? [ORGS[orgId].organizationId] : []),
    pipelineId: 'p-1',
    trigger: 'schedule',
    savedSeedTemplate: (id) => SEED_TEMPLATES[id] as SeedTemplate | undefined,
    listSeedTemplates: () => Object.values(SEED_TEMPLATES),
    seed: vi.fn(async () => ({
      operationId: 'op-seed',
      runId: 'run-1',
      result: seedResult(),
      automation: [],
      warnings: [],
    })),
    maskingTemplates: () => [
      {
        id: 'tpl-gdpr-standard',
        name: 'GDPR Standard',
        builtIn: true,
        rules: [
          { fieldPattern: 'Contact.Email' },
          { fieldPattern: 'Contact.Phone' },
          { fieldPattern: 'Lead.Email' },
        ],
      },
      { id: 'tpl-mine', name: 'Mine', builtIn: false, rules: [{ fieldPattern: 'Case.Subject' }] },
    ],
    anonymize: vi.fn(async () => ({ operationId: 'op-mask', result: maskingResult() })),
    takeCheckpoint: vi.fn(async () => ({
      operationId: 'op-take',
      checkpointId: CHECKPOINT_ID,
      name: 'Nightly 2026-10-30 02:00 UTC',
      records: 1200,
      objects: 3,
      bytes: 3 * 1024 * 1024,
      movedWhileTaken: { changed: 0, deleted: 0, created: 0 },
    })),
    rewindGrant: vi.fn((_pipelineId, step) => {
      const config = pipelineRewindStepConfigSchema.safeParse(step.config);
      return config.success && config.data.maxRecords === 100
        ? {
            grant: {
              organizationId: '00D000000000001AAA',
              checkpointId: CHECKPOINT_ID,
              digest: rewindGrantDigest(config.data),
              grantedAt: '2026-10-29T09:00:00.000Z',
            },
          }
        : {
            refusal: (config.success && config.data.maxRecords === 99 ? 'changed' : 'never') as
              'changed' | 'never',
          };
    }),
    checkpointKept: (id) => KEPT[id] ?? { kept: false },
    rewind: vi.fn(async () => ({
      operationId: 'op-rewind',
      checkpointId: CHECKPOINT_ID,
      result: rewindResult(),
      notes: [],
      estimate: {} as never,
    })),
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

/** Where a step sits: after the steps `before`. */
function placed(target: PipelineStep, before: PipelineStepType[] = []): StepCheckContext {
  const steps = [...before.map((type) => step(type, {}, { id: `b-${type}` })), target];
  return { steps, index: steps.length - 1, declared: new Set() };
}

function context(previous: PipelineStepResult[] = []): StepContext {
  return {
    variables: {},
    previousResults: previous,
    pipelineId: 'p-1',
    pipelineName: 'Nightly reset',
    runId: 'run-1',
  };
}

/** An Approval step's result, approved or not. */
function approval(approved: boolean): PipelineStepResult {
  return {
    stepId: 'b-approval',
    stepName: 'Approve',
    stepType: 'approval',
    status: approved ? 'completed' : 'failed',
    approval: { decision: approved ? 'approved' : 'rejected', at: '2026-10-30T01:59:00.000Z' },
  };
}

function executorWith(flows: PipelineStepRunners): StepExecutor {
  const executor = new StepExecutor();
  registerPipelineSteps(executor, flows);
  return executor;
}

const SEED = { orgId: 'org-dev', templateId: 'tpl-saved' };
const MASK = { orgId: 'org-dev', templateId: 'tpl-gdpr-standard' };
const REWIND = { orgId: 'org-dev', checkpointId: CHECKPOINT_ID, maxRecords: 100 };

describe('the Seed step', () => {
  it('runs with a saved template, and with one SandForge ships, into a development org', () => {
    const executor = executorWith(runners());
    expect(executor.check(step('seed', SEED), placed(step('seed', SEED)))).toBeUndefined();
    const shipped = { orgId: 'org-scratch', templateId: PREBUILT_SEED_TEMPLATES[1].id };
    expect(executor.check(step('seed', shipped), placed(step('seed', shipped)))).toBeUndefined();
  });

  it.each([
    [{ templateId: 'tpl-saved' }, 'names no org'],
    [{ orgId: 'org-dev' }, 'names no Seed template'],
    [{ orgId: 'org-dev', templateId: 'tpl-gone' }, 'No Seed template is saved under tpl-gone'],
    [{ orgId: 'org-dev', templateId: 'tpl-broken' }, 'no longer validates'],
    [{ orgId: 'org-dev', templateId: 'tpl-ai' }, 'with AI rules'],
  ])('is refused before the run for %j', (config, words) => {
    const target = step('seed', config);
    expect(executorWith(runners()).check(target, placed(target))).toContain(words);
  });

  it('is refused with retries, where a Backup with retries runs', () => {
    const executor = executorWith(runners());
    const seed = step('seed', SEED, { retries: 1 });
    expect(executor.check(seed, placed(seed))).toContain('a second set of records');
    const backup = step('backup', { orgId: 'org-dev', objects: ['Account'] }, { retries: 1 });
    expect(executor.check(backup, placed(backup))).toBeUndefined();
  });

  it('is refused on a production org whatever an Approval before it answers', () => {
    const target = step('seed', { ...SEED, orgId: 'org-prod' });
    const check = executorWith(runners()).check(target, placed(target, ['approval']));
    expect(check).toContain('a pipeline never seeds one, whatever an Approval step answers');
  });

  it('needs an Approval before it on a sandbox marked Staging, and runs with one', () => {
    const executor = executorWith(runners());
    const target = step('seed', { ...SEED, orgId: 'org-uat' });
    expect(executor.check(target, placed(target))).toContain('put an Approval step before it');
    expect(executor.check(target, placed(target, ['approval']))).toBeUndefined();
  });

  it("answers the seed's questions with the Approval's answer, and no with none", async () => {
    const flows = runners();
    const executor = executorWith(flows);
    await executor.execute(step('seed', SEED), context());
    await executor.execute(step('seed', SEED), context([approval(true)]));
    const seed = vi.mocked(flows.seed!);
    expect(seed.mock.calls.map(([request]) => request.answer.approved)).toEqual([false, true]);
    expect(seed.mock.calls[0][0]).toMatchObject({
      orgId: 'org-dev',
      templateId: 'tpl-saved',
      pipeline: { name: 'Nightly reset' },
    });
  });

  it('says what it created and where it is taken back from', async () => {
    const result = await executorWith(runners()).execute(step('seed', SEED), context());
    expect(result.status).toBe('completed');
    expect(result.summary).toBe(
      "Seeded 6 records into dev: take them back from Seed's Recent runs.",
    );
    expect(result.output).toMatchObject({ runId: 'run-1', totalRecordsCreated: 6 });
  });

  it('fails, with the counts, on a seed that did not complete', async () => {
    const flows = runners({
      seed: vi.fn(async () => ({
        operationId: 'op',
        runId: 'run-2',
        result: seedResult({ status: 'partial', totalRecordsCreated: 4, totalRecordsFailed: 2 }),
        automation: [],
        warnings: [],
      })),
    });
    const result = await executorWith(flows).execute(step('seed', SEED), context());
    expect(result.status).toBe('failed');
    expect(result.error).toContain('4 records created, 2 refused');
  });

  it('fails with the refusal, never tried again, when the seed is refused before it writes', async () => {
    const seed = vi.fn(async () => {
      throw Object.assign(new Error('The storage could not be read. Nothing was written.'), {
        code: 'SEED_CONFIRMATION_UNAVAILABLE',
      });
    });
    const result = await executorWith(runners({ seed })).execute(step('seed', SEED), context());
    expect(seed).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('failed');
    expect(result.output).toMatchObject({ code: 'SEED_CONFIRMATION_UNAVAILABLE' });
    expect(result.error).toContain('Nothing was written.');
  });

  it('ends cancelled, naming what stays, when a cancel stops the seed', async () => {
    const flows = runners({
      seed: vi.fn(async () => ({
        operationId: 'op',
        runId: 'run-3',
        result: seedResult({ status: 'partial', cancelled: true, totalRecordsCreated: 3 }),
        automation: [],
        warnings: [],
      })),
    });
    const result = await executorWith(flows).execute(step('seed', SEED), context());
    expect(result.cancelled).toBe(true);
    expect(result.error).toContain(
      "3 records in dev, which stay there; take them back from Seed's",
    );
  });
});

describe('the Anonymize step', () => {
  it('runs with a template DataOps ships, on one object and a condition', () => {
    const target = step('anonymize', { ...MASK, object: 'Contact', where: "Title = 'X'" });
    expect(executorWith(runners()).check(target, placed(target))).toBeUndefined();
  });

  it.each([
    [{ orgId: 'org-dev' }, 'names no masking template'],
    [{ orgId: 'org-dev', templateId: 'tpl-gone' }, 'No masking template is shipped or saved'],
    [{ ...MASK, where: "Title = 'X'" }, 'filters the rows of one object'],
    [{ ...MASK, orgId: 'org-prod' }, 'a pipeline never masks one'],
    [{ ...MASK, orgId: 'org-uat' }, 'put an Approval step before it'],
  ])('is refused before the run for %j', (config, words) => {
    const target = step('anonymize', config);
    expect(executorWith(runners()).check(target, placed(target))).toContain(words);
  });

  it('reads an empty object and condition, as the page clears them, as none', () => {
    const target = step('anonymize', { ...MASK, object: '', where: '  ' });
    expect(executorWith(runners()).check(target, placed(target))).toBeUndefined();
  });

  it('is refused with retries', () => {
    const target = step('anonymize', MASK, { retries: 2 });
    expect(executorWith(runners()).check(target, placed(target))).toContain('Set its retries to 0');
  });

  it('names the snapshot that keeps what it wrote over', async () => {
    const flows = runners();
    const result = await executorWith(flows).execute(
      step('anonymize', { ...MASK, object: 'Contact' }),
      context([approval(true)]),
    );
    expect(result.status).toBe('completed');
    expect(result.summary).toBe(
      'Masked 6 records in dev, every Contact row; the snapshot snap-1 keeps the values it ' +
        'wrote over, in clear, until it is deleted on the DataOps page, where a restore writes ' +
        'them back.',
    );
    expect(vi.mocked(flows.anonymize!).mock.calls[0][0]).toMatchObject({
      object: 'Contact',
      answer: { approved: true },
    });
  });

  it('fails with what is left by object when rows still hold their values', async () => {
    const flows = runners({
      anonymize: vi.fn(async () => ({
        operationId: 'op',
        result: maskingResult({
          status: 'partial',
          recordsProcessed: 4,
          recordsFailed: 2,
          recordsNotMasked: 2,
          objects: [{ objectApiName: 'Contact', total: 6, processed: 4, failed: 2, notMasked: 2 }],
        }),
      })),
    });
    const result = await executorWith(flows).execute(step('anonymize', MASK), context());
    expect(result.status).toBe('failed');
    expect(result.error).toContain('2 of Contact still hold their values');
  });

  it('fails with the refusal, naming the snapshot it took, when it is refused', async () => {
    const anonymize = vi.fn(async () => {
      throw Object.assign(new Error('Phone is not shown to the user. Nothing was masked.'), {
        code: 'MASKING_FIELDS_UNSEEN',
      });
    });
    const result = await executorWith(runners({ anonymize })).execute(
      step('anonymize', MASK),
      context(),
    );
    expect(result.status).toBe('failed');
    expect(result.output).toMatchObject({ code: 'MASKING_FIELDS_UNSEEN' });
  });
});

describe('the Checkpoint step', () => {
  it('runs on a development org, every object or the objects picked', () => {
    const executor = executorWith(runners());
    const everything = step('checkpoint', { orgId: 'org-dev', mode: 'everything' });
    expect(executor.check(everything)).toBeUndefined();
    const picked = step('checkpoint', { orgId: 'org-dev', mode: 'picked', objects: ['Account'] });
    expect(executor.check(picked)).toBeUndefined();
  });

  it('is refused on a production org, and with picked but no objects', () => {
    const executor = executorWith(runners());
    expect(executor.check(step('checkpoint', { orgId: 'org-prod', mode: 'everything' }))).toContain(
      'SandForge takes no checkpoint of one',
    );
    expect(executor.check(step('checkpoint', { orgId: 'org-dev', mode: 'picked' }))).toContain(
      'Name the objects with "picked"',
    );
  });

  it('says what it took and the space it takes, and hands on the checkpoint', async () => {
    const flows = runners();
    const result = await executorWith(flows).execute(
      step('checkpoint', { orgId: 'org-dev', mode: 'everything', name: 'Nightly {date}' }),
      context(),
    );
    expect(result.status).toBe('completed');
    expect(result.summary).toBe(
      "Took the checkpoint 'Nightly 2026-10-30 02:00 UTC' of dev: 1200 records of 3 objects, " +
        '3.0 MB on this machine, kept 30 days.',
    );
    expect(result.output).toMatchObject({ checkpointId: CHECKPOINT_ID, records: 1200 });
    expect(vi.mocked(flows.takeCheckpoint!).mock.calls[0][0].origin).toEqual({
      pipeline: 'Nightly reset',
      step: 'Step',
      trigger: 'schedule',
    });
  });

  it('fails with the words of a refused take', async () => {
    const takeCheckpoint = vi.fn(async () => {
      throw new CheckpointStepRefused('LOCKED', 'A rewind of dev runs: try again once it ends.');
    });
    const result = await executorWith(runners({ takeCheckpoint })).execute(
      step('checkpoint', { orgId: 'org-dev', mode: 'everything' }),
      context(),
    );
    expect(result.status).toBe('failed');
    expect(result.error).toBe('A rewind of dev runs: try again once it ends.');
  });
});

describe('the Rewind step', () => {
  it('runs once confirmed for its configuration, its checkpoint kept and of its org', () => {
    expect(executorWith(runners()).check(step('rewind', REWIND))).toBeUndefined();
  });

  it('is refused before the run, never confirmed, and confirmed before a change', () => {
    const executor = executorWith(runners());
    expect(executor.check(step('rewind', { ...REWIND, maxRecords: 50 }))).toBe(
      'Rewind step "Step" has never been confirmed: open it and type the org\'s alias. No record was written.',
    );
    expect(executor.check(step('rewind', { ...REWIND, maxRecords: 99 }))).toContain(
      'has not been confirmed since it was changed',
    );
  });

  it('is refused on a production org, without its bound, for latest, and with retries', () => {
    const executor = executorWith(runners());
    expect(executor.check(step('rewind', { ...REWIND, orgId: 'org-prod' }))).toContain(
      'SandForge rewinds none',
    );
    expect(
      executor.check(step('rewind', { orgId: 'org-dev', checkpointId: CHECKPOINT_ID })),
    ).toContain('maxRecords');
    expect(executor.check(step('rewind', { ...REWIND, checkpointId: 'latest' }))).toContain(
      'never latest',
    );
    expect(executor.check(step('rewind', REWIND, { retries: 1 }))).toContain(
      'Set its retries to 0',
    );
  });

  it.each([
    [{ kept: false } as RewindCheckpoint, 'not kept on this machine'],
    [
      {
        kept: true,
        organizationId: '00D000000000001',
        name: 'Baseline',
        valid: false,
        why: 'refreshed',
      },
      'before its refresh',
    ],
    [
      { kept: true, organizationId: '00D000000000009', name: 'Baseline', valid: true },
      'which was taken of another org',
    ],
  ] as Array<[RewindCheckpoint, string]>)('is refused for its checkpoint: %j', (kept, words) => {
    const executor = executorWith(runners({ checkpointKept: () => kept }));
    expect(executor.check(step('rewind', REWIND))).toContain(words);
  });

  it('leaves its checkpoint to the run when it was not read for the check', () => {
    const executor = executorWith(runners({ checkpointKept: () => undefined }));
    expect(executor.check(step('rewind', REWIND))).toBeUndefined();
  });

  it('refuses at the run, before any request, when its confirmation was taken back meanwhile', async () => {
    const rewind = vi.fn();
    const flows = runners({ rewind, rewindGrant: () => ({ refusal: 'changed' }) });
    const handler = new StepExecutor();
    registerPipelineSteps(handler, flows);
    const result = await handler.getExecutor('rewind')(step('rewind', REWIND), context());
    expect(rewind).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.output).toMatchObject({ code: 'NOT_CONFIRMED' });
  });

  it('rewinds with the confirmation it was given, and says what it did and until when Undo takes it back', async () => {
    const flows = runners();
    const result = await executorWith(flows).execute(step('rewind', REWIND), context());
    expect(result.status).toBe('completed');
    expect(result.summary).toBe(
      'Rewound dev to the checkpoint ck-20261030-020000-abcd: 2 deleted, 1 given their values ' +
        'back, 1 brought back from the recycle bin, with 12 API requests; Undo on the ' +
        'Checkpoints page takes it back until 2026-11-14T02:01:00.000Z.',
    );
    const request = vi.mocked(flows.rewind!).mock.calls[0][0];
    expect(request.grant.grantedAt).toBe('2026-10-29T09:00:00.000Z');
    expect(request.origin).toEqual({
      pipeline: 'Nightly reset',
      step: 'Step',
      trigger: 'schedule',
    });
  });

  it('fails with the bound it met, the rewind having written nothing', async () => {
    const rewind = vi.fn(async () => {
      throw new CheckpointStepRefused(
        'TOO_MANY_TO_REWIND',
        "Rewind refused; it would rewind 4 records, past this step's limit of 2. No record was written.",
      );
    });
    const result = await executorWith(runners({ rewind })).execute(
      step('rewind', REWIND),
      context(),
    );
    expect(rewind).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('failed');
    expect(result.output).toMatchObject({ code: 'TOO_MANY_TO_REWIND' });
    expect(result.error).toContain("past this step's limit of 2");
  });

  it('fails with the counts of a rewind left untouched where nobody could be asked', async () => {
    const rewind = vi.fn(async () => {
      throw new CheckpointStepRefused(
        'UNDELETABLE_UNATTENDED',
        'The user may not delete the Account (2) record(s). No record was written.',
        rewindResult({ status: 'partial', deleted: [] }),
      );
    });
    const result = await executorWith(runners({ rewind })).execute(
      step('rewind', REWIND),
      context(),
    );
    expect(result.status).toBe('failed');
    expect(result.output).toMatchObject({ code: 'UNDELETABLE_UNATTENDED', deleted: 0 });
  });

  it('fails, with what still differs, on a rewind that did not complete', async () => {
    const rewind = vi.fn(async () => ({
      operationId: 'op',
      checkpointId: CHECKPOINT_ID,
      result: rewindResult({
        status: 'partial',
        residual: [{ objectApiName: 'Case', reason: 'refused', count: 3, ids: [] }],
      } as Partial<RewindResult>),
      notes: [],
      estimate: {} as never,
    }));
    const result = await executorWith(runners({ rewind })).execute(
      step('rewind', REWIND),
      context(),
    );
    expect(result.status).toBe('failed');
    expect(result.error).toContain('3 records still differ from the checkpoint');
  });

  it('ends cancelled when a Stop ended the rewind once it had written', async () => {
    const rewind = vi.fn(async () => ({
      operationId: 'op',
      checkpointId: CHECKPOINT_ID,
      result: rewindResult({ status: 'cancelled' }),
      notes: [],
      estimate: {} as never,
    }));
    const result = await executorWith(runners({ rewind })).execute(
      step('rewind', REWIND),
      context(),
    );
    expect(result.cancelled).toBe(true);
    expect(result.error).toContain('Undo on the Checkpoints page takes it back');
  });

  it('lets a stop before it wrote end the step cancelled, never tried again', async () => {
    const rewind = vi.fn(async () => {
      throw new StepCancelledError('The rewind was stopped before it wrote anything.');
    });
    const result = await executorWith(runners({ rewind })).execute(
      step('rewind', REWIND),
      context(),
    );
    expect(rewind).toHaveBeenCalledTimes(1);
    expect(result.cancelled).toBe(true);
  });
});

describe('the templates and steps the page checks against', () => {
  it('describes each Seed template, saved ones first, with whether it reads and holds an AI rule', () => {
    const described = describeSeedTemplates(runners());
    expect(described.slice(0, 3)).toEqual([
      { id: 'tpl-saved', name: 'Saved', builtIn: false, valid: true, usesAi: false },
      { id: 'tpl-ai', name: 'With AI', builtIn: false, valid: true, usesAi: true },
      { id: 'tpl-broken', name: 'Broken', builtIn: false, valid: false, usesAi: false },
    ]);
    expect(described.slice(3).map((template) => template.id)).toEqual(
      PREBUILT_SEED_TEMPLATES.map((template) => template.id),
    );
    expect(described.slice(3).every((t) => t.builtIn && t.valid && !t.usesAi)).toBe(true);
  });

  it('describes each masking template with the objects its rules name', () => {
    expect(describeMaskingTemplates(runners())).toEqual([
      {
        id: 'tpl-gdpr-standard',
        name: 'GDPR Standard',
        builtIn: true,
        objects: ['Contact', 'Lead'],
      },
      { id: 'tpl-mine', name: 'Mine', builtIn: false, objects: ['Case'] },
    ]);
  });

  it('describes a Rewind step with its checkpoint and its confirmation', () => {
    const flows = runners();
    expect(
      rewindStepInfo(flows, step('rewind', REWIND), KEPT[CHECKPOINT_ID], {
        grantedAt: '2026-10-29T09:00:00.000Z',
        matches: false,
      }),
    ).toEqual({
      stepId: 's-rewind',
      checkpointId: CHECKPOINT_ID,
      valid: true,
      granted: { at: '2026-10-29T09:00:00.000Z', digestMatches: false },
    });
    expect(rewindStepInfo(flows, step('rewind', REWIND), { kept: false }, undefined)).toEqual({
      stepId: 's-rewind',
      checkpointId: CHECKPOINT_ID,
      valid: false,
      why: 'missing',
    });
    expect(
      rewindStepInfo(flows, step('rewind', { orgId: 'org-dev' }), undefined, undefined),
    ).toEqual({ stepId: 's-rewind', valid: false, why: 'config' });
  });
});

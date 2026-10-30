import { describe, it, expect } from 'vitest';
import type {
  GuardTier,
  PipelineRewindStepInfo,
  PipelineStep,
  PipelineStepType,
  PipelineSyncConfigInfo,
} from '@sandforge/shared';
import {
  MAX_STEP_TIMEOUT_MS,
  blockedSteps,
  paletteBlocker,
  stepBlocker,
  typeBlocker,
} from './stepRunnability';
import type { StepPlace } from './stepRunnability';

function step(
  type: PipelineStepType,
  config: Record<string, unknown> = {},
  extra: Partial<PipelineStep> = {},
): PipelineStep {
  return {
    id: `id-${type}`,
    name: `name-${type}`,
    type,
    config,
    continueOnError: false,
    ...extra,
  };
}

/** The steps that write to an org and that the extension runs in no pipeline. */
const WRITE_STEPS: PipelineStepType[] = ['restore', 'delete'];

/** The step types SandForge no longer has, as a pipeline saved earlier holds them. */
const RETIRED = ['script', 'loop', 'parallel'];

/** The step types that run. */
const RUNNABLE: PipelineStepType[] = [
  'delay',
  'condition',
  'backup',
  'compare',
  'precheck',
  'notification',
  'approval',
  'sync',
  'seed',
  'anonymize',
  'checkpoint',
  'rewind',
];

/** Two orgs connected on this page. */
const ORGS = new Set(['org-a', 'org-b']);

describe('typeBlocker', () => {
  it('lets the twelve step types the extension runs through', () => {
    for (const type of RUNNABLE) {
      expect(typeBlocker(type)).toBeUndefined();
    }
  });

  it('refuses the steps that write to an org, for that reason', () => {
    for (const type of WRITE_STEPS) {
      expect(typeBlocker(type)).toBe('writesToOrg');
    }
  });

  it('marks the types SandForge no longer has as no longer supported', () => {
    for (const type of RETIRED) {
      expect(typeBlocker(type)).toBe('noLongerSupported');
    }
  });

  it('says a type the page has never heard of is one SandForge does not have', () => {
    expect(typeBlocker('dataops:backup')).toBe('unknownType');
  });
});

describe('paletteBlocker', () => {
  it('offers the steps a pipeline runs, Seed, Anonymize and Rewind among them, and neither Restore nor Delete', () => {
    for (const type of ['condition', 'approval', 'sync', 'backup', 'seed', 'anonymize'] as const) {
      expect(paletteBlocker(type)).toBeUndefined();
    }
    expect(paletteBlocker('checkpoint')).toBeUndefined();
    expect(paletteBlocker('rewind')).toBeUndefined();
    expect(paletteBlocker('restore')).toBe('writesToOrg');
    expect(paletteBlocker('delete')).toBe('writesToOrg');
  });
});

describe('stepBlocker', () => {
  it('lets a Delay step run once it has its seconds', () => {
    expect(stepBlocker(step('delay', { seconds: 30 }))).toBeUndefined();
    expect(stepBlocker(step('delay', { seconds: 0 }))).toBeUndefined();
  });

  it('reads durationMs when seconds is absent, as the extension does', () => {
    expect(stepBlocker(step('delay', { durationMs: 1500 }))).toBeUndefined();
  });

  it.each([
    ['no duration at all', {}],
    ['negative seconds', { seconds: -1 }],
    ['seconds as text', { seconds: '30' }],
    ['seconds that are not finite', { seconds: Number.NaN }],
    ['a wait past 24 days', { seconds: 24 * 24 * 60 * 60 + 1 }],
    ['a negative durationMs', { durationMs: -1 }],
  ])('asks a Delay step for its seconds when it has %s', (_label, config) => {
    expect(stepBlocker(step('delay', config))).toBe('delayNeedsSeconds');
  });

  it('keeps the type reason ahead of any configuration', () => {
    expect(stepBlocker(step('restore', { seconds: 30 }))).toBe('writesToOrg');
    expect(stepBlocker(step('script' as PipelineStepType, { seconds: 30 }))).toBe(
      'noLongerSupported',
    );
  });

  it('refuses a timeout a timer cannot hold, which fired after 1 ms', () => {
    const delay = { seconds: 1 };
    expect(stepBlocker(step('delay', delay, { timeout: MAX_STEP_TIMEOUT_MS }))).toBeUndefined();
    expect(stepBlocker(step('delay', delay, { timeout: 2 ** 31 }))).toBe('timeoutTooLong');
    expect(stepBlocker(step('delay', delay, { timeout: Number.POSITIVE_INFINITY }))).toBe(
      'timeoutTooLong',
    );
  });

  it('runs a Condition step only when it carries a condition the extension can evaluate', () => {
    const evaluable = { field: 'apiUsagePercent', operator: 'gt' as const, value: 60 };
    expect(stepBlocker(step('condition', {}, { condition: evaluable }))).toBeUndefined();
    expect(stepBlocker(step('condition'))).toBe('conditionNeedsCondition');
    // What the API Limit Monitoring template carried: an operator no condition knows.
    expect(
      stepBlocker(
        step(
          'condition',
          {},
          { condition: { field: 'apiUsagePercent', operator: '>' as 'gt', value: '80' } },
        ),
      ),
    ).toBe('conditionNeedsCondition');
  });

  it('asks a Backup step for a connected org and the API names of its objects', () => {
    expect(
      stepBlocker(step('backup', { orgId: 'org-a', objects: ['Account', 'My_Obj__c'] }), ORGS),
    ).toBeUndefined();
    expect(stepBlocker(step('backup', { objects: ['Account'] }), ORGS)).toBe('needsOrg');
    expect(stepBlocker(step('backup', { orgId: 'org-z', objects: ['Account'] }), ORGS)).toBe(
      'orgNotConnected',
    );
    expect(stepBlocker(step('backup', { orgId: 'org-a', objects: [] }), ORGS)).toBe(
      'backupNeedsObjects',
    );
    expect(stepBlocker(step('backup', { orgId: 'org-a', objects: ['__custom__'] }), ORGS)).toBe(
      'backupNeedsObjects',
    );
  });

  it('asks a Compare step for two different connected orgs and at least one type', () => {
    const compare = (config: Record<string, unknown>) => stepBlocker(step('compare', config), ORGS);
    expect(
      compare({ sourceOrgId: 'org-a', targetOrgId: 'org-b', types: ['ApexClass'] }),
    ).toBeUndefined();
    expect(compare({ sourceOrgId: 'org-a', types: ['ApexClass'] })).toBe('compareNeedsOrgs');
    expect(compare({ sourceOrgId: 'org-a', targetOrgId: 'org-a', types: ['ApexClass'] })).toBe(
      'compareNeedsOrgs',
    );
    expect(compare({ sourceOrgId: 'org-a', targetOrgId: 'org-z', types: ['ApexClass'] })).toBe(
      'orgNotConnected',
    );
    expect(compare({ sourceOrgId: 'org-a', targetOrgId: 'org-b', types: [] })).toBe(
      'compareNeedsTypes',
    );
  });

  it('asks a Pre-check step for an org and only the checks it can run', () => {
    const precheck = (config: Record<string, unknown>) =>
      stepBlocker(step('precheck', config), ORGS);
    expect(precheck({ orgId: 'org-a', checks: ['apiLimits', 'failedJobs'] })).toBeUndefined();
    expect(precheck({ checks: ['apiLimits'] })).toBe('needsOrg');
    // What several Marketplace templates name: checks the extension does not have.
    expect(precheck({ orgId: 'org-a', checks: ['rowCount'] })).toBe('precheckNeedsChecks');
    expect(precheck({ orgId: 'org-a', checks: ['storage', 'storage'] })).toBe(
      'precheckNeedsChecks',
    );
  });

  it('asks a Notification step for the message it shows, up to 500 characters', () => {
    expect(stepBlocker(step('notification', { message: 'Refresh done' }))).toBeUndefined();
    expect(stepBlocker(step('notification', { message: '   ' }))).toBe('notificationNeedsMessage');
    expect(stepBlocker(step('notification', { message: 'x'.repeat(501) }))).toBe(
      'notificationNeedsMessage',
    );
  });

  it('asks a Condition testing a handed-on value for the step before it that hands it on', () => {
    const gate = step(
      'condition',
      {},
      { condition: { field: 'compareDifferenceCount', operator: 'gt', value: 10 } },
    );
    const compare = step('compare', {
      sourceOrgId: 'org-a',
      targetOrgId: 'org-b',
      types: ['Flow'],
    });
    expect(stepBlocker(gate, ORGS, { steps: [gate], index: 0 })).toBe('conditionNeedsCompare');
    expect(stepBlocker(gate, ORGS, { steps: [compare, gate], index: 1 })).toBeUndefined();

    const afterFailure = step(
      'condition',
      {},
      { condition: { field: 'previousStepStatus', operator: 'eq', value: 'failed' } },
    );
    expect(stepBlocker(afterFailure, ORGS, { steps: [afterFailure], index: 0 })).toBe(
      'conditionNeedsEarlierStep',
    );

    const usage = step(
      'condition',
      {},
      { condition: { field: 'apiUsagePercent', operator: 'gt', value: 60 } },
    );
    const storageCheck = step('precheck', { orgId: 'org-a', checks: ['storage'] });
    expect(stepBlocker(usage, ORGS, { steps: [storageCheck, usage], index: 1 })).toBe(
      'conditionNeedsPrecheck',
    );
    expect(
      stepBlocker(usage, ORGS, {
        steps: [usage],
        index: 0,
        declared: new Set(['apiUsagePercent']),
      }),
    ).toBeUndefined();
  });

  it('asks an Approval step for a wait from a minute to a day, and a short message', () => {
    expect(stepBlocker(step('approval'))).toBeUndefined();
    expect(stepBlocker(step('approval', { timeoutMinutes: 0 }))).toBe('approvalTimeout');
    expect(stepBlocker(step('approval', { timeoutMinutes: 1441 }))).toBe('approvalTimeout');
    expect(stepBlocker(step('approval', { message: 'x'.repeat(501) }))).toBe(
      'approvalMessageTooLong',
    );
  });

  describe('a Sync step', () => {
    const guarded: PipelineSyncConfigInfo = {
      id: 'cfg-prod',
      name: 'Into production',
      valid: true,
      sourceOrgId: 'org-a',
      targetOrgId: 'org-b',
      guard: 'asks',
    };
    const sandbox: PipelineSyncConfigInfo = { ...guarded, id: 'cfg-sbx', guard: 'allowed' };
    const refused: PipelineSyncConfigInfo = { ...guarded, id: 'cfg-del', guard: 'refused' };
    const broken: PipelineSyncConfigInfo = { id: 'cfg-old', name: 'Old', valid: false };
    const syncConfigs = [guarded, sandbox, refused, broken];
    const sync = (configId?: string) => step('sync', configId === undefined ? {} : { configId });
    const approval = step('approval');

    it('asks for a saved configuration, and refuses one deleted or no longer valid', () => {
      expect(stepBlocker(sync(), ORGS, { steps: [sync()], index: 0, syncConfigs })).toBe(
        'syncNeedsConfig',
      );
      expect(stepBlocker(sync('gone'), ORGS, { steps: [], index: 0, syncConfigs })).toBe(
        'syncConfigMissing',
      );
      expect(stepBlocker(sync('cfg-old'), ORGS, { steps: [], index: 0, syncConfigs })).toBe(
        'syncConfigInvalid',
      );
    });

    it('refuses a target the guard asks about unless an Approval step comes before it', () => {
      const alone = sync('cfg-prod');
      expect(stepBlocker(alone, ORGS, { steps: [alone], index: 0, syncConfigs })).toBe(
        'syncNeedsApproval',
      );
      expect(
        stepBlocker(alone, ORGS, { steps: [approval, alone], index: 1, syncConfigs }),
      ).toBeUndefined();
    });

    it('lets a sandbox target run with no Approval step', () => {
      const alone = sync('cfg-sbx');
      expect(stepBlocker(alone, ORGS, { steps: [alone], index: 0, syncConfigs })).toBeUndefined();
    });

    it('refuses what the guard refuses, an Approval before it or not', () => {
      const late = sync('cfg-del');
      expect(stepBlocker(late, ORGS, { steps: [approval, late], index: 1, syncConfigs })).toBe(
        'syncGuardRefuses',
      );
    });

    it('refuses a configuration whose org is not connected here', () => {
      const alone = sync('cfg-sbx');
      expect(
        stepBlocker(alone, new Set(['org-a']), { steps: [alone], index: 0, syncConfigs }),
      ).toBe('orgNotConnected');
    });

    it('leaves the rest to the extension until it has described the saved configurations', () => {
      expect(stepBlocker(sync('cfg-prod'), ORGS, { steps: [], index: 0 })).toBeUndefined();
    });
  });

  it('takes any org id when it does not know the connected orgs: the extension checks it', () => {
    expect(stepBlocker(step('backup', { orgId: 'org-z', objects: ['Account'] }))).toBeUndefined();
  });
});

describe('blockedSteps', () => {
  it('names each step that keeps the pipeline from running, in order, and no other', () => {
    const steps = [
      step('delay', { seconds: 5 }),
      step('delete'),
      step('delay'),
      step('condition'),
      step('backup', { orgId: 'org-a', objects: ['Account'] }),
    ];

    expect(blockedSteps(steps, ORGS)).toEqual([
      { stepId: 'id-delete', stepName: 'name-delete', stepType: 'delete', blocker: 'writesToOrg' },
      {
        stepId: 'id-delay',
        stepName: 'name-delay',
        stepType: 'delay',
        blocker: 'delayNeedsSeconds',
      },
      {
        stepId: 'id-condition',
        stepName: 'name-condition',
        stepType: 'condition',
        blocker: 'conditionNeedsCondition',
      },
    ]);
  });

  it('finds nothing to block in a pipeline of configured runnable steps', () => {
    expect(
      blockedSteps(
        [
          step('delay', { seconds: 1 }),
          step('precheck', { orgId: 'org-a', checks: ['apiLimits'] }),
          step('notification', { message: 'Done' }),
        ],
        ORGS,
      ),
    ).toEqual([]);
  });
});

/** The guard's tier of each org connected here. */
const TIERS: Record<string, GuardTier> = {
  'org-a': 'development',
  'org-b': 'staging',
  'org-p': 'production',
};
const CONNECTED = new Set(Object.keys(TIERS));

/** Where a step sits: after `before`, with what the extension describes. */
function placeOf(
  target: PipelineStep,
  before: PipelineStep[] = [],
  around: Omit<StepPlace, 'steps' | 'index'> = {},
): StepPlace {
  const steps = [...before, target];
  return {
    steps,
    index: steps.length - 1,
    tierOf: (orgId) => TIERS[orgId],
    seedTemplates: [
      { id: 'tpl-ok', name: 'Ok', builtIn: false, valid: true, usesAi: false },
      { id: 'tpl-ai', name: 'AI', builtIn: false, valid: true, usesAi: true },
      { id: 'tpl-broken', name: 'Broken', builtIn: false, valid: false, usesAi: false },
    ],
    maskingTemplates: [
      { id: 'tpl-gdpr-standard', name: 'GDPR', builtIn: true, objects: ['Contact', 'Lead'] },
    ],
    ...around,
  };
}

const APPROVAL = step('approval', {}, { id: 'id-approval' });

describe('the steps that seed and mask', () => {
  it.each([
    [{ templateId: 'tpl-ok' }, 'needsOrg'],
    [{ orgId: 'org-a' }, 'seedNeedsTemplate'],
    [{ orgId: 'org-a', templateId: 'tpl-gone' }, 'seedTemplateMissing'],
    [{ orgId: 'org-a', templateId: 'tpl-broken' }, 'seedTemplateInvalid'],
    [{ orgId: 'org-a', templateId: 'tpl-ai' }, 'seedTemplateUsesAi'],
    [{ orgId: 'org-p', templateId: 'tpl-ok' }, 'writeRefusedOnProduction'],
    [{ orgId: 'org-b', templateId: 'tpl-ok' }, 'writeNeedsApproval'],
  ])('blocks a Seed step for %j: %s', (config, blocker) => {
    const target = step('seed', config);
    expect(stepBlocker(target, CONNECTED, placeOf(target))).toBe(blocker);
  });

  it('runs a Seed step with a valid template in a development org, with no Approval', () => {
    const target = step('seed', { orgId: 'org-a', templateId: 'tpl-ok' });
    expect(stepBlocker(target, CONNECTED, placeOf(target))).toBeUndefined();
  });

  it('refuses a production org whatever comes before, and lets a Staging one run behind an Approval', () => {
    const prod = step('seed', { orgId: 'org-p', templateId: 'tpl-ok' });
    expect(stepBlocker(prod, CONNECTED, placeOf(prod, [APPROVAL]))).toBe(
      'writeRefusedOnProduction',
    );
    const staging = step('anonymize', { orgId: 'org-b', templateId: 'tpl-gdpr-standard' });
    expect(stepBlocker(staging, CONNECTED, placeOf(staging, [APPROVAL]))).toBeUndefined();
  });

  it('refuses retries on a step that writes, and leaves them to a Backup', () => {
    const seed = step('seed', { orgId: 'org-a', templateId: 'tpl-ok' }, { retries: 1 });
    expect(stepBlocker(seed, CONNECTED, placeOf(seed))).toBe('writeNoRetries');
    const backup = step('backup', { orgId: 'org-a', objects: ['Account'] }, { retries: 1 });
    expect(stepBlocker(backup, CONNECTED, placeOf(backup))).toBeUndefined();
  });

  it.each([
    [{ orgId: 'org-a' }, 'anonymizeNeedsTemplate'],
    [{ orgId: 'org-a', templateId: 'tpl-gone' }, 'anonymizeTemplateMissing'],
    [
      { orgId: 'org-a', templateId: 'tpl-gdpr-standard', where: "Title = 'x'" },
      'anonymizeFilterNeedsObject',
    ],
    [{ orgId: 'org-p', templateId: 'tpl-gdpr-standard' }, 'writeRefusedOnProduction'],
  ])('blocks an Anonymize step for %j: %s', (config, blocker) => {
    const target = step('anonymize', config);
    expect(stepBlocker(target, CONNECTED, placeOf(target))).toBe(blocker);
  });

  it('runs an Anonymize step on one object and a condition, and reads cleared fields as none', () => {
    const target = step('anonymize', {
      orgId: 'org-a',
      templateId: 'tpl-gdpr-standard',
      object: 'Contact',
      where: "Title = 'x'",
    });
    expect(stepBlocker(target, CONNECTED, placeOf(target))).toBeUndefined();
    const cleared = step('anonymize', {
      orgId: 'org-a',
      templateId: 'tpl-gdpr-standard',
      object: '',
      where: ' ',
    });
    expect(stepBlocker(cleared, CONNECTED, placeOf(cleared))).toBeUndefined();
  });

  it('leaves the templates to the extension until it has described them', () => {
    const target = step('seed', { orgId: 'org-a', templateId: 'tpl-anything' });
    expect(stepBlocker(target, CONNECTED, { steps: [target], index: 0 })).toBeUndefined();
  });
});

describe('the Checkpoint step', () => {
  it('runs on a development org, and is refused on a production one', () => {
    const ok = step('checkpoint', { orgId: 'org-a', mode: 'everything' });
    expect(stepBlocker(ok, CONNECTED, placeOf(ok))).toBeUndefined();
    const prod = step('checkpoint', { orgId: 'org-p', mode: 'everything' });
    expect(stepBlocker(prod, CONNECTED, placeOf(prod))).toBe('checkpointRefusedOnProduction');
  });

  it('asks for the objects of a take of picked objects, and for settings that read', () => {
    const picked = step('checkpoint', { orgId: 'org-a', mode: 'picked' });
    expect(stepBlocker(picked, CONNECTED, placeOf(picked))).toBe('checkpointNeedsObjects');
    const keep = step('checkpoint', { orgId: 'org-a', mode: 'everything', keepDays: 4000 });
    expect(stepBlocker(keep, CONNECTED, placeOf(keep))).toBe('checkpointConfigInvalid');
  });
});

describe('the Rewind step', () => {
  const CONFIG = { orgId: 'org-a', checkpointId: 'ck-20261030-020000-abcd', maxRecords: 100 };
  const rewind = (config: Record<string, unknown> = CONFIG, extra: Partial<PipelineStep> = {}) =>
    step('rewind', config, { id: 'step-r', ...extra });
  const info = (overrides: Partial<PipelineRewindStepInfo> = {}): PipelineRewindStepInfo => ({
    stepId: 'step-r',
    checkpointId: CONFIG.checkpointId,
    valid: true,
    granted: { at: '2026-10-29T09:00:00.000Z', digestMatches: true },
    ...overrides,
  });
  const saved = (target: PipelineStep, steps: PipelineRewindStepInfo[] = [info()]) =>
    placeOf(target, [], { savedSteps: [rewind()], rewindSteps: steps });

  it('runs once saved as it stands and confirmed for that configuration', () => {
    expect(stepBlocker(rewind(), CONNECTED, saved(rewind()))).toBeUndefined();
  });

  it.each([
    [{ orgId: 'org-a', maxRecords: 100 }, 'rewindNeedsCheckpoint'],
    [{ ...CONFIG, checkpointId: 'latest' }, 'rewindNeedsCheckpoint'],
    [{ orgId: 'org-a', checkpointId: CONFIG.checkpointId }, 'rewindNeedsMaxRecords'],
    [{ ...CONFIG, objects: ['not a name'] }, 'rewindConfigInvalid'],
    [{ ...CONFIG, orgId: 'org-p' }, 'writeRefusedOnProduction'],
  ])('is blocked for %j: %s', (config, blocker) => {
    expect(stepBlocker(rewind(config), CONNECTED, saved(rewind(config)))).toBe(blocker);
  });

  it('is never tried again', () => {
    const target = rewind(CONFIG, { retries: 2 });
    expect(stepBlocker(target, CONNECTED, saved(target))).toBe('writeNoRetries');
  });

  it('asks to save a step never saved, or changed since it was saved', () => {
    const target = rewind();
    expect(stepBlocker(target, CONNECTED, placeOf(target, [], { rewindSteps: [] }))).toBe(
      'rewindNotSaved',
    );
    const edited = rewind({ ...CONFIG, maxRecords: 101 });
    expect(stepBlocker(edited, CONNECTED, saved(edited))).toBe('rewindNotSaved');
  });

  it('asks to confirm a saved step never confirmed, and again one changed since', () => {
    expect(stepBlocker(rewind(), CONNECTED, saved(rewind(), []))).toBe('rewindNotConfirmed');
    expect(stepBlocker(rewind(), CONNECTED, saved(rewind(), [info({ granted: undefined })]))).toBe(
      'rewindNotConfirmed',
    );
    expect(
      stepBlocker(
        rewind(),
        CONNECTED,
        saved(rewind(), [info({ granted: { at: 'x', digestMatches: false } })]),
      ),
    ).toBe('rewindChangedSinceConfirmed');
  });

  it.each([
    ['missing', 'rewindCheckpointMissing'],
    ['otherOrg', 'rewindCheckpointOtherOrg'],
    ['refreshed', 'rewindCheckpointRefreshed'],
    ['scratchExpired', 'rewindCheckpointUnusable'],
    ['damaged', 'rewindCheckpointUnusable'],
  ] as const)('says why its checkpoint cannot be rewound to: %s', (why, blocker) => {
    expect(stepBlocker(rewind(), CONNECTED, saved(rewind(), [info({ valid: false, why })]))).toBe(
      blocker,
    );
  });

  it('leaves the confirmation to the extension where the Rewind steps were not described', () => {
    expect(stepBlocker(rewind(), CONNECTED, placeOf(rewind()))).toBeUndefined();
  });
});

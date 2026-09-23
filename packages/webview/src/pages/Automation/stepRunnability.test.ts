import { describe, it, expect } from 'vitest';
import type { PipelineStep, PipelineStepType } from '@sandforge/shared';
import {
  MAX_STEP_TIMEOUT_MS,
  blockedSteps,
  paletteBlocker,
  stepBlocker,
  typeBlocker,
} from './stepRunnability';

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

/** The steps that write to an org: the extension runs none of them in a pipeline. */
const WRITE_STEPS: PipelineStepType[] = ['seed', 'sync', 'restore', 'anonymize', 'delete'];

/** The control steps the extension has no handler for yet. */
const NOT_BUILT: PipelineStepType[] = ['script', 'approval', 'loop', 'parallel'];

/** The step types that run, the four that read an org or tell the user among them. */
const RUNNABLE: PipelineStepType[] = [
  'delay',
  'condition',
  'backup',
  'compare',
  'precheck',
  'notification',
];

/** Two orgs connected on this page. */
const ORGS = new Set(['org-a', 'org-b']);

describe('typeBlocker', () => {
  it('lets the six step types the extension runs through', () => {
    for (const type of RUNNABLE) {
      expect(typeBlocker(type)).toBeUndefined();
    }
  });

  it('refuses the steps that write to an org, for that reason', () => {
    for (const type of WRITE_STEPS) {
      expect(typeBlocker(type)).toBe('writesToOrg');
    }
  });

  it('refuses the control steps not built yet, and a type the page has never heard of', () => {
    for (const type of NOT_BUILT) {
      expect(typeBlocker(type)).toBe('typeCannotRun');
    }
    expect(typeBlocker('dataops:backup')).toBe('typeCannotRun');
  });
});

describe('paletteBlocker', () => {
  it('keeps Condition out of the palette: this page cannot give it a condition', () => {
    expect(paletteBlocker('condition')).toBe('conditionNeedsCondition');
    expect(paletteBlocker('backup')).toBeUndefined();
    expect(paletteBlocker('seed')).toBe('writesToOrg');
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
    expect(stepBlocker(step('seed', { seconds: 30 }))).toBe('writesToOrg');
    expect(stepBlocker(step('script', { seconds: 30 }))).toBe('typeCannotRun');
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

  it('takes any org id when it does not know the connected orgs: the extension checks it', () => {
    expect(stepBlocker(step('backup', { orgId: 'org-z', objects: ['Account'] }))).toBeUndefined();
  });
});

describe('blockedSteps', () => {
  it('names each step that keeps the pipeline from running, in order, and no other', () => {
    const steps = [
      step('delay', { seconds: 5 }),
      step('seed'),
      step('delay'),
      step('condition'),
      step('backup', { orgId: 'org-a', objects: ['Account'] }),
    ];

    expect(blockedSteps(steps, ORGS)).toEqual([
      { stepId: 'id-seed', stepName: 'name-seed', stepType: 'seed', blocker: 'writesToOrg' },
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

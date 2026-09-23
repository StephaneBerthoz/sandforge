import { describe, it, expect } from 'vitest';
import type { ForgeConfig } from '@sandforge/shared';
import { configSubject, templateFromRun, withoutOrgs } from './forgeRunConfig';
import type { RunToSave } from './forgeRunConfig';

const RECORD_RUN: ForgeConfig = {
  inputMode: 'record',
  recordId: '001000000000001AAA',
  depth: 'custom',
  customDepth: 4,
  maxNodes: 200,
  sourceOrgId: 'org-source',
  targetOrgId: 'org-target',
  anonymizePII: true,
  skipEmpty: true,
  batchSize: 'auto',
  expandOrphanParents: true,
  maxRecordsPerObject: 500,
  fieldMappings: { Account: { Region__c: 'Region__pc' } },
};

function run(overrides: Partial<RunToSave> = {}): RunToSave {
  return {
    id: 'tpl-1',
    name: '  Weekly accounts  ',
    description: ' Account 360 for the dev sandbox ',
    config: RECORD_RUN,
    anonymizationRules: {
      email: 'hash',
      phone: 'mask',
      name: 'fake',
      address: 'fake',
      ssn_id: 'redact',
      financial: 'hash',
      other: 'nullify',
    },
    anonymizationPresetId: 'preset:gdpr-default',
    objectCount: 6,
    recordCount: 312,
    savedAt: '2026-09-01T08:00:00.000Z',
    ...overrides,
  };
}

describe('configSubject', () => {
  it('names what each input mode cloned', () => {
    expect(configSubject({ ...RECORD_RUN })).toBe('001000000000001AAA');
    expect(
      configSubject({ ...RECORD_RUN, inputMode: 'soql', soqlQuery: 'SELECT Id FROM Case' }),
    ).toBe('SELECT Id FROM Case');
    expect(configSubject({ ...RECORD_RUN, inputMode: 'template', templateId: 'account-360' })).toBe(
      'account-360',
    );
    expect(configSubject({ ...RECORD_RUN, inputMode: 'ai', aiPrompt: 'open cases' })).toBe(
      'open cases',
    );
  });
});

describe('withoutOrgs', () => {
  it('drops the org pair and keeps every other field, those added later included', () => {
    const stored = withoutOrgs(RECORD_RUN);

    expect(stored).not.toHaveProperty('sourceOrgId');
    expect(stored).not.toHaveProperty('targetOrgId');
    expect(stored.fieldMappings).toEqual({ Account: { Region__c: 'Region__pc' } });
    expect(stored.maxNodes).toBe(200);
  });
});

describe('templateFromRun', () => {
  it("keeps the run's input, scope, anonymization and target org, and not its source", () => {
    const template = templateFromRun(run());

    expect(template).toEqual({
      id: 'tpl-1',
      name: 'Weekly accounts',
      description: 'Account 360 for the dev sandbox',
      config: withoutOrgs(RECORD_RUN),
      targetOrgId: 'org-target',
      anonymization: {
        presetId: 'preset:gdpr-default',
        rules: run().anonymizationRules,
      },
      objectCount: 6,
      recordCount: 312,
      createdAt: '2026-09-01T08:00:00.000Z',
      lastUsedAt: '2026-09-01T08:00:00.000Z',
    });
    expect(JSON.stringify(template)).not.toContain('org-source');
  });

  it('records no preset when none was picked in Review', () => {
    const template = templateFromRun(run({ anonymizationPresetId: '' }));

    expect(template.anonymization).not.toHaveProperty('presetId');
    expect(template.anonymization?.rules.email).toBe('hash');
  });
});

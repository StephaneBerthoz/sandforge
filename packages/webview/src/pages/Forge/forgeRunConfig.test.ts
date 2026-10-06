import { describe, it, expect } from 'vitest';
import type { ForgeConfig, ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import { carriedChoices, configSubject, templateFromRun, withoutOrgs } from './forgeRunConfig';
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

  describe('a template that keeps everything the run was given', () => {
    const node = (objectApiName: string, overrides: Partial<ForgeGraphNode> = {}) => ({
      objectApiName,
      recordCount: 10,
      fieldCount: 5,
      status: 'idle' as const,
      progress: 0,
      included: true,
      piiFields: [],
      anonymizeFields: [],
      level: 0,
      successCount: 0,
      failureCount: 0,
      errors: [],
      createableFieldCount: 5,
      estimatedSizeMB: 0,
      estimatedApiCalls: 0,
      batchStrategy: 'auto' as const,
      ...overrides,
    });
    const graph: ForgeGraph = {
      nodes: [
        node('Account', { piiFields: ['Phone'], anonymizeFields: [] }),
        node('Contact', { piiFields: ['Email', 'Phone'], anonymizeFields: ['Email'] }),
        node('Task', { included: false, leftOutByUser: true }),
        // Left out by discovery, not by the user: no choice of theirs.
        node('Asset', { included: false }),
        node('Case', { included: true }),
      ],
      edges: [],
      totalRecords: 50,
      estimatedSizeMB: 0,
      estimatedDurationSeconds: 0,
    };
    const decided: ForgeConfig = {
      ...RECORD_RUN,
      dryRun: true,
      // Case was put back in on the graph since; Lead is not on it.
      excludedObjects: ['Case', 'Lead'],
      picklistValueMappings: [{ object: 'Case', field: 'Reason__c', from: 'Other', to: 'General' }],
      ignoredGaps: ['validation_rule|Contact|||Phone_Format'],
    };

    it('keeps the objects left out as the graph shows them, and every decision', () => {
      const template = templateFromRun(run({ config: decided, graph }));

      expect(template.config.excludedObjects).toEqual(['Lead', 'Task']);
      expect(template.config.picklistValueMappings).toEqual(decided.picklistValueMappings);
      expect(template.config.ignoredGaps).toEqual(decided.ignoredGaps);
      expect(template.config.fieldMappings).toEqual(RECORD_RUN.fieldMappings);
      expect(template.config).not.toHaveProperty('dryRun');
    });

    it('keeps the fields anonymized on every object that holds personal ones, none included', () => {
      const template = templateFromRun(run({ config: decided, graph }));

      expect(template.anonymization?.fields).toEqual([
        { objectApiName: 'Account', fieldNames: [] },
        { objectApiName: 'Contact', fieldNames: ['Email'] },
      ]);
      expect(
        templateFromRun(run({ config: { ...decided, anonymizePII: false }, graph })).anonymization,
      ).not.toHaveProperty('fields');
    });

    it('keeps the file copy and its size, never the acceptance, and none for a run that copied none', () => {
      const copying = templateFromRun(
        run({ graph, fileCopy: { enabled: true, maxFileSizeMB: 25 } }),
      );
      expect(copying.files).toEqual({ maxFileSizeMB: 25 });
      expect(JSON.stringify(copying)).not.toContain('acceptedAsIs');

      expect(
        templateFromRun(run({ graph, fileCopy: { enabled: false, maxFileSizeMB: 25 } })),
      ).not.toHaveProperty('files');
    });
  });
});

describe('carriedChoices', () => {
  it('takes the decisions, the objects left out, the exclusions and the mappings, only those set', () => {
    const carried = carriedChoices({
      ...RECORD_RUN,
      dryRun: true,
      excludedObjects: ['Task'],
      defaultValues: [{ object: 'Account', field: 'Region__c', value: 'EMEA' }],
      fieldExclusions: { Contact: ['Fax'] },
      objectSoqlFilters: { Account: "Type = 'Customer'" },
    });

    expect(carried).toEqual({
      fieldMappings: { Account: { Region__c: 'Region__pc' } },
      excludedObjects: ['Task'],
      defaultValues: [{ object: 'Account', field: 'Region__c', value: 'EMEA' }],
      fieldExclusions: { Contact: ['Fax'] },
    });
    expect(carriedChoices(null)).toEqual({});
  });
});

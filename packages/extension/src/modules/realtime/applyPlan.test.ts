import { describe, it, expect } from 'vitest';
import type { SyncConfig, SyncObjectConfig } from '@sandforge/shared';
import { applyPlanFor } from './applyPlan';

const orgs = { sourceOrgId: 'org-source', targetOrgId: 'org-target' };

function leadEntry(overrides: Partial<SyncObjectConfig> = {}): SyncObjectConfig {
  return {
    objectApiName: 'Lead',
    operation: 'insert',
    externalIdField: 'Ext__c',
    fieldMappings: [
      { sourceField: 'Website', targetField: 'Ext__c', type: 'rename' },
      { sourceField: 'Title', targetField: 'Title', type: 'direct' },
    ],
    transformRules: [{ type: 'trim', field: 'Title', config: {} }],
    excludedFields: [],
    addOnFields: [{ fieldApiName: 'LeadSource', value: 'Sync', overwriteExisting: true }],
    batchSize: 200,
    insertOrder: 1,
    ...overrides,
  };
}

function saved(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    id: 'cfg-1',
    name: 'Leads nightly',
    description: '',
    sourceOrgId: 'org-source',
    targetOrgId: 'org-target',
    direction: 'source_to_target',
    mode: 'full',
    objects: [leadEntry()],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('applyPlanFor', () => {
  it('matches on Id when the orgs share record ids', () => {
    expect(
      applyPlanFor(
        { objectApiName: 'Lead', match: { kind: 'id' }, applyDeletes: true },
        () => undefined,
        orgs,
      ),
    ).toEqual({
      objectApiName: 'Lead',
      keyField: 'Id',
      keySource: 'Id',
      fieldMappings: [],
      addOnFields: [],
      transformRules: [],
      applyDeletes: true,
    });
  });

  it('matches on an external id filled from the source field of the same name', () => {
    const plan = applyPlanFor(
      {
        objectApiName: 'Lead',
        match: { kind: 'externalId', field: 'Ext__c' },
        applyDeletes: false,
      },
      () => undefined,
      orgs,
    );
    expect(plan).toMatchObject({ keyField: 'Ext__c', keySource: 'Ext__c', fieldMappings: [] });
  });

  it('takes the key, mappings, transforms and add-ons of a saved configuration', () => {
    const plan = applyPlanFor(
      {
        objectApiName: 'Lead',
        match: { kind: 'syncConfig', configId: 'cfg-1' },
        applyDeletes: false,
      },
      () => saved(),
      orgs,
    );
    expect(plan).toMatchObject({
      keyField: 'Ext__c',
      // The mapping says where the key comes from in the source.
      keySource: 'Website',
      transformRules: [{ type: 'trim', field: 'Title', config: {} }],
      addOnFields: [{ fieldApiName: 'LeadSource', value: 'Sync', overwriteExisting: true }],
    });
    expect(plan.fieldMappings).toHaveLength(2);
  });

  it('keeps the emails and phone numbers of an object found by Id or an external id when the session asks', () => {
    const byId = { objectApiName: 'Lead', match: { kind: 'id' as const }, applyDeletes: false };
    const byKey = {
      objectApiName: 'Lead',
      match: { kind: 'externalId' as const, field: 'Ext__c' },
      applyDeletes: false,
    };

    expect(
      applyPlanFor(byId, () => undefined, orgs, { keepContactPoints: true }).keepContactPoints,
    ).toBe(true);
    expect(
      applyPlanFor(byKey, () => undefined, orgs, { keepContactPoints: true }).keepContactPoints,
    ).toBe(true);
    // Neutralized unless asked.
    expect(applyPlanFor(byId, () => undefined, orgs).keepContactPoints).toBeUndefined();
    expect(
      applyPlanFor(byKey, () => undefined, orgs, { keepContactPoints: false }).keepContactPoints,
    ).toBeUndefined();
  });

  it("follows a saved configuration's choice of the emails and phone numbers, whatever the session's", () => {
    const bySaved = {
      objectApiName: 'Lead',
      match: { kind: 'syncConfig' as const, configId: 'cfg-1' },
      applyDeletes: false,
    };

    expect(
      applyPlanFor(bySaved, () => saved(), orgs, { keepContactPoints: true }).keepContactPoints,
    ).toBeUndefined();
    expect(
      applyPlanFor(bySaved, () => saved({ keepContactPoints: true }), orgs).keepContactPoints,
    ).toBe(true);
  });

  it('takes the fields a saved configuration excludes, which its mappings no longer keep out', () => {
    // A mapping renames its field and the others go by name: an exclusion
    // the mapped fields alone once kept out would be written.
    const plan = applyPlanFor(
      {
        objectApiName: 'Lead',
        match: { kind: 'syncConfig', configId: 'cfg-1' },
        applyDeletes: false,
      },
      () => saved({ objects: [leadEntry({ excludedFields: ['Phone'] })] }),
      orgs,
    );

    expect(plan.excludedFields).toEqual(['Phone']);
  });

  it('matches on Id when the saved configuration names no external id', () => {
    const plan = applyPlanFor(
      {
        objectApiName: 'Lead',
        match: { kind: 'syncConfig', configId: 'cfg-1' },
        applyDeletes: false,
      },
      () => saved({ objects: [leadEntry({ externalIdField: '  ' })] }),
      orgs,
    );
    expect(plan).toMatchObject({ keyField: 'Id', keySource: 'Id' });
  });

  it.each([
    ['is gone', () => undefined, 'no longer exists'],
    ['runs between other orgs', () => saved({ targetOrgId: 'org-other' }), 'two other orgs'],
    ['does not carry the object', () => saved({ objects: [] }), 'does not carry it'],
    [
      'has a rule on it that names no field',
      () =>
        saved({ objects: [leadEntry({ transformRules: [{ type: 'uppercase', config: {} }] })] }),
      'cannot be applied. The rule Uppercase on Lead names no field: open the configuration and pick its field.',
    ],
    [
      'has a Regex replace on it whose pattern is no regular expression',
      () =>
        saved({
          objects: [
            leadEntry({
              transformRules: [{ type: 'regex_replace', field: 'Title', config: { regex: '[a-' } }],
            }),
          ],
        }),
      'cannot be applied. The rule Regex replace on Lead.Title, "[a-" (Unterminated character class) has a pattern that is no regular expression',
    ],
  ])('refuses a saved configuration that %s', (_case, load, message) => {
    expect(() =>
      applyPlanFor(
        {
          objectApiName: 'Lead',
          match: { kind: 'syncConfig', configId: 'cfg-1' },
          applyDeletes: false,
        },
        load,
        orgs,
      ),
    ).toThrow(message);
  });
});

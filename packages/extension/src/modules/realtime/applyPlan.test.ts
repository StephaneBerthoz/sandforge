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
    transformRules: [{ type: 'trim', config: {} }],
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
      transformRules: [{ type: 'trim', config: {} }],
      addOnFields: [{ fieldApiName: 'LeadSource', value: 'Sync', overwriteExisting: true }],
    });
    expect(plan.fieldMappings).toHaveLength(2);
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

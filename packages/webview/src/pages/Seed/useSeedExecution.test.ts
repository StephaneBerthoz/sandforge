import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { TFunction } from 'i18next';
import type { SeedTemplate } from '@sandforge/shared';

import { useSeedExecution } from './useSeedExecution';
import type { ObjectFieldConfig } from './Step3_ConfigureFields';
import type { CheckedRelation } from './seedRelationDrafts';

const bridge = vi.hoisted(() => ({
  mutate: vi.fn(),
  loading: false,
  requestId: null as string | null,
  /** operation:progress entries, by operationId. */
  progress: new Map<
    string,
    {
      operationId: string;
      percentage: number;
      processedRecords: number;
      totalRecords: number;
      currentStep: string;
    }
  >(),
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: () => ({
    mutate: bridge.mutate,
    data: null,
    loading: bridge.loading,
    error: null,
    reset: vi.fn(),
    requestId: bridge.requestId,
  }),
}));

vi.mock('../../hooks/useOperationProgress', () => ({
  useOperationProgress: () => ({ getProgress: (id: string) => bridge.progress.get(id) }),
}));

const FIELD_CONFIGS: ObjectFieldConfig[] = [
  {
    objectApiName: 'Case',
    objectLabel: 'Case',
    fields: [
      {
        fieldApiName: 'Description',
        label: 'Description',
        type: 'textarea',
        required: false,
        ruleType: 'ai_generate',
        config: { aiPrompt: 'Customer complaint' },
      },
      {
        fieldApiName: 'Priority',
        label: 'Priority',
        type: 'picklist',
        required: false,
        ruleType: 'picklist_random',
        config: { picklistValues: ['High', 'Low'] },
      },
    ],
  },
];

describe('useSeedExecution', () => {
  beforeEach(() => {
    bridge.mutate.mockClear();
    bridge.loading = false;
    bridge.requestId = null;
    bridge.progress.clear();
  });

  it('shows the progress of the run it started, not of another run reporting at the same time', () => {
    // Every open panel receives every operation:progress. The bar used to read
    // the last event from any run, so a second seed made this one jump around.
    bridge.loading = true;
    bridge.requestId = 'wv-own-run';
    bridge.progress.set('wv-own-run', {
      operationId: 'wv-own-run',
      percentage: 25,
      processedRecords: 1,
      totalRecords: 4,
      currentStep: 'Insert Case',
    });
    bridge.progress.set('wv-other-run', {
      operationId: 'wv-other-run',
      percentage: 90,
      processedRecords: 9,
      totalRecords: 10,
      currentStep: 'Insert Account',
    });

    const { result } = renderHook(() =>
      useSeedExecution(
        'org-1',
        ['Case'],
        { Case: { count: 4, batchSize: 200 } },
        FIELD_CONFIGS,
        ((key: string) => key) as unknown as TFunction,
      ),
    );

    expect(result.current.overallPercent).toBe(25);
    expect(result.current.progressLabel).toBe('Insert Case');
    expect(result.current.operationId).toBe('wv-own-run');
  });

  it('names no operation to stop before its run has reported progress', () => {
    bridge.loading = true;
    bridge.requestId = 'wv-own-run';
    bridge.progress.set('wv-other-run', {
      operationId: 'wv-other-run',
      percentage: 90,
      processedRecords: 9,
      totalRecords: 10,
      currentStep: 'Insert Account',
    });

    const { result } = renderHook(() =>
      useSeedExecution(
        'org-1',
        ['Case'],
        { Case: { count: 4, batchSize: 200 } },
        FIELD_CONFIGS,
        ((key: string) => key) as unknown as TFunction,
      ),
    );

    expect(result.current.overallPercent).toBe(0);
    expect(result.current.operationId).toBeNull();
  });

  it('sends the type of each field with its rule, so the run can refuse a rule the field cannot hold', () => {
    const { result } = renderHook(() =>
      useSeedExecution(
        'org-1',
        ['Case'],
        { Case: { count: 5, batchSize: 200 } },
        FIELD_CONFIGS,
        ((key: string) => key) as unknown as TFunction,
      ),
    );

    act(() => {
      result.current.handleExecute();
    });

    expect(bridge.mutate).toHaveBeenCalledTimes(1);
    const payload = bridge.mutate.mock.calls[0][0] as { template: SeedTemplate };
    expect(payload.template.objects[0].fieldRules).toEqual([
      {
        fieldApiName: 'Description',
        fieldType: 'textarea',
        ruleType: 'ai_generate',
        config: { aiPrompt: 'Customer complaint' },
      },
      {
        fieldApiName: 'Priority',
        fieldType: 'picklist',
        ruleType: 'picklist_random',
        config: { picklistValues: ['High', 'Low'] },
      },
    ]);
  });

  it('sends no lookup rule to an object the run does not seed', () => {
    const configs: ObjectFieldConfig[] = [
      {
        objectApiName: 'Contact',
        objectLabel: 'Contact',
        fields: [
          {
            fieldApiName: 'OwnerId',
            label: 'Owner',
            type: 'reference',
            required: false,
            ruleType: 'reference',
            config: { referenceObject: 'User', referenceField: 'Id' },
          },
          {
            fieldApiName: 'AccountId',
            label: 'Account',
            type: 'reference',
            required: false,
            ruleType: 'reference',
            config: { referenceObject: 'Account', referenceField: 'Id' },
          },
        ],
      },
    ];
    const { result } = renderHook(() =>
      useSeedExecution(
        'org-1',
        ['Account', 'Contact'],
        { Contact: { count: 5, batchSize: 200 } },
        configs,
        ((key: string) => key) as unknown as TFunction,
      ),
    );

    act(() => {
      result.current.handleExecute();
    });

    const payload = bridge.mutate.mock.calls[0][0] as { template: SeedTemplate };
    const contact = payload.template.objects.find((o) => o.objectApiName === 'Contact');
    expect(contact?.fieldRules.map((r) => r.fieldApiName)).toEqual(['AccountId']);
  });

  it('keeps a required lookup to an object the run does not seed', () => {
    const configs: ObjectFieldConfig[] = [
      {
        objectApiName: 'Invoice_Line__c',
        objectLabel: 'Invoice Line',
        fields: [
          {
            fieldApiName: 'Invoice__c',
            label: 'Invoice',
            type: 'reference',
            required: true,
            ruleType: 'reference',
            config: { referenceObject: 'Invoice__c', referenceField: 'Id' },
          },
        ],
      },
    ];
    const { result } = renderHook(() =>
      useSeedExecution(
        'org-1',
        ['Invoice_Line__c'],
        { Invoice_Line__c: { count: 5, batchSize: 200 } },
        configs,
        ((key: string) => key) as unknown as TFunction,
      ),
    );

    act(() => {
      result.current.handleExecute();
    });

    const payload = bridge.mutate.mock.calls[0][0] as { template: SeedTemplate };
    const line = payload.template.objects.find((o) => o.objectApiName === 'Invoice_Line__c');
    expect(line?.fieldRules.map((r) => r.fieldApiName)).toEqual(['Invoice__c']);
  });

  it('sends no optional lookup to the object itself, which the insert that writes it cannot fill', () => {
    // Account.ParentId and Contact.ReportsToId are described as reference
    // rules to their own object, and the run refused every template carrying
    // one as a circular dependency: no Account or Contact could be seeded.
    const selfLookup = (fieldApiName: string, object: string, required: boolean) => ({
      fieldApiName,
      label: fieldApiName,
      type: 'reference',
      required,
      ruleType: 'reference' as const,
      config: { referenceObject: object, referenceField: 'Id' },
    });
    const configs: ObjectFieldConfig[] = [
      {
        objectApiName: 'Account',
        objectLabel: 'Account',
        fields: [
          {
            fieldApiName: 'Name',
            label: 'Account Name',
            type: 'string',
            required: true,
            ruleType: 'faker',
            config: { fakerMethod: 'company.name' },
          },
          selfLookup('ParentId', 'Account', false),
        ],
      },
      {
        objectApiName: 'Contact',
        objectLabel: 'Contact',
        fields: [
          selfLookup('ReportsToId', 'Contact', false),
          selfLookup('AccountId', 'Account', false),
        ],
      },
      {
        objectApiName: 'Node__c',
        objectLabel: 'Node',
        fields: [selfLookup('Root__c', 'Node__c', true)],
      },
    ];
    const { result } = renderHook(() =>
      useSeedExecution(
        'org-1',
        ['Account', 'Contact', 'Node__c'],
        {},
        configs,
        ((key: string) => key) as unknown as TFunction,
      ),
    );

    act(() => {
      result.current.handleExecute();
    });

    const payload = bridge.mutate.mock.calls[0][0] as { template: SeedTemplate };
    const rulesOf = (name: string) =>
      payload.template.objects
        .find((o) => o.objectApiName === name)
        ?.fieldRules.map((r) => r.fieldApiName);
    expect(rulesOf('Account')).toEqual(['Name']);
    expect(rulesOf('Contact')).toEqual(['AccountId']);
    // A required one is still sent, so the run refuses it before writing.
    expect(rulesOf('Node__c')).toEqual(['Root__c']);
  });

  it('leaves out the optional lookup that would make two objects of the run wait on each other', () => {
    // A sandbox whose accounts carry a custom lookup to a contact refused every
    // run holding Account and Contact: "Circular dependency detected".
    const lookup = (fieldApiName: string, object: string) => ({
      fieldApiName,
      label: fieldApiName,
      type: 'reference',
      required: false,
      ruleType: 'reference' as const,
      config: { referenceObject: object, referenceField: 'Id' },
    });
    const configs: ObjectFieldConfig[] = [
      {
        objectApiName: 'Account',
        objectLabel: 'Account',
        fields: [
          {
            fieldApiName: 'Name',
            label: 'Account Name',
            type: 'string',
            required: true,
            ruleType: 'faker',
            config: { fakerMethod: 'name' },
          },
          lookup('Key_Contact__c', 'Contact'),
        ],
      },
      {
        objectApiName: 'Contact',
        objectLabel: 'Contact',
        fields: [lookup('AccountId', 'Account')],
      },
    ];
    const { result } = renderHook(() =>
      useSeedExecution(
        'org-1',
        ['Account', 'Contact'],
        {},
        configs,
        ((key: string) => key) as unknown as TFunction,
      ),
    );

    act(() => {
      result.current.handleExecute();
    });

    const payload = bridge.mutate.mock.calls[0][0] as { template: SeedTemplate };
    const rulesOf = (name: string) =>
      payload.template.objects
        .find((o) => o.objectApiName === name)
        ?.fieldRules.map((r) => r.fieldApiName);
    expect(rulesOf('Account')).toEqual(['Name']);
    expect(rulesOf('Contact')).toEqual(['AccountId']);
  });

  describe('relations', () => {
    const CONTACT_CONFIGS: ObjectFieldConfig[] = [
      {
        objectApiName: 'Contact',
        objectLabel: 'Contact',
        fields: [
          {
            fieldApiName: 'LastName',
            label: 'Last Name',
            type: 'string',
            required: true,
            ruleType: 'faker',
            config: { fakerMethod: 'person.lastName' },
          },
          {
            fieldApiName: 'AccountId',
            label: 'Account ID',
            type: 'reference',
            required: false,
            ruleType: 'reference',
            config: { referenceObject: 'Account', referenceField: 'Id' },
          },
        ],
      },
    ];

    /** Three contacts for each of the five accounts the run creates, as the editor checked it. */
    const threePerAccount: CheckedRelation = {
      relation: {
        childObject: 'Contact',
        lookupField: 'AccountId',
        parentObject: 'Account',
        parents: { kind: 'generated' },
        distribution: { mode: 'perParent', count: 3 },
      },
      parents: 5,
      children: 15,
      problem: null,
    };

    /** The template sent for Account and Contact with the relations given. */
    function sentWith(relations: CheckedRelation[]): SeedTemplate {
      const { result } = renderHook(() =>
        useSeedExecution(
          'org-1',
          ['Account', 'Contact'],
          { Account: { count: 5, batchSize: 200 }, Contact: { count: 100, batchSize: 200 } },
          CONTACT_CONFIGS,
          ((key: string) => key) as unknown as TFunction,
          relations,
        ),
      );
      act(() => {
        result.current.handleExecute();
      });
      return (bridge.mutate.mock.calls[0][0] as { template: SeedTemplate }).template;
    }

    it('sends the relation, and the child count it plans in place of the one set on the first step', () => {
      const template = sentWith([threePerAccount]);

      expect(template.relations).toEqual([threePerAccount.relation]);
      expect(template.objects.find((o) => o.objectApiName === 'Contact')?.recordCount).toBe(15);
      expect(template.objects.find((o) => o.objectApiName === 'Account')?.recordCount).toBe(5);
    });

    it('leaves the lookup to the relation, not to a rule that would pick a parent at random', () => {
      const template = sentWith([threePerAccount]);

      const contact = template.objects.find((o) => o.objectApiName === 'Contact');
      expect(contact?.fieldRules.map((r) => r.fieldApiName)).toEqual(['LastName']);
    });

    it('sends no relation row that has a problem', () => {
      const template = sentWith([
        { relation: null, parents: 5, children: 0, problem: 'noChildren' },
      ]);

      expect(template).not.toHaveProperty('relations');
      expect(template.objects.find((o) => o.objectApiName === 'Contact')?.recordCount).toBe(100);
    });

    it('counts the progress of a child against what its relation plans', () => {
      const { result } = renderHook(() =>
        useSeedExecution(
          'org-1',
          ['Account', 'Contact'],
          { Account: { count: 5, batchSize: 200 } },
          CONTACT_CONFIGS,
          ((key: string) => key) as unknown as TFunction,
          [threePerAccount],
        ),
      );

      expect(result.current.objectProgress.map((p) => p.total)).toEqual([5, 15]);
    });
  });

  it('keeps the template the run was sent, for Save as template to store', () => {
    const { result } = renderHook(() =>
      useSeedExecution(
        'org-1',
        ['Case'],
        { Case: { count: 5, batchSize: 200 } },
        FIELD_CONFIGS,
        ((key: string) => key) as unknown as TFunction,
      ),
    );

    expect(result.current.lastTemplate).toBeNull();

    act(() => {
      result.current.handleExecute();
    });

    const payload = bridge.mutate.mock.calls[0][0] as { template: SeedTemplate };
    expect(result.current.lastTemplate).toEqual(payload.template);
  });
});

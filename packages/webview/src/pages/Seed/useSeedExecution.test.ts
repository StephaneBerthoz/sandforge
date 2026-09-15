import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { TFunction } from 'i18next';
import type { SeedTemplate } from '@sandforge/shared';

import { useSeedExecution } from './useSeedExecution';
import type { ObjectFieldConfig } from './Step3_ConfigureFields';

const bridge = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: () => ({
    mutate: bridge.mutate,
    data: null,
    loading: false,
    error: null,
    reset: vi.fn(),
  }),
}));

vi.mock('../../hooks/useOperationProgress', () => ({
  useOperationProgress: () => ({ latest: null, getProgress: vi.fn() }),
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
});

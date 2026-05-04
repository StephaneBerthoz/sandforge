import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useQuickSeed } from './useQuickSeed';
import type { SeedTemplate } from '@sandforge/shared';

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */

const mockMutate = vi.fn();
const mockReset = vi.fn();

let mockMutationState = {
  mutate: mockMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockReset,
};

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: () => mockMutationState,
}));

const mockTemplate: SeedTemplate = {
  id: 'prebuilt-minimal-demo',
  name: 'Minimal Demo',
  description: 'A minimal demo template',
  version: 1,
  strategy: 'faker',
  objects: [
    {
      objectApiName: 'Account',
      recordCount: 50,
      fieldRules: [
        { fieldApiName: 'Name', ruleType: 'faker', config: { fakerMethod: 'company.name' } },
      ],
      excludedFields: [],
      insertOrder: 0,
      batchSize: 200,
    },
    {
      objectApiName: 'Contact',
      recordCount: 100,
      fieldRules: [
        { fieldApiName: 'LastName', ruleType: 'faker', config: { fakerMethod: 'person.lastName' } },
      ],
      excludedFields: [],
      insertOrder: 1,
      batchSize: 200,
    },
  ],
  tags: ['prebuilt', 'demo'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('useQuickSeed', () => {
  beforeEach(() => {
    mockMutate.mockClear();
    mockReset.mockClear();
    mockMutationState = {
      mutate: mockMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockReset,
    };
  });

  it('starts in idle phase', () => {
    const { result } = renderHook(() => useQuickSeed());

    expect(result.current.phase).toBe('idle');
    expect(result.current.selectedTemplate).toBeNull();
    expect(result.current.selectedOrgId).toBe('');
  });

  it('startQuickSeed transitions to selectOrg phase', () => {
    const { result } = renderHook(() => useQuickSeed());

    act(() => {
      result.current.startQuickSeed(mockTemplate, { Account: 200 });
    });

    expect(result.current.phase).toBe('selectOrg');
    expect(result.current.selectedTemplate).toBe(mockTemplate);
    expect(result.current.customizedCounts).toEqual({ Account: 200 });
  });

  it('selectOrg stores the orgId', () => {
    const { result } = renderHook(() => useQuickSeed());

    act(() => {
      result.current.startQuickSeed(mockTemplate, {});
      result.current.selectOrg('org-123');
    });

    expect(result.current.selectedOrgId).toBe('org-123');
  });

  it('execute builds correct payload with customized counts and template field rules', () => {
    const { result } = renderHook(() => useQuickSeed());

    act(() => {
      result.current.startQuickSeed(mockTemplate, { Account: 999 });
      result.current.selectOrg('org-456');
    });

    act(() => {
      result.current.execute();
    });

    expect(mockMutate).toHaveBeenCalledTimes(1);
    const payload = mockMutate.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.orgId).toBe('org-456');

    const template = payload.template as SeedTemplate;
    const accountObj = template.objects.find((o) => o.objectApiName === 'Account');
    expect(accountObj?.recordCount).toBe(999);
    expect(accountObj?.fieldRules.length).toBe(1);
    expect(accountObj?.fieldRules[0].ruleType).toBe('faker');

    const contactObj = template.objects.find((o) => o.objectApiName === 'Contact');
    expect(contactObj?.recordCount).toBe(100);
  });

  it('reset returns to idle and clears all state', () => {
    const { result } = renderHook(() => useQuickSeed());

    act(() => {
      result.current.startQuickSeed(mockTemplate, { Account: 200 });
      result.current.selectOrg('org-123');
    });

    act(() => {
      result.current.reset();
    });

    expect(result.current.phase).toBe('idle');
    expect(result.current.selectedTemplate).toBeNull();
    expect(result.current.selectedOrgId).toBe('');
    expect(result.current.customizedCounts).toEqual({});
    expect(result.current.error).toBeNull();
    expect(mockReset).toHaveBeenCalled();
  });

  it('derives objectProgress from template objects', () => {
    const { result } = renderHook(() => useQuickSeed());

    act(() => {
      result.current.startQuickSeed(mockTemplate, { Account: 300 });
    });

    expect(result.current.objectProgress.length).toBe(2);
    expect(result.current.objectProgress[0].objectApiName).toBe('Account');
    expect(result.current.objectProgress[0].total).toBe(300);
    expect(result.current.objectProgress[1].objectApiName).toBe('Contact');
    expect(result.current.objectProgress[1].total).toBe(100);
  });
});

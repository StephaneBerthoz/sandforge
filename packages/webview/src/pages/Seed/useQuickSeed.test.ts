import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useQuickSeed } from './useQuickSeed';
import { useOrgStore } from '../../stores/useOrgStore';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg, SeedTemplate } from '@sandforge/shared';

function createMockOrg(overrides: Partial<SalesforceOrg> = {}): SalesforceOrg {
  return {
    id: 'org-1',
    alias: 'DevSandbox',
    username: 'admin@dev.sandbox',
    instanceUrl: 'https://dev-sandbox.salesforce.com',
    orgId: '00D000000000001',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#3B82F6', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '59.0', edition: 'Developer Edition', features: [] },
    status: 'connected',
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
    ...overrides,
  };
}

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
  requestId: null as string | null,
};

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: () => mockMutationState,
}));

/* operation:progress events by operationId, as useOperationProgress hands them over. */
const progressStream = vi.hoisted(() => ({
  byId: new Map<
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

vi.mock('../../hooks/useOperationProgress', () => ({
  useOperationProgress: () => ({ getProgress: (id: string) => progressStream.byId.get(id) }),
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
      requestId: null,
    };
    progressStream.byId.clear();
    useOrgStore.setState({ orgs: [] });
  });

  it('shows the progress the extension reports while the seed runs, not a fixed figure', () => {
    const { result, rerender } = renderHook(() => useQuickSeed());
    act(() => {
      result.current.startQuickSeed(mockTemplate, {});
    });

    mockMutationState = { ...mockMutationState, loading: true, requestId: 'op-1' };
    progressStream.byId.set('op-1', {
      operationId: 'op-1',
      percentage: 60,
      processedRecords: 90,
      totalRecords: 150,
      currentStep: 'Insert Contact',
    });
    progressStream.byId.set('op-other', {
      operationId: 'op-other',
      percentage: 5,
      processedRecords: 1,
      totalRecords: 20,
      currentStep: 'Insert Lead',
    });
    rerender();

    expect(result.current.overallPercent).toBe(60);
    expect(result.current.objectProgress).toEqual([
      { objectApiName: 'Account', total: 50, completed: 50, failed: 0, status: 'done' },
      { objectApiName: 'Contact', total: 100, completed: 40, failed: 0, status: 'running' },
    ]);
  });

  it('reads 0% before the first progress event arrives', () => {
    const { result, rerender } = renderHook(() => useQuickSeed());
    act(() => {
      result.current.startQuickSeed(mockTemplate, {});
    });

    mockMutationState = { ...mockMutationState, loading: true, requestId: 'op-1' };
    progressStream.byId.set('op-other', {
      operationId: 'op-other',
      percentage: 70,
      processedRecords: 14,
      totalRecords: 20,
      currentStep: 'Insert Lead',
    });
    rerender();

    expect(result.current.overallPercent).toBe(0);
    expect(result.current.objectProgress.map((o) => o.status)).toEqual(['running', 'running']);
  });

  it('reads 0% at the start of a second run instead of the last figure of the first', () => {
    const { result, rerender } = renderHook(() => useQuickSeed());
    act(() => {
      result.current.startQuickSeed(mockTemplate, {});
      result.current.selectOrg('org-1');
    });
    act(() => {
      result.current.execute();
    });
    mockMutationState = { ...mockMutationState, loading: true, requestId: 'op-1' };
    progressStream.byId.set('op-1', {
      operationId: 'op-1',
      percentage: 100,
      processedRecords: 150,
      totalRecords: 150,
      currentStep: 'Insert Contact',
    });
    rerender();
    expect(result.current.overallPercent).toBe(100);

    mockMutationState = { ...mockMutationState, loading: false };
    rerender();
    act(() => {
      result.current.reset();
    });
    act(() => {
      result.current.startQuickSeed(mockTemplate, {});
      result.current.selectOrg('org-1');
    });
    act(() => {
      result.current.execute();
    });
    mockMutationState = { ...mockMutationState, loading: true, requestId: 'op-2' };
    rerender();

    expect(result.current.overallPercent).toBe(0);
    expect(result.current.objectProgress.map((o) => o.completed)).toEqual([0, 0]);

    progressStream.byId.set('op-2', {
      operationId: 'op-2',
      percentage: 20,
      processedRecords: 30,
      totalRecords: 150,
      currentStep: 'Insert Account',
    });
    rerender();
    expect(result.current.overallPercent).toBe(20);
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

  it('preselects the org it was given, without starting the run', () => {
    useOrgStore.setState({ orgs: [createMockOrg({ id: 'org-7' })] });
    const { result } = renderHook(() => useQuickSeed({ initialOrgId: 'org-7' }));

    act(() => {
      result.current.startQuickSeed(mockTemplate, {});
    });

    expect(result.current.phase).toBe('selectOrg');
    expect(result.current.selectedOrgId).toBe('org-7');
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('preselects the given org only once: a template picked after going back keeps the selection empty', () => {
    useOrgStore.setState({
      orgs: [createMockOrg({ id: 'org-2' }), createMockOrg({ id: 'org-3' })],
    });
    const { result } = renderHook(() => useQuickSeed({ initialOrgId: 'org-2' }));

    act(() => {
      result.current.startQuickSeed(mockTemplate, {});
    });
    expect(result.current.selectedOrgId).toBe('org-2');

    act(() => {
      result.current.selectOrg('org-3');
    });
    act(() => {
      result.current.reset();
    });
    act(() => {
      result.current.startQuickSeed(mockTemplate, {});
    });

    expect(result.current.phase).toBe('selectOrg');
    expect(result.current.selectedOrgId).toBe('');
  });

  it('leaves the selection empty when the given org has lost its connection', () => {
    useOrgStore.setState({
      orgs: [createMockOrg({ id: 'org-7', status: 'expired' }), createMockOrg({ id: 'org-9' })],
    });
    const { result } = renderHook(() => useQuickSeed({ initialOrgId: 'org-7' }));

    act(() => {
      result.current.startQuickSeed(mockTemplate, {});
    });

    expect(result.current.phase).toBe('selectOrg');
    expect(result.current.selectedOrgId).toBe('');
  });

  it('leaves the selection empty when the given org is not in the org list', () => {
    useOrgStore.setState({ orgs: [createMockOrg({ id: 'org-9' })] });
    const { result } = renderHook(() => useQuickSeed({ initialOrgId: 'org-404' }));

    act(() => {
      result.current.startQuickSeed(mockTemplate, {});
    });

    expect(result.current.phase).toBe('selectOrg');
    expect(result.current.selectedOrgId).toBe('');
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('leaves the selection empty when no org was given', () => {
    useOrgStore.setState({ orgs: [createMockOrg({ id: 'org-7' })] });
    const { result } = renderHook(() => useQuickSeed());

    act(() => {
      result.current.startQuickSeed(mockTemplate, {});
    });

    expect(result.current.selectedOrgId).toBe('');
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

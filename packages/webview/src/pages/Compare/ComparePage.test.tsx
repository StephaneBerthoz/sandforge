import React from 'react';
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { OrgSafetyTier } from '@sandforge/shared';
import { ComparePage } from './ComparePage';

/* React Flow requires ResizeObserver. */
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class ResizeObserver {
      observe(): void {
        /* noop */
      }
      unobserve(): void {
        /* noop */
      }
      disconnect(): void {
        /* noop */
      }
    };
  }
});

/* Mock ReactFlow used by LiveGraph via ImpactGraph */
vi.mock('reactflow', () => ({
  __esModule: true,
  default: ({ nodes, children }: { nodes: Array<{ id: string }>; children?: React.ReactNode }) => (
    <div data-testid="mock-reactflow" data-nodes={nodes?.length ?? 0}>
      {children}
    </div>
  ),
  MiniMap: () => React.createElement('div', { 'data-testid': 'minimap' }),
  Controls: () => React.createElement('div', { 'data-testid': 'controls' }),
  Background: () => React.createElement('div', { 'data-testid': 'background' }),
  Handle: () => React.createElement('div'),
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  getBezierPath: () => ['M 0 0', 0, 0] as const,
}));

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */
const mockCompareMutate = vi.fn();
const mockCompareReset = vi.fn();

/** Mutable mutation state for compare:execute. */
let mockCompareMutationState = {
  mutate: mockCompareMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockCompareReset,
};

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => ({ data: null, loading: false, error: null, refetch: vi.fn() }),
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    if (type === 'compare:execute') {
      return mockCompareMutationState;
    }
    return { mutate: vi.fn(), data: null, loading: false, error: null, reset: vi.fn() };
  },
}));

const twoOrgs = [
  {
    id: 'org-1',
    alias: 'Dev',
    username: 'dev@test.com',
    instanceUrl: 'https://dev.salesforce.com',
    orgId: 'oid-1',
    orgType: 'Sandbox' as const,
    authMethod: 'oauth_web' as const,
    safetyTier: OrgSafetyTier.LOW,
    status: 'connected' as const,
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
  },
  {
    id: 'org-2',
    alias: 'Prod',
    username: 'prod@test.com',
    instanceUrl: 'https://prod.salesforce.com',
    orgId: 'oid-2',
    orgType: 'Production' as const,
    authMethod: 'oauth_web' as const,
    safetyTier: OrgSafetyTier.CRITICAL,
    status: 'connected' as const,
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
  },
];

describe('ComparePage', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: twoOrgs, selectedOrgId: null });
    mockCompareMutate.mockClear();
    mockCompareReset.mockClear();
    // Reset to default idle state
    mockCompareMutationState = {
      mutate: mockCompareMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockCompareReset,
    };
  });

  it('should show empty state with fewer than 2 orgs', () => {
    useOrgStore.setState({ orgs: [twoOrgs[0]] });
    render(<ComparePage />);
    expect(screen.getAllByText('Select two orgs to compare').length).toBeGreaterThan(0);
  });

  it('should render the compare page', () => {
    render(<ComparePage />);
    expect(screen.getByTestId('compare-page')).toBeDefined();
  });

  it('should render the title', () => {
    render(<ComparePage />);
    expect(screen.getByTestId('page-header')).toBeDefined();
    expect(screen.getByText('Compare Org')).toBeDefined();
  });

  it('should render org selector', () => {
    render(<ComparePage />);
    expect(screen.getByTestId('org-selector')).toBeDefined();
  });

  it('should render category selector', () => {
    render(<ComparePage />);
    expect(screen.getByTestId('category-selector')).toBeDefined();
  });

  it('should render run button', () => {
    render(<ComparePage />);
    expect(screen.getByTestId('run-compare-btn')).toBeDefined();
  });

  it('should disable run button when orgs not selected', () => {
    render(<ComparePage />);
    expect(screen.getByTestId('run-compare-btn').hasAttribute('disabled')).toBe(true);
  });

  it('should show no results message when no result', () => {
    render(<ComparePage />);
    expect(screen.getAllByText('No comparison results yet').length).toBeGreaterThan(0);
  });

  it('should show summary when compare mutation returns data', () => {
    mockCompareMutationState = {
      mutate: mockCompareMutate,
      data: {
        configId: 'cfg-1',
        sourceOrgId: 'org-1',
        targetOrgId: 'org-2',
        mode: 'metadata',
        summary: { totalItems: 100, added: 5, removed: 3, modified: 10, unchanged: 82, byType: {} },
        diffs: [{ componentType: 'ApexClass', fullName: 'TestClass', status: 'modified', sourceValue: 'v1', targetValue: 'v2', severity: 'warning', deployable: true }],
        timestamp: '2024-01-01T12:00:00Z',
        duration: 5000,
      },
      loading: false,
      error: null,
      reset: mockCompareReset,
    };
    render(<ComparePage />);

    expect(screen.getByTestId('compare-summary')).toBeDefined();
    expect(screen.getByText(/\+5 Added/)).toBeDefined();
    expect(screen.getByText(/-3 Removed/)).toBeDefined();
  });

  it('should show tabs when result is received', () => {
    mockCompareMutationState = {
      mutate: mockCompareMutate,
      data: {
        configId: 'cfg-1',
        sourceOrgId: 'org-1',
        targetOrgId: 'org-2',
        mode: 'metadata',
        summary: { totalItems: 100, added: 5, removed: 3, modified: 10, unchanged: 82, byType: {} },
        diffs: [],
        timestamp: '2024-01-01T12:00:00Z',
        duration: 5000,
      },
      loading: false,
      error: null,
      reset: mockCompareReset,
    };
    render(<ComparePage />);

    expect(screen.getByText('Diff Viewer')).toBeDefined();
    expect(screen.getByText('Permission Matrix')).toBeDefined();
    expect(screen.getByText('Deploy from Diff')).toBeDefined();
  });

  it('should display error from bridge mutation', () => {
    mockCompareMutationState = {
      mutate: mockCompareMutate,
      data: null,
      loading: false,
      error: 'Compare failed',
      reset: mockCompareReset,
    };
    render(<ComparePage />);

    expect(screen.getByTestId('compare-error')).toBeDefined();
    expect(screen.getByText('Compare failed')).toBeDefined();
  });
});

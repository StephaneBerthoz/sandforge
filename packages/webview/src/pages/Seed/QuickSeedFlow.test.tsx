import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { QuickSeedFlow } from './QuickSeedFlow';
import type { QuickSeedState } from './useQuickSeed';
import type { SalesforceOrg, SeedTemplate, SeedExecutionResult } from '@sandforge/shared';

/* ------------------------------------------------------------------ */
/* Test fixtures                                                       */
/* ------------------------------------------------------------------ */

const mockTemplate: SeedTemplate = {
  id: 'prebuilt-minimal-demo',
  name: 'seed.templates.minimalDemo.name',
  description: 'seed.templates.minimalDemo.description',
  version: 1,
  strategy: 'faker',
  objects: [
    { objectApiName: 'Account', recordCount: 50, fieldRules: [], excludedFields: [], insertOrder: 0, batchSize: 200 },
    { objectApiName: 'Contact', recordCount: 100, fieldRules: [], excludedFields: [], insertOrder: 1, batchSize: 200 },
  ],
  tags: ['prebuilt', 'demo'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const mockOrgs: SalesforceOrg[] = [
  { id: 'org-1', alias: 'dev1', username: 'user@dev1.com', instanceUrl: 'https://dev1.sf.com', orgType: 'sandbox', status: 'connected', safetyTier: 'low', apiVersion: '59.0', lastConnected: '2024-01-01T00:00:00Z' },
];

const mockExecutionResult: SeedExecutionResult = {
  templateId: 'prebuilt-minimal-demo',
  operationId: 'op-1',
  status: 'success',
  objectResults: [
    { objectApiName: 'Account', recordsCreated: 50, recordsFailed: 0, createdIds: [], errors: [] },
    { objectApiName: 'Contact', recordsCreated: 100, recordsFailed: 0, createdIds: [], errors: [] },
  ],
  totalRecordsCreated: 150,
  totalRecordsFailed: 0,
  duration: 5000,
  timestamp: '2026-03-26T00:00:00Z',
};

const baseQuickSeed: QuickSeedState = {
  phase: 'idle',
  selectedTemplate: null,
  customizedCounts: {},
  selectedOrgId: '',
  isRunning: false,
  executionResult: undefined,
  objectProgress: [],
  overallPercent: 0,
  elapsedMs: 0,
  error: null,
  startQuickSeed: vi.fn(),
  selectOrg: vi.fn(),
  execute: vi.fn(),
  reset: vi.fn(),
  setError: vi.fn(),
};

/* Mock GrappeProgressPanel used inside Step7Execute */
vi.mock('../../stores/useGrappeStore', () => ({
  useGrappeStore: () => ({ active: false, operationId: null }),
}));

describe('QuickSeedFlow', () => {
  it('renders org selector in selectOrg phase', () => {
    const quickSeed: QuickSeedState = {
      ...baseQuickSeed,
      phase: 'selectOrg',
      selectedTemplate: mockTemplate,
    };

    render(<QuickSeedFlow quickSeed={quickSeed} orgs={mockOrgs} />);

    expect(screen.getByTestId('quick-seed-flow')).toBeDefined();
    expect(screen.getByTestId('quick-seed-select-org')).toBeDefined();
    expect(screen.getByTestId('quick-seed-org-selector')).toBeDefined();
    expect(screen.getByTestId('btn-quick-seed-start')).toBeDefined();
  });

  it('renders Step7Execute in executing phase', () => {
    const quickSeed: QuickSeedState = {
      ...baseQuickSeed,
      phase: 'executing',
      selectedTemplate: mockTemplate,
      isRunning: true,
      objectProgress: [
        { objectApiName: 'Account', total: 50, completed: 0, failed: 0, status: 'running' },
        { objectApiName: 'Contact', total: 100, completed: 0, failed: 0, status: 'running' },
      ],
      overallPercent: 50,
      elapsedMs: 2000,
    };

    render(<QuickSeedFlow quickSeed={quickSeed} orgs={mockOrgs} />);

    expect(screen.getByTestId('quick-seed-executing')).toBeDefined();
    expect(screen.getByTestId('step-execute')).toBeDefined();
  });

  it('renders results with execution summary in results phase', () => {
    const quickSeed: QuickSeedState = {
      ...baseQuickSeed,
      phase: 'results',
      selectedTemplate: mockTemplate,
      executionResult: mockExecutionResult,
      overallPercent: 100,
    };

    render(<QuickSeedFlow quickSeed={quickSeed} orgs={mockOrgs} />);

    expect(screen.getByTestId('quick-seed-results')).toBeDefined();
    expect(screen.getByTestId('quick-seed-result-summary')).toBeDefined();
    expect(screen.getByText('150')).toBeDefined();
    expect(screen.getByTestId('btn-back-to-gallery')).toBeDefined();
    expect(screen.getByTestId('btn-seed-again-quick')).toBeDefined();
  });

  it('shows error banner when error is set', () => {
    const quickSeed: QuickSeedState = {
      ...baseQuickSeed,
      phase: 'selectOrg',
      selectedTemplate: mockTemplate,
      error: 'Connection failed',
    };

    render(<QuickSeedFlow quickSeed={quickSeed} orgs={mockOrgs} />);

    expect(screen.getByText('Connection failed')).toBeDefined();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { ReviewComplianceTab } from './ReviewComplianceTab';
import type { ComplianceReport, ForgeGraph, ForgeConfig } from '@sandforge/shared';

/* ---- Mocks ---- */

let mockComplianceReport: ComplianceReport | null = null;
let mockGraph: ForgeGraph | null = null;
let mockConfig: ForgeConfig | null = null;
const mockSetComplianceReport = vi.fn();
const mockSendMessage = vi.fn();

vi.mock('../../stores/useForgeStore', () => {
  const store = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        get complianceReport() {
          return mockComplianceReport;
        },
        get graph() {
          return mockGraph;
        },
        get config() {
          return mockConfig;
        },
        get setComplianceReport() {
          return mockSetComplianceReport;
        },
      }),
    {
      getState: () => ({
        complianceReport: mockComplianceReport,
        graph: mockGraph,
        config: mockConfig,
        setComplianceReport: mockSetComplianceReport,
      }),
    },
  );
  return { useForgeStore: store };
});

vi.mock('../../hooks/useMessageBus', () => ({
  useSendMessage: () => mockSendMessage,
  useMessageListener: vi.fn(),
}));

vi.mock('../../bridge/messageHelpers', () => ({
  buildMessage: vi.fn((type: string, payload: unknown) => ({
    id: `test-${Date.now()}`,
    type,
    timestamp: Date.now(),
    payload,
  })),
}));

/* ---- Helpers ---- */

const makeReport = (
  overrides: Partial<ComplianceReport> = {},
): ComplianceReport => ({
  id: 'rpt-001',
  framework: 'gdpr',
  generatedAt: '2026-03-11T10:00:00Z',
  sourceOrgId: 'src-1',
  targetOrgId: 'tgt-1',
  totalFieldsScanned: 120,
  piiFieldsDetected: 15,
  piiFieldsAnonymized: 12,
  entries: [],
  objectSummaries: [],
  overallStatus: 'pass',
  checksumSha256: 'abc123',
  ...overrides,
});

const makeGraph = (): ForgeGraph => ({
  nodes: [
    {
      objectApiName: 'Account',
      recordCount: 10,
      fieldCount: 5,
      status: 'idle',
      progress: 0,
      included: true,
      piiFields: [],
      anonymizeFields: [],
      errors: [],
      level: 0,
      successCount: 0,
      failureCount: 0,
      createableFieldCount: 0,
      estimatedSizeMB: 0,
      estimatedApiCalls: 0,
      batchStrategy: 'auto',
    },
  ],
  edges: [],
  totalRecords: 10,
  estimatedSizeMB: 0.01,
  estimatedDurationSeconds: 0.1,
});

const makeConfig = (): ForgeConfig => ({
  inputMode: 'record',
  recordId: '001XXXXXXXXXX',
  depth: 'direct',
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
  anonymizePII: false,
  skipEmpty: false,
  batchSize: 'auto',
});

/* ---- Tests ---- */

beforeEach(() => {
  vi.clearAllMocks();
  mockComplianceReport = null;
  mockGraph = null;
  mockConfig = null;
});

describe('ReviewComplianceTab', () => {
  it('should render with data-testid', () => {
    render(<ReviewComplianceTab />);
    expect(screen.getByTestId('review-compliance-tab')).toBeDefined();
  });

  it('should have framework select with 5 options', () => {
    render(<ReviewComplianceTab />);
    const select = screen.getByTestId('framework-select') as HTMLSelectElement;
    expect(select.options.length).toBe(5);
  });

  it('should show no-compliance message when framework is none', () => {
    render(<ReviewComplianceTab />);
    expect(screen.getByTestId('no-compliance')).toBeDefined();
  });

  it('should show loading message when framework selected with graph and config', () => {
    mockGraph = makeGraph();
    mockConfig = makeConfig();
    render(<ReviewComplianceTab />);
    const select = screen.getByTestId('framework-select');
    fireEvent.change(select, { target: { value: 'gdpr' } });
    expect(screen.getByTestId('compliance-loading')).toBeDefined();
    expect(screen.queryByTestId('no-compliance')).toBeNull();
  });

  it('should send forge:compliance:request when framework is not none and graph+config exist', () => {
    mockGraph = makeGraph();
    mockConfig = makeConfig();
    render(<ReviewComplianceTab />);
    const select = screen.getByTestId('framework-select');
    fireEvent.change(select, { target: { value: 'gdpr' } });
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'forge:compliance:request',
        payload: expect.objectContaining({
          framework: 'gdpr',
          graph: mockGraph,
          config: mockConfig,
        }),
      }),
    );
  });

  it('should NOT send request when framework is none', () => {
    mockGraph = makeGraph();
    mockConfig = makeConfig();
    render(<ReviewComplianceTab />);
    // Framework starts as 'none', so no request should be sent
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('should NOT send request when graph is null', () => {
    mockGraph = null;
    mockConfig = makeConfig();
    render(<ReviewComplianceTab />);
    const select = screen.getByTestId('framework-select');
    fireEvent.change(select, { target: { value: 'gdpr' } });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('should show compliance report when available', () => {
    mockComplianceReport = makeReport();
    render(<ReviewComplianceTab />);
    // Select a framework to trigger report display
    const select = screen.getByTestId('framework-select');
    fireEvent.change(select, { target: { value: 'gdpr' } });
    expect(screen.getByTestId('compliance-report')).toBeDefined();
    const report = screen.getByTestId('compliance-report');
    expect(report.textContent).toContain('15 PII fields detected');
    expect(report.textContent).toContain('12 fields anonymized');
  });

  it('should display correct status badge for partial compliance', () => {
    mockComplianceReport = makeReport({ overallStatus: 'partial' });
    render(<ReviewComplianceTab />);
    const select = screen.getByTestId('framework-select');
    fireEvent.change(select, { target: { value: 'gdpr' } });
    const report = screen.getByTestId('compliance-report');
    expect(report.textContent).toContain('PARTIAL');
  });
});

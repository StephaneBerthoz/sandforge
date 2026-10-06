import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import { ReviewComplianceTab } from './ReviewComplianceTab';
import { useForgeStore } from '../../stores/useForgeStore';
import type { ComplianceReport, ForgeGraph, ForgeConfig } from '@sandforge/shared';

/* ---- The bridge, answered through window messages ---- */

const mockVSCodeApi = vi.hoisted(() => ({
  postMessage: vi.fn(),
  getState: () => undefined,
  setState: () => undefined,
}));

vi.mock('../../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => mockVSCodeApi,
  useVSCodeApi: () => mockVSCodeApi,
}));

/** The compliance requests the tab sent, envelope-unwrapped, oldest first. */
function sentRequests(): Array<{ id: string; payload: Record<string, unknown> }> {
  return mockVSCodeApi.postMessage.mock.calls
    .map(([envelope]) => (envelope as { payload: { id: string; type: string } }).payload)
    .filter((message) => message.type === 'forge:compliance:request') as unknown as Array<{
    id: string;
    payload: Record<string, unknown>;
  }>;
}

/** The latest compliance request the tab sent. */
function lastRequest(): { id: string; payload: Record<string, unknown> } {
  const requests = sentRequests();
  expect(requests.length).toBeGreaterThan(0);
  return requests[requests.length - 1];
}

/** Answer a request as the extension does, on the type given. */
function answer(type: string, correlationId: string, payload: unknown): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { id: `ext-${type}`, type, timestamp: Date.now(), correlationId, payload },
      }),
    );
  });
}

/* ---- Helpers ---- */

const makeReport = (overrides: Partial<ComplianceReport> = {}): ComplianceReport => ({
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
      piiFields: ['Phone'],
      anonymizeFields: ['Phone'],
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
  recordId: '001000000000001',
  depth: 'direct',
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
  anonymizePII: true,
  skipEmpty: false,
  batchSize: 'auto',
});

/** Pick a framework on the tab. */
function pick(framework: string): void {
  fireEvent.change(screen.getByTestId('framework-select'), { target: { value: framework } });
}

/* ---- Tests ---- */

beforeEach(() => {
  mockVSCodeApi.postMessage.mockClear();
  useForgeStore.setState({
    graph: makeGraph(),
    config: makeConfig(),
    complianceReport: null,
    anonymizationRules: { ...useForgeStore.getState().anonymizationRules, phone: 'nullify' },
  });
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

  it('should show no-compliance message, and ask for nothing, when framework is none', () => {
    render(<ReviewComplianceTab />);
    expect(screen.getByTestId('no-compliance')).toBeDefined();
    expect(sentRequests()).toHaveLength(0);
  });

  it('asks for a report on the run as it stands: its toggle, its fields and its methods', () => {
    // The methods Review holds were never sent: the report described every
    // personal field as faked.
    render(<ReviewComplianceTab />);
    pick('gdpr');

    expect(screen.getByTestId('compliance-loading')).toBeDefined();
    expect(screen.queryByTestId('no-compliance')).toBeNull();
    const { payload } = lastRequest();
    expect(payload.framework).toBe('gdpr');
    expect(payload.graph).toEqual(makeGraph());
    expect(payload.config).toEqual(makeConfig());
    expect(payload.anonymizationRules).toEqual(useForgeStore.getState().anonymizationRules);
    expect((payload.anonymizationRules as Record<string, string>).phone).toBe('nullify');
  });

  it('shows the report the extension answers', () => {
    render(<ReviewComplianceTab />);
    pick('gdpr');
    answer('forge:compliance:response', lastRequest().id, { report: makeReport() });

    const report = screen.getByTestId('compliance-report');
    expect(report.textContent).toContain('15 PII fields detected');
    expect(report.textContent).toContain('12 fields anonymized');
    expect(screen.queryByTestId('compliance-loading')).toBeNull();
  });

  it('says the status of a partial report in words, not its code', () => {
    render(<ReviewComplianceTab />);
    pick('gdpr');
    answer('forge:compliance:response', lastRequest().id, {
      report: makeReport({ overallStatus: 'partial' }),
    });

    expect(screen.getByTestId('compliance-status').textContent).toBe('Partial');
    expect(screen.getByTestId('compliance-report').textContent).not.toMatch(/partial|PARTIAL/);
  });

  it('says the status in the language the panel is set to', async () => {
    // The badge printed the code upper-cased, "PASS", in every language.
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await i18n.changeLanguage('fr');
    try {
      render(<ReviewComplianceTab />);
      pick('gdpr');
      answer('forge:compliance:response', lastRequest().id, {
        report: makeReport({ overallStatus: 'fail' }),
      });

      expect(screen.getByTestId('compliance-status').textContent).toBe(
        fr.forge.review.complianceFail,
      );
      expect(screen.getByTestId('compliance-report').textContent).not.toMatch(/\bfail\b/i);
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('says why the report could not be made, instead of analyzing for good, and retries', () => {
    // `forge:compliance:error` had no listener: the tab read "Analyzing
    // compliance..." forever.
    render(<ReviewComplianceTab />);
    pick('gdpr');
    answer('forge:compliance:error', lastRequest().id, {
      message: 'Compliance service not configured',
      code: 'NOT_INITIALIZED',
      retryable: false,
    });

    expect(screen.queryByTestId('compliance-loading')).toBeNull();
    expect(screen.getByTestId('compliance-error-message').textContent).toBe(
      'The compliance report could not be made: Compliance service not configured',
    );

    fireEvent.click(screen.getByTestId('compliance-retry'));
    expect(sentRequests()).toHaveLength(2);
    expect(screen.getByTestId('compliance-loading')).toBeDefined();
    expect(screen.queryByTestId('compliance-error')).toBeNull();

    answer('forge:compliance:response', lastRequest().id, { report: makeReport() });
    expect(screen.getByTestId('compliance-report')).toBeDefined();
  });

  it('asks again on another framework, and does not show the last one’s report as its own', () => {
    render(<ReviewComplianceTab />);
    pick('gdpr');
    answer('forge:compliance:response', lastRequest().id, { report: makeReport() });

    pick('hipaa');
    expect(lastRequest().payload.framework).toBe('hipaa');
    expect(screen.queryByTestId('compliance-report')).toBeNull();
    expect(screen.getByTestId('compliance-loading')).toBeDefined();

    answer('forge:compliance:response', lastRequest().id, {
      report: makeReport({ framework: 'hipaa', overallStatus: 'fail' }),
    });
    expect(screen.getByTestId('compliance-status').textContent).toBe('Fail');
  });

  it('asks again when a method of the run changes', () => {
    render(<ReviewComplianceTab />);
    pick('gdpr');
    answer('forge:compliance:response', lastRequest().id, { report: makeReport() });

    act(() => {
      useForgeStore.getState().setAnonymizationRule('email', 'hash');
    });
    expect(sentRequests()).toHaveLength(2);
    expect((lastRequest().payload.anonymizationRules as Record<string, string>).email).toBe('hash');
  });

  it('should NOT send request when graph is null', () => {
    useForgeStore.setState({ graph: null });
    render(<ReviewComplianceTab />);
    pick('gdpr');
    expect(sentRequests()).toHaveLength(0);
  });

  it('says, while no report is there, that it comes on selection rather than once the run is executed', () => {
    // It said "Select a framework and execute to generate compliance report":
    // the report is asked for as soon as a framework is selected.
    useForgeStore.setState({ graph: null });
    render(<ReviewComplianceTab />);
    pick('gdpr');

    const waiting = screen.getByTestId('compliance-waiting').textContent ?? '';
    expect(waiting).toBe(
      'The report is made as soon as a framework is selected, from the run as it stands.',
    );
    expect(waiting).not.toMatch(/execute/i);
  });
});

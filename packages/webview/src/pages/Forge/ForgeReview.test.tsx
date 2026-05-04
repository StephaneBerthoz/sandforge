import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { ForgeReview } from './ForgeReview';
import type { ForgeGraphNode, ForgeGraph } from '../../stores/useForgeStore';
import type { MetadataDiffEntry } from '../../stores/useForgeStore';
import type { ForgeAnonymizationCategory, AnonymizationMethod } from '@sandforge/shared';

/* ---- Mocks ---- */

const mockSetPhase = vi.fn();
const mockToggleNodeIncluded = vi.fn();

function makeNode(overrides: Partial<ForgeGraphNode> = {}): ForgeGraphNode {
  return {
    objectApiName: 'Account',
    recordCount: 100,
    fieldCount: 20,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 0,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'auto',
    ...overrides,
  };
}

const defaultGraph: ForgeGraph = {
  nodes: [
    makeNode({ objectApiName: 'Account', piiFields: ['Email'] }),
    makeNode({ objectApiName: 'Contact', piiFields: ['Phone', 'FirstName'] }),
  ],
  edges: [],
  totalRecords: 200,
  estimatedSizeMB: 2,
  estimatedDurationSeconds: 10,
};

let mockGraph: ForgeGraph | null = defaultGraph;
let mockConfig: { anonymizePII: boolean } | null = { anonymizePII: true };
let mockMetadataDiffs: MetadataDiffEntry[] = [];
const mockAnonymizationRules: Record<ForgeAnonymizationCategory, AnonymizationMethod> = {
  email: 'fake',
  phone: 'mask',
  name: 'fake',
  address: 'fake',
  ssn_id: 'redact',
  financial: 'hash',
  other: 'nullify',
};

vi.mock('../../stores/useForgeStore', () => {
  const defaultState = {
    get graph() {
      return mockGraph;
    },
    get config() {
      return mockConfig;
    },
    get metadataDiffs() {
      return mockMetadataDiffs;
    },
    get anonymizationRules() {
      return mockAnonymizationRules;
    },
    plan: null,
    complianceReport: null,
    setPhase: (...args: unknown[]) => mockSetPhase(...args),
    toggleNodeIncluded: (...args: unknown[]) => mockToggleNodeIncluded(...args),
    setAnonymizationRule: vi.fn(),
    updateNodeBatchStrategy: vi.fn(),
  };

  const store = Object.assign(
    (selector: (state: typeof defaultState) => unknown) => selector(defaultState),
    { getState: () => defaultState },
  );
  return { useForgeStore: store };
});

vi.mock('../../components/graph/LiveGraph', () => ({
  LiveGraph: ({ onIncludeToggle }: { onIncludeToggle?: (name: string) => void }) => (
    <div data-testid="live-graph">
      <button data-testid="mock-toggle-Account" onClick={() => onIncludeToggle?.('Account')}>
        Toggle Account
      </button>
    </div>
  ),
}));

/* ---- Tests ---- */

describe('ForgeReview', () => {
  beforeEach(() => {
    mockSetPhase.mockClear();
    mockToggleNodeIncluded.mockClear();
    mockGraph = defaultGraph;
    mockConfig = { anonymizePII: true };
    mockMetadataDiffs = [];
  });

  it('should render with data-testid="forge-review"', () => {
    render(<ForgeReview />);
    expect(screen.getByTestId('forge-review')).toBeDefined();
  });

  it('should have 4 tabs (plan, anonymization, compliance, metadata)', () => {
    render(<ForgeReview />);
    expect(screen.getByTestId('tab-plan')).toBeDefined();
    expect(screen.getByTestId('tab-anonymization')).toBeDefined();
    expect(screen.getByTestId('tab-compliance')).toBeDefined();
    expect(screen.getByTestId('tab-metadata')).toBeDefined();
  });

  it('should have Plan tab active by default', () => {
    render(<ForgeReview />);
    // ReviewPlanTab renders plan-loading when plan is null
    expect(screen.getByTestId('plan-loading')).toBeDefined();
  });

  it('should render execute button', () => {
    render(<ForgeReview />);
    expect(screen.getByTestId('execute-button')).toBeDefined();
  });

  it('should call setPhase("discovery") when back button clicked', () => {
    render(<ForgeReview />);
    fireEvent.click(screen.getByTestId('back-button'));
    expect(mockSetPhase).toHaveBeenCalledWith('discovery');
  });

  it('should call setPhase("execution") when execute button clicked', () => {
    render(<ForgeReview />);
    fireEvent.click(screen.getByTestId('execute-button'));
    expect(mockSetPhase).toHaveBeenCalledWith('execution');
  });

  it('should disable anonymization tab when anonymizePII is false', () => {
    mockConfig = { anonymizePII: false };
    render(<ForgeReview />);
    const anonTab = screen.getByTestId('tab-anonymization');
    expect(anonTab).toHaveProperty('disabled', true);
  });

  it('should show PII badge on anonymization tab', () => {
    render(<ForgeReview />);
    const anonTab = screen.getByTestId('tab-anonymization');
    // 1 PII from Account + 2 from Contact = 3
    expect(anonTab.textContent).toContain('3');
  });

  it('should show metadata badge when diffs are present', () => {
    mockMetadataDiffs = [
      {
        objectApiName: 'Account',
        fieldApiName: 'X',
        issue: 'missing',
        severity: 'error',
        details: 'x',
      },
    ];
    render(<ForgeReview />);
    const metaTab = screen.getByTestId('tab-metadata');
    expect(metaTab.textContent).toContain('1');
  });

  it('should switch tabs on click', () => {
    render(<ForgeReview />);
    fireEvent.click(screen.getByTestId('tab-compliance'));
    // ReviewComplianceTab renders no-compliance by default
    expect(screen.getByTestId('review-compliance-tab')).toBeDefined();
  });

  it('should render live graph and support include toggle', () => {
    render(<ForgeReview />);
    expect(screen.getByTestId('live-graph')).toBeDefined();
    fireEvent.click(screen.getByTestId('mock-toggle-Account'));
    expect(mockToggleNodeIncluded).toHaveBeenCalledWith('Account');
  });

  /* ---- A11Y: Tab ARIA roles ---- */

  it('should have role="tablist" on the tab container', () => {
    render(<ForgeReview />);
    expect(screen.getByTestId('review-tabs').getAttribute('role')).toBe('tablist');
  });

  it('should have role="tab" and aria-selected on each tab button', () => {
    render(<ForgeReview />);
    const planTab = screen.getByTestId('tab-plan');
    const complianceTab = screen.getByTestId('tab-compliance');
    expect(planTab.getAttribute('role')).toBe('tab');
    expect(planTab.getAttribute('aria-selected')).toBe('true');
    expect(complianceTab.getAttribute('role')).toBe('tab');
    expect(complianceTab.getAttribute('aria-selected')).toBe('false');
  });

  it('should update aria-selected when switching tabs', () => {
    render(<ForgeReview />);
    const planTab = screen.getByTestId('tab-plan');
    const complianceTab = screen.getByTestId('tab-compliance');
    expect(planTab.getAttribute('aria-selected')).toBe('true');
    expect(complianceTab.getAttribute('aria-selected')).toBe('false');

    fireEvent.click(complianceTab);
    expect(planTab.getAttribute('aria-selected')).toBe('false');
    expect(complianceTab.getAttribute('aria-selected')).toBe('true');
  });

  it('should have role="tabpanel" with aria-labelledby on tab content', () => {
    render(<ForgeReview />);
    const tabpanel = screen.getByRole('tabpanel');
    expect(tabpanel.getAttribute('id')).toBe('tabpanel-plan');
    expect(tabpanel.getAttribute('aria-labelledby')).toBe('tab-plan');
  });
});

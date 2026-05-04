import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GovernancePanel, GovernancePanelConnected } from './GovernancePanel';
import type { GovernancePolicySummary, GovernanceRuleDisplay } from './GovernancePanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue: string) => defaultValue,
  }),
}));

/* ------------------------------------------------------------------ */
/* Bridge hook mocks for GovernancePanelConnected                      */
/* ------------------------------------------------------------------ */
const mockPoliciesRefetch = vi.fn();
const mockEvaluateMutate = vi.fn();
const mockEvaluateReset = vi.fn();
const mockDeleteMutate = vi.fn();
const mockDeleteReset = vi.fn();
const mockSaveMutate = vi.fn();
const mockSaveReset = vi.fn();

let mockPoliciesData: { policies: GovernancePolicySummary[] } | null = null;
let mockTemplatesData: {
  templates: Array<{
    id: string;
    name: string;
    description: string;
    rules: Array<Record<string, unknown>>;
    createdAt: string;
    updatedAt: string;
  }>;
} | null = null;
let mockEvaluateData: {
  success: boolean;
  result: {
    policyId: string;
    policyName: string;
    evaluatedAt: string;
    complianceScore: number;
    ruleResults: GovernanceRuleDisplay[];
    remediations: string[];
  };
} | null = null;
let mockDeleteData: { success: boolean } | null = null;
let mockSaveData: { success: boolean } | null = null;
let mockEvaluateLoading = false;

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => {
    if (type === 'governance:policies:list') {
      return { data: mockPoliciesData, loading: false, error: null, refetch: mockPoliciesRefetch };
    }
    if (type === 'governance:templates') {
      return { data: mockTemplatesData, loading: false, error: null, refetch: vi.fn() };
    }
    return { data: null, loading: false, error: null, refetch: vi.fn() };
  },
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    if (type === 'governance:evaluate') {
      return {
        mutate: mockEvaluateMutate,
        data: mockEvaluateData,
        loading: mockEvaluateLoading,
        error: null,
        reset: mockEvaluateReset,
      };
    }
    if (type === 'governance:policy:delete') {
      return {
        mutate: mockDeleteMutate,
        data: mockDeleteData,
        loading: false,
        error: null,
        reset: mockDeleteReset,
      };
    }
    if (type === 'governance:policy:save') {
      return {
        mutate: mockSaveMutate,
        data: mockSaveData,
        loading: false,
        error: null,
        reset: mockSaveReset,
      };
    }
    return { mutate: vi.fn(), data: null, loading: false, error: null, reset: vi.fn() };
  },
}));

vi.mock('../../stores/useOrgStore', () => ({
  useOrgStore: (selector: (s: { selectedOrgId: string | null }) => unknown) =>
    selector({ selectedOrgId: 'org-test-1' }),
}));

function makePolicy(overrides: Partial<GovernancePolicySummary> = {}): GovernancePolicySummary {
  return {
    id: 'pol-1',
    name: 'Security Policy',
    description: 'Default security governance',
    ruleCount: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeRuleResult(overrides: Partial<GovernanceRuleDisplay> = {}): GovernanceRuleDisplay {
  return {
    ruleId: 'rule-1',
    ruleName: 'MFA Enabled',
    category: 'security',
    status: 'pass',
    actualValue: 100,
    threshold: 100,
    message: 'MFA: compliant',
    remediation: '',
    ...overrides,
  };
}

describe('GovernancePanel', () => {
  it('renders the panel', () => {
    render(<GovernancePanel />);
    expect(screen.getByTestId('governance-panel')).toBeTruthy();
  });

  it('shows no-policies message when empty', () => {
    render(<GovernancePanel policies={[]} />);
    expect(screen.getByTestId('no-policies')).toBeTruthy();
  });

  it('renders policy list', () => {
    const policies = [
      makePolicy({ id: 'pol-1' }),
      makePolicy({ id: 'pol-2', name: 'Performance Policy' }),
    ];
    render(<GovernancePanel policies={policies} />);
    expect(screen.getByTestId('policy-pol-1')).toBeTruthy();
    expect(screen.getByTestId('policy-pol-2')).toBeTruthy();
  });

  it('selects a policy on click', () => {
    const policies = [makePolicy()];
    render(<GovernancePanel policies={policies} />);
    fireEvent.click(screen.getByTestId('policy-pol-1'));
    const policyEl = screen.getByTestId('policy-pol-1');
    expect(policyEl.className).toContain('focusBorder');
  });

  it('shows compliance score', () => {
    render(<GovernancePanel complianceScore={85} />);
    expect(screen.getByTestId('compliance-score')).toBeTruthy();
    expect(screen.getByText('85%')).toBeTruthy();
  });

  it('renders rule results', () => {
    const results = [
      makeRuleResult({ ruleId: 'r1', status: 'pass' }),
      makeRuleResult({ ruleId: 'r2', status: 'fail', ruleName: 'API Usage' }),
    ];
    render(<GovernancePanel ruleResults={results} />);
    expect(screen.getByTestId('rule-results')).toBeTruthy();
    expect(screen.getByTestId('rule-result-r1')).toBeTruthy();
    expect(screen.getByTestId('rule-result-r2')).toBeTruthy();
  });

  it('renders remediations checklist', () => {
    const remediations = ['Enable MFA', 'Reduce API calls'];
    render(<GovernancePanel remediations={remediations} />);
    expect(screen.getByTestId('remediations')).toBeTruthy();
    expect(screen.getByText('Enable MFA')).toBeTruthy();
    expect(screen.getByText('Reduce API calls')).toBeTruthy();
  });

  it('calls onEvaluate with selected policy', () => {
    const onEvaluate = vi.fn();
    const policies = [makePolicy()];
    render(<GovernancePanel policies={policies} onEvaluate={onEvaluate} />);
    fireEvent.click(screen.getByTestId('policy-pol-1'));
    fireEvent.click(screen.getByTestId('evaluate-btn'));
    expect(onEvaluate).toHaveBeenCalledWith('pol-1');
  });

  it('disables evaluate when no policy selected', () => {
    render(<GovernancePanel policies={[makePolicy()]} />);
    const btn = screen.getByTestId('evaluate-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('calls onDeletePolicy', () => {
    const onDeletePolicy = vi.fn();
    render(<GovernancePanel policies={[makePolicy()]} onDeletePolicy={onDeletePolicy} />);
    fireEvent.click(screen.getByTestId('delete-policy-pol-1'));
    expect(onDeletePolicy).toHaveBeenCalledWith('pol-1');
  });

  it('calls onAddPolicy', () => {
    const onAddPolicy = vi.fn();
    render(<GovernancePanel onAddPolicy={onAddPolicy} />);
    fireEvent.click(screen.getByTestId('add-policy-btn'));
    expect(onAddPolicy).toHaveBeenCalled();
  });

  it('shows loading state', () => {
    render(<GovernancePanel loading={true} />);
    const btn = screen.getByTestId('evaluate-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* GovernancePanelConnected tests                                      */
/* ------------------------------------------------------------------ */
describe('GovernancePanelConnected', () => {
  beforeEach(() => {
    mockPoliciesData = null;
    mockTemplatesData = null;
    mockEvaluateData = null;
    mockDeleteData = null;
    mockSaveData = null;
    mockEvaluateLoading = false;
    mockPoliciesRefetch.mockReset();
    mockEvaluateMutate.mockReset();
    mockEvaluateReset.mockReset();
    mockDeleteMutate.mockReset();
    mockDeleteReset.mockReset();
    mockSaveMutate.mockReset();
    mockSaveReset.mockReset();
  });

  it('renders the connected wrapper with GovernancePanel inside', () => {
    render(<GovernancePanelConnected />);
    expect(screen.getByTestId('governance-panel-connected')).toBeTruthy();
    expect(screen.getByTestId('governance-panel')).toBeTruthy();
  });

  it('displays policies from bridge query', () => {
    mockPoliciesData = {
      policies: [makePolicy({ id: 'bp-1', name: 'Bridge Policy' })],
    };
    render(<GovernancePanelConnected />);
    expect(screen.getByTestId('policy-bp-1')).toBeTruthy();
    expect(screen.getByText('Bridge Policy')).toBeTruthy();
  });

  it('shows no-policies message when bridge returns empty', () => {
    mockPoliciesData = { policies: [] };
    render(<GovernancePanelConnected />);
    expect(screen.getByTestId('no-policies')).toBeTruthy();
  });

  it('triggers evaluate mutation when evaluate is clicked', () => {
    mockPoliciesData = {
      policies: [makePolicy({ id: 'eval-1' })],
    };
    render(<GovernancePanelConnected />);
    fireEvent.click(screen.getByTestId('policy-eval-1'));
    fireEvent.click(screen.getByTestId('evaluate-btn'));
    expect(mockEvaluateMutate).toHaveBeenCalledWith({ policyId: 'eval-1', orgId: 'org-test-1' });
  });

  it('displays compliance score after evaluation', () => {
    mockPoliciesData = { policies: [makePolicy()] };
    mockEvaluateData = {
      success: true,
      result: {
        policyId: 'pol-1',
        policyName: 'Security Policy',
        evaluatedAt: '2026-03-20T12:00:00Z',
        complianceScore: 72,
        ruleResults: [makeRuleResult({ ruleId: 'r1', status: 'pass' })],
        remediations: ['Fix something'],
      },
    };
    render(<GovernancePanelConnected />);
    expect(screen.getByTestId('compliance-score')).toBeTruthy();
    expect(screen.getByText('72%')).toBeTruthy();
  });

  it('triggers delete mutation when delete is clicked', () => {
    mockPoliciesData = {
      policies: [makePolicy({ id: 'del-1' })],
    };
    render(<GovernancePanelConnected />);
    fireEvent.click(screen.getByTestId('delete-policy-del-1'));
    expect(mockDeleteMutate).toHaveBeenCalledWith({ policyId: 'del-1' });
  });

  it('triggers save mutation for templates when add-policy is clicked', () => {
    mockPoliciesData = { policies: [] };
    mockTemplatesData = {
      templates: [
        {
          id: 'tmpl-1',
          name: 'Template Security',
          description: 'Default',
          rules: [],
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    };
    render(<GovernancePanelConnected />);
    fireEvent.click(screen.getByTestId('add-policy-btn'));
    expect(mockSaveMutate).toHaveBeenCalledWith({
      policy: mockTemplatesData.templates[0],
    });
  });

  it('does not save templates that already exist as policies', () => {
    mockPoliciesData = {
      policies: [makePolicy({ id: 'tmpl-1' })],
    };
    mockTemplatesData = {
      templates: [
        {
          id: 'tmpl-1',
          name: 'Already exists',
          description: 'Skip',
          rules: [],
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    };
    render(<GovernancePanelConnected />);
    fireEvent.click(screen.getByTestId('add-policy-btn'));
    expect(mockSaveMutate).not.toHaveBeenCalled();
  });
});

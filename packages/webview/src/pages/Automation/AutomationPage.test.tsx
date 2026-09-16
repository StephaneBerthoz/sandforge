import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { AutomationPage } from './AutomationPage';

const mockOrgs: SalesforceOrg[] = [
  {
    id: 'org-1',
    alias: 'dev1',
    username: 'user@dev1.com',
    instanceUrl: 'https://dev1.salesforce.com',
    orgId: '00D000000000001',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#0070d2', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '59.0', edition: 'Developer Edition', features: [] },
    status: 'connected',
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
  },
];

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */
const mockExecuteMutate = vi.fn();
const mockExecuteReset = vi.fn();
const mockSaveMutate = vi.fn();
const mockSaveReset = vi.fn();

/** Mutable mutation state for pipeline:execute. */
let mockExecuteMutationState = {
  mutate: mockExecuteMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockExecuteReset,
};

/** Mutable mutation state for pipeline:save. */
let mockSaveMutationState = {
  mutate: mockSaveMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockSaveReset,
};

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => {
    if (type === 'pipeline:list') {
      return { data: null, loading: false, error: null, refetch: vi.fn() };
    }
    if (type === 'pipeline:templates') {
      return { data: null, loading: false, error: null, refetch: vi.fn() };
    }
    if (type === 'pipeline:history') {
      return { data: null, loading: false, error: null, refetch: vi.fn() };
    }
    return { data: null, loading: false, error: null, refetch: vi.fn() };
  },
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    if (type === 'pipeline:execute') {
      return mockExecuteMutationState;
    }
    if (type === 'pipeline:save') {
      return mockSaveMutationState;
    }
    return { mutate: vi.fn(), data: null, loading: false, error: null, reset: vi.fn() };
  },
}));

const mockNavigate = vi.fn();
vi.mock('../../stores/useAppStore', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ navigate: mockNavigate, currentRoute: 'automation' }),
}));

describe('AutomationPage', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
    mockNavigate.mockClear();
    mockExecuteMutate.mockClear();
    mockExecuteReset.mockClear();
    mockSaveMutate.mockClear();
    mockSaveReset.mockClear();
    // Reset to default idle state
    mockExecuteMutationState = {
      mutate: mockExecuteMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockExecuteReset,
    };
    mockSaveMutationState = {
      mutate: mockSaveMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockSaveReset,
    };
  });

  it('should show empty state when no orgs', () => {
    useOrgStore.setState({ orgs: [] });
    render(<AutomationPage />);
    expect(screen.getByTestId('empty-state')).toBeDefined();
    expect(screen.getByTestId('illustration-automation')).toBeDefined();
    expect(screen.getByTestId('empty-action-button')).toBeDefined();
  });

  it('should navigate to orgs when empty state CTA clicked', () => {
    useOrgStore.setState({ orgs: [] });
    render(<AutomationPage />);
    fireEvent.click(screen.getByTestId('empty-action-button'));
    expect(mockNavigate).toHaveBeenCalledWith('orgs');
  });

  it('should render the page', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    expect(screen.getByTestId('automation-page')).toBeDefined();
  });

  it('should show title', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    expect(screen.getByTestId('page-header')).toBeDefined();
    expect(screen.getByText('Automation')).toBeDefined();
  });

  it('should show create button when no pipeline', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    expect(screen.getByTestId('create-pipeline-btn')).toBeDefined();
  });

  it('names the generate dialog after its heading, keeps Tab inside it and closes it on Escape', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    fireEvent.click(screen.getByTestId('generate-pipeline-btn'));

    const dialog = screen.getByRole('dialog', { name: 'Generate with AI' });
    const input = screen.getByPlaceholderText(/describe/i);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(input);

    // The submit button is disabled while the description is empty, so Cancel
    // is the last control that can take focus.
    cancel.focus();
    fireEvent.keyDown(cancel, { key: 'Tab' });
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(cancel);

    fireEvent.keyDown(cancel, { key: 'Escape' });
    expect(dialog.isConnected).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('gives focus back to the generate button when its dialog closes on Escape', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    const opener = screen.getByTestId('generate-pipeline-btn');
    opener.focus();
    fireEvent.click(opener);

    const input = screen.getByPlaceholderText(/describe/i);
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('should show run button after creating pipeline', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    fireEvent.click(screen.getByTestId('create-pipeline-btn'));
    expect(screen.getByTestId('run-pipeline-btn')).toBeDefined();
  });

  it('should show tabs', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    expect(screen.getByRole('tablist')).toBeDefined();
    expect(screen.getAllByRole('tab').length).toBe(5);
  });

  it('should start on canvas tab', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    fireEvent.click(screen.getByTestId('create-pipeline-btn'));
    expect(screen.getByTestId('pipeline-canvas')).toBeDefined();
  });

  it('should switch to triggers tab', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    fireEvent.click(screen.getByTestId('create-pipeline-btn'));
    fireEvent.click(screen.getByText('Triggers'));
    expect(screen.getByTestId('trigger-config')).toBeDefined();
  });

  it('should switch to history tab', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    fireEvent.click(screen.getByText('History'));
    expect(screen.getByTestId('pipeline-history')).toBeDefined();
  });

  it('should call pipeline:execute mutation on run click', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    fireEvent.click(screen.getByTestId('create-pipeline-btn'));
    fireEvent.click(screen.getByTestId('run-pipeline-btn'));
    expect(mockExecuteMutate).toHaveBeenCalledTimes(1);
  });

  it('should display error from bridge hook', () => {
    mockExecuteMutationState = {
      mutate: mockExecuteMutate,
      data: null,
      loading: false,
      error: 'Pipeline validation failed',
      reset: mockExecuteReset,
    };
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);

    expect(screen.getByTestId('automation-error')).toBeDefined();
    expect(screen.getByText('Pipeline validation failed')).toBeDefined();
  });

  it('says on the canvas that most steps do nothing yet, before anyone runs a pipeline', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    const notice = screen.getByTestId('automation-steps-soon');
    expect(notice.textContent).toContain('Coming soon');
    expect(notice.textContent).toContain('Delay');
    expect(notice.textContent).toContain('Condition');
  });

  it('says on the Marketplace tab that the steps of a template do nothing yet', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    fireEvent.click(screen.getByText('Marketplace'));
    const notice = screen.getByTestId('automation-marketplace-steps-soon');
    expect(notice.textContent).toContain('Coming soon');
    expect(notice.textContent).toContain('Delay');
    expect(notice.textContent).toContain('Condition');
  });

  it('does not describe the empty state as automating seed or sync work', () => {
    useOrgStore.setState({ orgs: [] });
    render(<AutomationPage />);
    const emptyState = screen.getByTestId('empty-state');
    expect(emptyState.textContent).not.toMatch(/automated workflows|seed, sync/i);
  });

  it('should render KPI overview row', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    expect(screen.getByTestId('automation-kpi-row')).toBeDefined();
    expect(screen.getAllByTestId('kpi-card').length).toBe(3);
  });

  it('should render BentoTile content wrapper', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<AutomationPage />);
    expect(screen.getAllByTestId('bento-tile').length).toBeGreaterThanOrEqual(1);
  });
});
